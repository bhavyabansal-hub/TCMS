#!/usr/bin/env node
/**
 * Chaos run: six temporary users (vp, manager, product, developer, qa_engineer, viewer)
 * work on the app AT THE SAME TIME for CHAOS_MINUTES (default 6.5): create / edit /
 * review / delete test cases, bugs, modules, wiki docs, work logs, while the VP flips
 * permissions, changes a role and the manager deactivates a user mid-action. Planned
 * race scenarios run on top (approve vs delete, verdict vs permission revoke, double
 * submit, toggle storm …) plus malformed / hostile input.
 *
 * Every crash, 5xx, timeout, permission leak or broken data rule is written to the
 * findings file (default docs/qa/CHAOS-FINDINGS-<date>.txt). Everything the run created
 * is removed at the end (fixture users, their rows, permission overrides).
 *
 * Usage: node scripts/chaos-live-users.mjs   (app on TCMS_BASE_URL, default :3000)
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { GuardAbort, openGuardedDb, sqlIn } from './lib/db-guard.mjs'
import { cleanupFixtureRun } from './lib/fixture-cleanup.mjs'
import { createFixtureUsers, fixtureEmail } from './lib/fixture-users.mjs'
import { BASE, jarFromSetCookie } from './lib/suite-harness.mjs'

const MINUTES = Number(process.env.CHAOS_MINUTES || 6.5)
const DAY = new Date().toISOString().slice(0, 10)
const OUT = process.env.CHAOS_OUT || path.join('docs', 'qa', `CHAOS-FINDINGS-${DAY}.txt`)
const LIVE_LOG = OUT.replace(/\.txt$/, '.live.log')
const REQUEST_TIMEOUT_MS = 20_000
const SLOW_MS = Number(process.env.CHAOS_SLOW_MS || 8_000)
const SETTLE_MS = 1_500 // a permission / role / active change younger than this = "unsure"
const STALE = 'This item was changed by someone else'
const stamp = String(Date.now())
const startedAt = new Date()

const ROLES = ['vp', 'manager', 'product', 'developer', 'qa_engineer', 'viewer']
const TOGGLE_CELLS = [
  'qa_engineer:create_test_case', 'developer:create_test_case', 'product:perform_review',
  'viewer:create_bug', 'developer:create_bug', 'manager:create_module',
  'product:view_activity_logs', 'qa_engineer:create_wiki_doc',
]
// Plain gates: one permission decides the whole request (used for leak / false-403 checks).
const GATES = {
  createCase: 'create_test_case', createBug: 'create_bug', createModule: 'create_module',
  listReviews: 'perform_review', activityLogs: 'view_activity_logs', listUsers: 'manage_users',
  createWiki: 'create_wiki_doc', taskSummary: 'view_all_task_reports',
}

// ---------- findings ----------

const findings = new Map() // title -> { severity, count, first, samples[] }
const stats = new Map() // op -> { n, byStatus: {} , maxMs }
let requests = 0

function live(line) {
  try { appendFileSync(LIVE_LOG, `${new Date().toISOString()} ${line}\n`) } catch { /* log only */ }
}

function finding(severity, title, detail) {
  const f = findings.get(title) ?? { severity, count: 0, first: new Date().toISOString(), samples: [] }
  f.count++
  if (f.samples.length < 4) f.samples.push(`${new Date().toISOString()}  ${detail}`)
  findings.set(title, f)
  if (f.count === 1) {
    console.log(`FINDING [${severity}] ${title} :: ${detail}`)
    live(`FINDING [${severity}] ${title} :: ${detail}`)
  }
}

// ---------- shared state ----------

const actors = {} // role -> { role (current), key, user, jar, active, roleChangedAt, activeChangedAt }
const perm = new Map() // role:action -> enabled
const permChangedAt = new Map()
const pool = { modules: [], cases: [], bugs: [], reviews: [], moduleReviews: [], wiki: [], deleted: new Set() }
let defaults = null
let stopAt = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pick = (arr) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)
const chance = (p) => Math.random() < p
const live_ = () => Date.now() < stopAt
const alive = (list) => list.filter((x) => !pool.deleted.has(x))

/** 'yes' | 'no' | 'unsure' — may this actor pass a plain gate right now? */
function expectGate(actor, action) {
  const now = Date.now()
  const key = `${actor.role}:${action}`
  if (now - (actor.roleChangedAt || 0) < SETTLE_MS || now - (actor.activeChangedAt || 0) < SETTLE_MS) return 'unsure'
  if (now - (permChangedAt.get(key) || 0) < SETTLE_MS) return 'unsure'
  if (!actor.active) return 'unsure'
  return perm.get(key) ? 'yes' : 'no'
}

// ---------- HTTP ----------

async function api(actor, op, method, urlPath, body, { raw, gate } = {}) {
  const headers = { 'X-Requested-With': 'tcms', Origin: BASE }
  if (actor?.jar) headers.Cookie = actor.jar
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const expected = gate && actor ? expectGate(actor, gate) : null
  const wasActive = actor ? actor.active && Date.now() - (actor.activeChangedAt || 0) > SETTLE_MS : true
  const t0 = Date.now()
  let status = 0
  let json = null
  try {
    const res = await fetch(`${BASE}${urlPath}`, {
      method, headers,
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    status = res.status
    const text = await res.text()
    try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 200) } }
  } catch (err) {
    status = err.name === 'TimeoutError' ? -1 : -2
    json = { error: err.message }
  }
  const ms = Date.now() - t0
  // Judge a gate only when it was the same before and after the request: a toggle
  // landing while the request was in flight makes either answer correct.
  const expectedAtEnd = gate && actor ? expectGate(actor, gate) : null
  const verdictGate = expected === expectedAtEnd ? expected : 'unsure'
  requests++
  const s = stats.get(op) ?? { n: 0, byStatus: {}, maxMs: 0, sample: {} }
  s.n++
  s.byStatus[status] = (s.byStatus[status] || 0) + 1
  s.maxMs = Math.max(s.maxMs, ms)
  if (status >= 400 && !s.sample[status]) s.sample[status] = String(json?.error ?? json?.raw ?? '').slice(0, 120)
  stats.set(op, s)
  const who = actor ? `${actor.key}(as ${actor.role})` : 'anon'
  const where = `${method} ${urlPath.slice(0, 90)}`
  if (status >= 500) finding('HIGH', `${op}: server error ${status}`, `${who} ${where} -> ${status} ${JSON.stringify(json).slice(0, 200)}`)
  else if (status === -1) finding('HIGH', `${op}: request timed out (${REQUEST_TIMEOUT_MS / 1000}s)`, `${who} ${where}`)
  else if (status === -2) finding('HIGH', `${op}: connection failed`, `${who} ${where} ${json.error}`)
  else if (ms > SLOW_MS) finding('MEDIUM', `${op}: slow response > ${SLOW_MS / 1000}s`, `${who} ${where} ${ms} ms`)
  if (verdictGate === 'yes' && status === 403) finding('HIGH', `${op}: 403 although "${gate}" is ON for ${actor.role}`, `${who} ${where} ${json?.error ?? ''}`)
  if (verdictGate === 'no' && status >= 200 && status < 300) finding('CRITICAL', `${op}: allowed although "${gate}" is OFF for ${actor.role}`, `${who} ${where}`)
  if (actor && !actor.active && Date.now() - (actor.activeChangedAt || 0) > SETTLE_MS && status >= 200 && status < 300 && !urlPath.startsWith('/api/ready'))
    finding('CRITICAL', `${op}: deactivated user still served`, `${who} ${where} -> ${status}`)
  if (actor && wasActive && actor.active && status === 401) finding('HIGH', `${op}: active user got 401`, `${who} ${where}`)
  return { status, json, ms }
}

const idOf = (json, key) => {
  if (!json || typeof json !== 'object') return null
  if (json[key]) return String(json[key])
  for (const v of Object.values(json)) if (v && typeof v === 'object' && v[key]) return String(v[key])
  return null
}

async function login(spec) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE },
    body: JSON.stringify({ email: spec.email, password: spec.password }),
  })
  if (res.status !== 200) throw new Error(`login failed for fixture ${spec.role} (${res.status})`)
  const jar = jarFromSetCookie(res.headers.getSetCookie?.() ?? [])
  return { jar, user: (await res.json()).user }
}

// ---------- domain helpers ----------

async function createCase(actor, moduleId, extra = {}) {
  const r = await api(actor, 'create test case', 'POST', '/api/test-cases', {
    title: `Chaos case ${stamp} ${Math.floor(Math.random() * 1e6)}`, moduleId: moduleId ?? undefined,
    description: 'chaos run', steps: [{ action: 'open page', expected: 'page opens' }], priority: pick(['P1', 'P2', 'P3']), ...extra,
  }, { gate: GATES.createCase })
  const id = idOf(r.json, 'testCaseId')
  if (r.status === 200 || r.status === 201) if (id) pool.cases.push({ id, author: actor.key })
  return id
}

async function loadCase(actor, id) {
  const r = await api(actor, 'get test case', 'GET', `/api/test-cases?id=${id}`)
  return r.status === 200 ? r.json : null
}

async function editCase(actor, id, fresh = true) {
  const c = fresh ? await loadCase(actor, id) : null
  const body = { title: `Chaos edit ${stamp} ${Math.floor(Math.random() * 1e6)}`, priority: pick(['P1', 'P2', 'P3']) }
  if (c?.updatedAt) body.expectedUpdatedAt = c.updatedAt
  if (!fresh) body.expectedUpdatedAt = new Date(Date.now() - 3_600_000).toISOString()
  return api(actor, 'edit test case', 'PUT', `/api/test-cases?id=${id}`, body)
}

async function submitReview(actor, caseId, reviewer) {
  const r = await api(actor, 'submit case review', 'PUT', `/api/test-cases?id=${caseId}&action=submit-review`, { reviewerId: reviewer.user.userId })
  const id = idOf(r.json, 'reviewRequestId')
  if (id) pool.reviews.push({ id, reviewer: reviewer.key, caseId })
  return { r, id }
}

async function verdict(actor, reviewId, v = pick(['approved', 'approved', 'needs_revision', 'failed'])) {
  const d = await api(actor, 'get review', 'GET', `/api/reviews?id=${reviewId}`)
  const body = { verdict: v, comment: 'chaos verdict', flaggedFields: v === 'approved' ? [] : ['title'] }
  if (d.json?.updatedAt) body.expectedUpdatedAt = d.json.updatedAt
  return api(actor, 'review verdict', 'POST', `/api/reviews?id=${reviewId}`, body)
}

async function createBug(actor, extra = {}) {
  const linked = alive(pool.cases.map((c) => c.id)).slice(-3)
  const r = await api(actor, 'create bug', 'POST', '/api/bugs', {
    title: `Chaos bug ${stamp} ${Math.floor(Math.random() * 1e6)}`, description: 'chaos run', severity: pick(['low', 'medium', 'high', 'critical']),
    moduleId: pick(alive(pool.modules)) ?? undefined, testCaseIds: chance(0.5) ? linked : [], ...extra,
  }, { gate: GATES.createBug })
  const id = idOf(r.json, 'bugId')
  if (id && r.status < 300) pool.bugs.push(id)
  return id
}

async function updateBug(actor, bugId, body) {
  const b = await api(actor, 'get bug', 'GET', `/api/bugs?id=${bugId}`)
  return api(actor, 'update bug', 'PUT', `/api/bugs?id=${bugId}`, { ...body, ...(b.json?.updatedAt ? { expectedUpdatedAt: b.json.updatedAt } : {}) })
}

async function togglePerm(vp, cell, enabled, op = 'toggle permission') {
  const [role, action] = cell.split(':')
  permChangedAt.set(cell, Date.now()) // the server may apply it before we see the reply
  const r = await api(vp, op, 'PUT', '/api/permissions', { role, action, enabled })
  permChangedAt.set(cell, Date.now())
  if (r.status === 200) perm.set(cell, enabled)
  return r
}

async function setUser(actorBy, target, body, op) {
  const before = { role: target.role, active: target.active }
  if (body.isActive !== undefined) target.activeChangedAt = Date.now()
  if (body.role !== undefined) target.roleChangedAt = Date.now()
  const r = await api(actorBy, op, 'PUT', `/api/users?id=${target.user.userId}`, body)
  if (r.status === 200) {
    if (body.isActive !== undefined) { target.active = body.isActive; target.activeChangedAt = Date.now() }
    if (body.role !== undefined) { target.role = body.role; target.roleChangedAt = Date.now() }
  } else {
    target.role = before.role
    target.active = before.active
  }
  return r
}

// ---------- the six users ----------

async function vpLoop(me) {
  let roleSwapAt = Date.now() + 40_000
  while (live_()) {
    const x = Math.random()
    if (x < 0.22) {
      const cell = pick(TOGGLE_CELLS)
      await togglePerm(me, cell, !perm.get(cell))
    } else if (x < 0.40) {
      const parent = chance(0.5) ? pick(alive(pool.modules)) : null
      const r = await api(me, 'create module', 'POST', '/api/modules', { name: `Chaos module ${stamp} ${Math.floor(Math.random() * 1e5)}`, parentId: parent ?? undefined }, { gate: GATES.createModule })
      const id = idOf(r.json, 'moduleId')
      if (id && r.status < 300) pool.modules.push(id)
    } else if (x < 0.47 && alive(pool.modules).length > 4) {
      const id = pick(alive(pool.modules).slice(1))
      const r = await api(me, 'delete module', 'DELETE', `/api/modules?id=${id}`)
      if (r.status === 200) pool.deleted.add(id)
    } else if (x < 0.62) {
      await createCase(me, pick(alive(pool.modules)))
    } else if (x < 0.75) {
      const mine = alive(pool.reviews.filter((r) => r.reviewer === 'vp').map((r) => r.id))
      if (mine.length) await verdict(me, pick(mine))
    } else if (x < 0.85) {
      await api(me, 'list users', 'GET', '/api/users', undefined, { gate: GATES.listUsers })
      await api(me, 'read permission matrix', 'GET', '/api/permissions')
    } else {
      await api(me, 'activity logs', 'GET', '/api/activity-logs?pageSize=50', undefined, { gate: GATES.activityLogs })
    }
    if (Date.now() > roleSwapAt) {
      // Change the developer's role while they work, then give it back.
      const dev = actors.developer
      await setUser(me, dev, { role: dev.role === 'developer' ? 'qa_engineer' : 'developer' }, 'change role')
      roleSwapAt = Date.now() + (dev.role === 'developer' ? 40_000 : 15_000)
    }
    await sleep(250 + Math.random() * 600)
  }
}

async function managerLoop(me) {
  let deactivateAt = Date.now() + 30_000
  while (live_()) {
    const x = Math.random()
    const cases = alive(pool.cases.map((c) => c.id))
    if (x < 0.25 && cases.length) {
      await editCase(me, pick(cases), chance(0.8))
    } else if (x < 0.33 && cases.length > 5) {
      const id = pick(cases)
      const r = await api(me, 'delete test case', 'DELETE', `/api/test-cases?id=${id}`)
      if (r.status === 200) pool.deleted.add(id)
    } else if (x < 0.50) {
      const mine = alive(pool.reviews.filter((r) => r.reviewer === 'manager').map((r) => r.id))
      if (mine.length) {
        const id = pick(mine)
        if (chance(0.25)) {
          const d = await api(me, 'get review', 'GET', `/api/reviews?id=${id}`)
          await api(me, 'forward review', 'POST', `/api/reviews?id=${id}&action=forward`, { reviewerId: actors.product.user.userId, expectedUpdatedAt: d.json?.updatedAt })
          const rr = pool.reviews.find((r) => r.id === id)
          if (rr) rr.reviewer = 'product'
        } else await verdict(me, id)
      }
    } else if (x < 0.62 && pool.moduleReviews.length) {
      const mr = pick(pool.moduleReviews)
      const d = await api(me, 'get module review', 'GET', `/api/module-reviews?id=${mr}`)
      const a = pick(['approve-all', 'bulk-verdict', 'change-reviewer'])
      if (a === 'change-reviewer') await api(me, 'module review change reviewer', 'POST', `/api/module-reviews?id=${mr}&action=change-reviewer`, { reviewerId: pick([actors.product, actors.manager]).user.userId })
      else await api(me, `module review ${a}`, 'POST', `/api/module-reviews?id=${mr}&action=${a}`, { verdict: pick(['approved', 'needs_revision']), comment: 'chaos bulk', expectedUpdatedAt: d.json?.updatedAt })
    } else if (x < 0.75 && pool.bugs.length) {
      await updateBug(me, pick(alive(pool.bugs)) ?? pool.bugs[0], { assignedToId: pick([actors.developer, actors.qa_engineer]).user.userId, severity: pick(['low', 'high']) })
    } else if (x < 0.85 && alive(pool.modules).length) {
      const id = pick(alive(pool.modules))
      const m = await api(me, 'get module', 'GET', `/api/modules?id=${id}`)
      await api(me, 'edit module', 'PUT', `/api/modules?id=${id}`, { description: `edited ${Date.now()}`, expectedUpdatedAt: m.json?.module?.updatedAt })
    } else {
      await api(me, 'reports', 'GET', '/api/stats?action=reports')
      await api(me, 'task summary', 'GET', '/api/task-reports?action=summary', undefined, { gate: GATES.taskSummary })
    }
    if (Date.now() > deactivateAt) {
      // Deactivate the viewer in the middle of their work, bring them back later.
      const v = actors.viewer
      await setUser(me, v, { isActive: !v.active }, v.active ? 'deactivate user' : 'reactivate user')
      deactivateAt = Date.now() + (v.active ? 45_000 : 20_000)
    }
    await sleep(250 + Math.random() * 600)
  }
}

async function productLoop(me) {
  while (live_()) {
    const x = Math.random()
    const mine = alive(pool.cases.filter((c) => c.author === 'product').map((c) => c.id))
    if (x < 0.25) {
      await createCase(me, pick(alive(pool.modules)))
    } else if (x < 0.40 && mine.length) {
      await submitReview(me, pick(mine), pick([actors.manager, actors.vp]))
    } else if (x < 0.55) {
      const queue = alive(pool.reviews.filter((r) => r.reviewer === 'product').map((r) => r.id))
      if (queue.length) await verdict(me, pick(queue))
      else await api(me, 'review list', 'GET', '/api/reviews', undefined, { gate: GATES.listReviews })
    } else if (x < 0.65 && alive(pool.modules).length) {
      const mod = pick(alive(pool.modules))
      const r = await api(me, 'submit module review', 'PUT', `/api/modules?id=${mod}&action=submit-review`, { reviewerId: actors.manager.user.userId, includeSubmodules: chance(0.5) })
      const id = r.json?.moduleReview?.moduleReviewRequestId
      if (id) pool.moduleReviews.push(String(id))
    } else if (x < 0.78 && mine.length) {
      await editCase(me, pick(mine), chance(0.85))
    } else if (x < 0.88) {
      await createBug(me)
    } else {
      await api(me, 'activity logs', 'GET', '/api/activity-logs?pageSize=20', undefined, { gate: GATES.activityLogs })
    }
    await sleep(250 + Math.random() * 600)
  }
}

async function developerLoop(me) {
  while (live_()) {
    const x = Math.random()
    if (x < 0.25) {
      await createBug(me)
    } else if (x < 0.45 && pool.bugs.length) {
      await updateBug(me, pick(pool.bugs), { status: pick(['in_progress', 'resolved', 'open', 'closed', 'wont_fix']) })
    } else if (x < 0.55 && pool.bugs.length && pool.cases.length) {
      await api(me, 'link bug to case', 'PUT', `/api/bugs?id=${pick(pool.bugs)}&action=link-tc`, { testCaseId: pick(pool.cases).id })
    } else if (x < 0.65) {
      await createCase(me, pick(alive(pool.modules))) // normally 403 unless VP granted it
    } else if (x < 0.78) {
      const date = new Date(Date.now() - Math.floor(Math.random() * 3) * 86_400_000).toISOString().slice(0, 10)
      await api(me, 'task report upsert', 'POST', '/api/task-reports', {
        reportDate: date, notes: 'chaos', tasks: [{ description: 'chaos work', timeSpentMinutes: 30, status: 'done', bugId: pick(pool.bugs) ?? undefined }],
      })
    } else if (x < 0.9) {
      await api(me, 'search', 'GET', `/api/search?q=${encodeURIComponent(pick(['Chaos', '%', "' OR 1=1 --", '<script>', '_', '\\', 'ü日本'.repeat(3)]))}`)
    } else {
      await api(me, 'my notifications', 'GET', '/api/notifications')
      await api(me, 'read all notifications', 'POST', '/api/notifications?action=read-all', {})
    }
    await sleep(250 + Math.random() * 600)
  }
}

async function qaLoop(me) {
  let attack = 0
  while (live_()) {
    const x = Math.random()
    const mine = alive(pool.cases.filter((c) => c.author === 'qa_engineer').map((c) => c.id))
    if (x < 0.25) {
      await createCase(me, pick(alive(pool.modules)))
    } else if (x < 0.37 && mine.length) {
      await editCase(me, pick(mine), chance(0.8))
    } else if (x < 0.47 && mine.length) {
      await submitReview(me, pick(mine), pick([actors.product, actors.manager]))
    } else if (x < 0.53 && mine.length > 3) {
      const id = pick(mine)
      const r = await api(me, 'delete own test case', 'DELETE', `/api/test-cases?id=${id}`)
      if (r.status === 200) pool.deleted.add(id)
    } else if (x < 0.62) {
      await createBug(me)
    } else if (x < 0.72) {
      if (pool.wiki.length && chance(0.5)) {
        await api(me, 'edit wiki doc', 'PUT', `/api/wiki?id=${pick(pool.wiki)}`, { content: `<p>edit ${Date.now()}</p><img src=x onerror=alert(1)>` })
      } else {
        const r = await api(me, 'create wiki doc', 'POST', '/api/wiki', { title: `Chaos wiki ${stamp} ${Math.floor(Math.random() * 1e5)}`, content: '<p>hi</p><script>alert(1)</script>', tags: ['chaos'] }, { gate: GATES.createWiki })
        const id = idOf(r.json, 'wikiDocumentId') ?? idOf(r.json, 'documentId') ?? idOf(r.json, 'id')
        if (id && r.status < 300) {
          pool.wiki.push(id)
          const back = await api(me, 'get wiki doc', 'GET', `/api/wiki?id=${id}`)
          if (/<script/i.test(JSON.stringify(back.json ?? ''))) finding('HIGH', 'wiki: <script> stored and served back', `doc ${id}`)
        }
      }
    } else {
      await hostileInput(me, attack++)
    }
    await sleep(250 + Math.random() * 600)
  }
}

/** One malformed / hostile request per call (rotating). Any 5xx is a finding. */
async function hostileInput(me, i) {
  const deadModule = [...pool.deleted].find((id) => pool.modules.includes(id))
  const deadCase = [...pool.deleted].find((id) => pool.cases.some((c) => c.id === id))
  const list = [
    () => api(me, 'hostile: 10k title', 'POST', '/api/test-cases', { title: 'A'.repeat(10_000) }),
    () => api(me, 'hostile: steps not array', 'POST', '/api/test-cases', { title: 'x', steps: 'one' }),
    () => api(me, 'hostile: priority P9', 'POST', '/api/test-cases', { title: 'x', priority: 'P9' }),
    () => api(me, 'hostile: huge module id', 'POST', '/api/test-cases', { title: 'x', moduleId: '99999999999999999999' }),
    () => api(me, 'hostile: negative module id', 'POST', '/api/test-cases', { title: 'x', moduleId: '-1' }),
    () => api(me, 'hostile: case into deleted module', 'POST', '/api/test-cases', { title: `Chaos dead-module ${stamp}`, moduleId: deadModule ?? '4294967295' }),
    () => api(me, 'hostile: id=abc', 'PUT', '/api/test-cases?id=abc', { title: 'x' }),
    () => api(me, 'hostile: id=0', 'GET', '/api/test-cases?id=0'),
    () => api(me, 'hostile: id=1e3', 'GET', '/api/bugs?id=1e3'),
    () => api(me, 'hostile: broken JSON', 'POST', '/api/bugs', undefined, { raw: '{"title": "x",' }),
    () => api(me, 'hostile: 3 MB body', 'POST', '/api/wiki', undefined, { raw: JSON.stringify({ title: 'big', content: 'x'.repeat(3_000_000) }) }),
    () => api(me, 'hostile: 600 linked ids', 'POST', '/api/bugs', { title: 'x', testCaseIds: Array.from({ length: 600 }, (_, k) => String(k + 1)) }),
    () => api(me, 'hostile: page=-1 size=100000', 'GET', '/api/test-cases?page=-1&pageSize=100000'),
    () => api(me, 'hostile: 5000-char search', 'GET', `/api/search?q=${'a'.repeat(5000)}`),
    () => api(me, 'hostile: edit deleted case', 'PUT', `/api/test-cases?id=${deadCase ?? '4294967295'}`, { title: 'ghost' }),
    () => api(me, 'hostile: history of deleted case', 'GET', `/api/test-cases?id=${deadCase ?? '4294967295'}&action=history`),
    () => api(me, 'hostile: review self as reviewer of deleted case', 'PUT', `/api/test-cases?id=${deadCase ?? '4294967295'}&action=submit-review`, { reviewerId: me.user.userId }),
    () => api(me, 'hostile: task minutes 99999', 'POST', '/api/task-reports', { reportDate: DAY, tasks: [{ description: 'x', timeSpentMinutes: 99999, status: 'done' }] }),
    () => api(me, 'hostile: reportDate garbage', 'POST', '/api/task-reports', { reportDate: '31/31/2026', tasks: [] }),
    () => api(me, 'hostile: permission self-grant', 'PUT', '/api/permissions', { role: 'qa_engineer', action: 'manage_permissions', enabled: true }),
    () => api(me, 'hostile: make self vp', 'PUT', `/api/users?id=${me.user.userId}`, { role: 'vp' }),
    () => api(me, 'hostile: null body verdict', 'POST', `/api/reviews?id=${pick(pool.reviews)?.id ?? '1'}`, null),
    () => api(me, 'hostile: unicode/emoji title', 'POST', '/api/test-cases', { title: `Chaos 🧪 ${'𝔘'.repeat(50)} ${stamp}`, moduleId: pick(alive(pool.modules)) ?? undefined }),
  ]
  const r = await list[i % list.length]()
  // A hostile request that should never succeed:
  if (/self-grant|make self vp/.test(list[i % list.length].toString()) && r.status < 300) finding('CRITICAL', 'qa escalated own rights', JSON.stringify(r.json).slice(0, 150))
  const id = idOf(r.json, 'testCaseId')
  if (id && r.status < 300) pool.cases.push({ id, author: 'qa_engineer' })
}

async function viewerLoop(me) {
  while (live_()) {
    const x = Math.random()
    if (x < 0.35) {
      await api(me, 'list test cases', 'GET', `/api/test-cases?page=1&pageSize=20&search=Chaos`)
      await api(me, 'list bugs', 'GET', '/api/bugs?pageSize=50')
      await api(me, 'modules tree', 'GET', '/api/modules')
    } else if (x < 0.55 && pool.cases.length) {
      // Opens cases that others may have deleted a moment ago: 200 or 404, never 5xx.
      const c = pick(pool.cases)
      await api(me, 'open test case', 'GET', `/api/test-cases?id=${c.id}`)
      await api(me, 'case history', 'GET', `/api/test-cases?id=${c.id}&action=history`)
      await api(me, 'case reviews', 'GET', `/api/test-cases?id=${c.id}&action=reviews`)
    } else if (x < 0.65) {
      await api(me, 'dashboard', 'GET', '/api/stats?action=dashboard')
      await api(me, 'search', 'GET', '/api/search?q=Chaos')
    } else if (x < 0.80) {
      // Forbidden by default — must stay 403 unless the VP granted it.
      await createCase(me, null)
      await createBug(me)
      await api(me, 'activity logs', 'GET', '/api/activity-logs', undefined, { gate: GATES.activityLogs })
    } else if (x < 0.88) {
      await api(me, 'read permission matrix', 'GET', '/api/permissions')
      await api(me, 'list users', 'GET', '/api/users', undefined, { gate: GATES.listUsers })
      const del = await api(me, 'viewer deletes a case', 'DELETE', `/api/test-cases?id=${pick(pool.cases)?.id ?? '1'}`)
      if (del.status < 300) finding('CRITICAL', 'viewer deleted a test case', JSON.stringify(del.json).slice(0, 100))
    } else {
      await api(me, 'my notifications', 'GET', '/api/notifications')
      await api(me, 'who am i', 'GET', '/api/auth')
    }
    await sleep(300 + Math.random() * 700)
  }
}

// ---------- planned races (run by a coordinator on top of the six loops) ----------

const SCENARIOS = [
  ['approve while the author deletes the case', async () => {
    const id = await createCase(actors.qa_engineer, pick(alive(pool.modules)))
    if (!id) return 'no case'
    const { id: rid } = await submitReview(actors.qa_engineer, id, actors.manager)
    if (!rid) return 'no review'
    const [v, d] = await Promise.all([verdict(actors.manager, rid, 'approved'), api(actors.qa_engineer, 'race: delete case under review', 'DELETE', `/api/test-cases?id=${id}`)])
    if (d.status === 200) pool.deleted.add(id)
    return `verdict ${v.status}, delete ${d.status}`
  }],
  ['verdict while the VP revokes perform_review', async () => {
    const id = await createCase(actors.qa_engineer, pick(alive(pool.modules)))
    if (!id) return 'no case'
    const { id: rid } = await submitReview(actors.qa_engineer, id, actors.product)
    if (!rid) return 'no review'
    const [v, t] = await Promise.all([verdict(actors.product, rid, 'approved'), togglePerm(actors.vp, 'product:perform_review', false, 'race: revoke perform_review')])
    await togglePerm(actors.vp, 'product:perform_review', true, 'race: restore perform_review')
    return `verdict ${v.status}, revoke ${t.status}`
  }],
  ['two verdicts + a forward on one review at once', async () => {
    const id = await createCase(actors.product, pick(alive(pool.modules)))
    if (!id) return 'no case'
    const { id: rid } = await submitReview(actors.product, id, actors.manager)
    if (!rid) return 'no review'
    const d = await api(actors.manager, 'get review', 'GET', `/api/reviews?id=${rid}`)
    const t = d.json?.updatedAt
    const rs = await Promise.all([
      api(actors.manager, 'race: verdict A', 'POST', `/api/reviews?id=${rid}`, { verdict: 'approved', expectedUpdatedAt: t }),
      api(actors.manager, 'race: verdict B', 'POST', `/api/reviews?id=${rid}`, { verdict: 'failed', comment: 'x', expectedUpdatedAt: t }),
      api(actors.manager, 'race: forward', 'POST', `/api/reviews?id=${rid}&action=forward`, { reviewerId: actors.vp.user.userId, expectedUpdatedAt: t }),
    ])
    const wins = rs.filter((r) => r.status === 200).length
    if (wins !== 1) finding('HIGH', 'review race: not exactly one winner', `review ${rid}: ${rs.map((r) => r.status).join(',')}`)
    return rs.map((r) => r.status).join(',')
  }],
  ['double submit-review of one case', async () => {
    const id = await createCase(actors.qa_engineer, pick(alive(pool.modules)))
    if (!id) return 'no case'
    const rs = await Promise.all([1, 2, 3].map(() => api(actors.qa_engineer, 'race: double submit', 'PUT', `/api/test-cases?id=${id}&action=submit-review`, { reviewerId: actors.manager.user.userId })))
    for (const r of rs) { const rid = idOf(r.json, 'reviewRequestId'); if (rid) pool.reviews.push({ id: rid, reviewer: 'manager', caseId: id }) }
    const ok = rs.filter((r) => r.status === 200).length
    if (ok > 1) finding('HIGH', 'same case sent for review twice at once -> several open reviews', `case ${id}: ${rs.map((r) => r.status).join(',')}`)
    return rs.map((r) => r.status).join(',')
  }],
  ['edit while someone deletes the case', async () => {
    const id = await createCase(actors.qa_engineer, pick(alive(pool.modules)))
    if (!id) return 'no case'
    const [e, d] = await Promise.all([editCase(actors.qa_engineer, id, true), api(actors.manager, 'race: delete during edit', 'DELETE', `/api/test-cases?id=${id}`)])
    if (d.status === 200) pool.deleted.add(id)
    const after = await api(actors.vp, 'get test case', 'GET', `/api/test-cases?id=${id}`)
    if (d.status === 200 && after.status === 200) finding('HIGH', 'deleted case came back after a parallel edit', `case ${id}`)
    return `edit ${e.status}, delete ${d.status}, after ${after.status}`
  }],
  ['link bug to a case being deleted', async () => {
    const id = await createCase(actors.qa_engineer, pick(alive(pool.modules)))
    const bug = await createBug(actors.developer)
    if (!id || !bug) return 'no fixtures'
    const [l, d] = await Promise.all([
      api(actors.developer, 'race: link while delete', 'PUT', `/api/bugs?id=${bug}&action=link-tc`, { testCaseId: id }),
      api(actors.qa_engineer, 'race: delete while link', 'DELETE', `/api/test-cases?id=${id}`),
    ])
    if (d.status === 200) pool.deleted.add(id)
    return `link ${l.status}, delete ${d.status}`
  }],
  ['module review while the VP deletes the module', async () => {
    const r = await api(actors.vp, 'create module', 'POST', '/api/modules', { name: `Chaos doomed ${stamp} ${Date.now()}` })
    const mod = idOf(r.json, 'moduleId')
    if (!mod) return 'no module'
    pool.modules.push(mod)
    await createCase(actors.product, mod)
    await createCase(actors.qa_engineer, mod)
    const [s, d, c] = await Promise.all([
      api(actors.product, 'race: module review submit', 'PUT', `/api/modules?id=${mod}&action=submit-review`, { reviewerId: actors.manager.user.userId }),
      api(actors.vp, 'race: delete module', 'DELETE', `/api/modules?id=${mod}`),
      createCase(actors.qa_engineer, mod),
    ])
    if (d.status === 200) pool.deleted.add(mod)
    const mr = s.json?.moduleReview?.moduleReviewRequestId
    if (mr) pool.moduleReviews.push(String(mr))
    return `submit ${s.status}, delete ${d.status}, new case ${c ? 'created' : 'none'}`
  }],
  ['reviewer deactivated while approving', async () => {
    const id = await createCase(actors.qa_engineer, pick(alive(pool.modules)))
    if (!id) return 'no case'
    const { id: rid } = await submitReview(actors.qa_engineer, id, actors.product)
    if (!rid) return 'no review'
    const [v, d] = await Promise.all([verdict(actors.product, rid, 'approved'), setUser(actors.manager, actors.product, { isActive: false }, 'race: deactivate reviewer')])
    const after = await api(actors.product, 'race: deactivated reviewer acts again', 'GET', '/api/reviews?action=queue')
    if (d.status === 200 && after.status === 200) finding('CRITICAL', 'deactivated reviewer still served after deactivation', `status ${after.status}`)
    await setUser(actors.manager, actors.product, { isActive: true }, 'race: reactivate reviewer')
    return `verdict ${v.status}, deactivate ${d.status}, next request ${after.status}`
  }],
  ['manager demoted to viewer while deleting', async () => {
    const id = await createCase(actors.qa_engineer, pick(alive(pool.modules)))
    if (!id) return 'no case'
    const [del, role] = await Promise.all([
      api(actors.manager, 'race: delete while demoted', 'DELETE', `/api/test-cases?id=${id}`),
      setUser(actors.vp, actors.manager, { role: 'viewer' }, 'race: demote manager'),
    ])
    if (del.status === 200) pool.deleted.add(id)
    const after = await api(actors.manager, 'race: demoted manager deletes again', 'DELETE', `/api/test-cases?id=${alive(pool.cases.map((c) => c.id)).at(-1) ?? '1'}`)
    if (role.status === 200 && after.status === 200) finding('CRITICAL', 'demoted manager could still delete', `case delete ${after.status}`)
    await setUser(actors.vp, actors.manager, { role: 'manager' }, 'race: restore manager')
    return `delete ${del.status}, demote ${role.status}, next delete ${after.status}`
  }],
  ['5 parallel work-log saves for one day', async () => {
    const date = '2026-01-15'
    const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => api(actors.developer, 'race: task report same day', 'POST', '/api/task-reports', { reportDate: date, tasks: [{ description: `t${n}`, timeSpentMinutes: n * 10, status: 'done' }] })))
    const my = await api(actors.developer, 'my task reports', 'GET', '/api/task-reports?action=my')
    const rows = Array.isArray(my.json) ? my.json.filter((r) => String(r.reportDate).startsWith(date)).length : -1
    if (rows > 1) finding('HIGH', 'parallel work-log saves made duplicate rows for one day', `rows=${rows}`)
    return `${rs.map((r) => r.status).join(',')} rows=${rows}`
  }],
  ['permission toggle storm while QA creates cases', async () => {
    const cell = 'viewer:create_bug'
    const storm = Array.from({ length: 12 }, (_, k) => togglePerm(actors.vp, cell, k % 2 === 0, 'race: toggle storm'))
    const creates = [1, 2, 3, 4].map(() => createCase(actors.qa_engineer, pick(alive(pool.modules))))
    await Promise.all([...storm, ...creates])
    await sleep(300)
    const m = await api(actors.vp, 'read permission matrix', 'GET', '/api/permissions')
    const cellRow = Array.isArray(m.json) ? m.json.find((c) => `${c.role}:${c.action}` === cell) : null
    await togglePerm(actors.vp, cell, false, 'race: storm reset')
    return `matrix after storm: enabled=${cellRow?.enabled}`
  }],
  ['approve-all twice at once on one module review', async () => {
    const r = await api(actors.vp, 'create module', 'POST', '/api/modules', { name: `Chaos bulk ${stamp} ${Date.now()}` })
    const mod = idOf(r.json, 'moduleId')
    if (!mod) return 'no module'
    pool.modules.push(mod)
    await createCase(actors.product, mod)
    await createCase(actors.product, mod)
    const s = await api(actors.product, 'submit module review', 'PUT', `/api/modules?id=${mod}&action=submit-review`, { reviewerId: actors.manager.user.userId })
    const mr = s.json?.moduleReview?.moduleReviewRequestId
    if (!mr) return `submit ${s.status}`
    pool.moduleReviews.push(String(mr))
    const d = await api(actors.manager, 'get module review', 'GET', `/api/module-reviews?id=${mr}`)
    const rs = await Promise.all([1, 2].map(() => api(actors.manager, 'race: approve-all twice', 'POST', `/api/module-reviews?id=${mr}&action=approve-all`, { expectedUpdatedAt: d.json?.updatedAt })))
    if (rs.filter((x) => x.status === 200).length !== 1) finding('HIGH', 'approve-all race: not exactly one winner', rs.map((x) => x.status).join(','))
    return rs.map((x) => x.status).join(',')
  }],
]

async function coordinator() {
  let i = 0
  await sleep(8_000)
  while (live_()) {
    const [name, fn] = SCENARIOS[i % SCENARIOS.length]
    try {
      const result = await fn()
      live(`SCENARIO ${name}: ${result}`)
      scenarioLog.push(`${name}: ${result}`)
    } catch (err) {
      finding('HIGH', `scenario crashed: ${name}`, err.message)
    }
    i++
    await sleep(4_000 + Math.random() * 3_000)
  }
}
const scenarioLog = []

async function healthLoop() {
  let down = 0
  while (live_()) {
    const r = await api(null, 'health /api/ready', 'GET', '/api/ready')
    if (r.status !== 200) { down++; finding('CRITICAL', 'server not ready', `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`) }
    await sleep(5_000)
  }
  return down
}

// ---------- end-of-run data checks (DB) ----------

async function dataChecks(db, ids) {
  const out = []
  const n = async (q) => Number((await q)[0]?.n ?? 0)
  const multiOpen = await db.$queryRaw`SELECT test_case_id, COUNT(*) AS n FROM review_requests
    WHERE status IN ('pending','in_progress') AND ${sqlIn('requester_id', ids)} GROUP BY test_case_id HAVING COUNT(*) > 1`
  if (multiOpen.length) finding('HIGH', 'data: a test case has more than one open review', multiOpen.slice(0, 5).map((r) => `case ${r.test_case_id} x${r.n}`).join(', '))
  out.push(`cases with >1 open review: ${multiOpen.length}`)
  const inReviewNoOpen = await n(db.$queryRaw`SELECT COUNT(*) AS n FROM test_cases t WHERE t.status = 'in_review' AND ${sqlIn('t.author_id', ids)}
    AND NOT EXISTS (SELECT 1 FROM review_requests r WHERE r.test_case_id = t.test_case_id AND r.status IN ('pending','in_progress'))`)
  if (inReviewNoOpen) finding('MEDIUM', 'data: case stuck "in_review" with no open review', `${inReviewNoOpen} case(s)`)
  out.push(`cases "in_review" without an open review: ${inReviewNoOpen}`)
  const openNoReview = await n(db.$queryRaw`SELECT COUNT(*) AS n FROM review_requests r JOIN test_cases t ON t.test_case_id = r.test_case_id
    WHERE r.status IN ('pending','in_progress') AND t.status <> 'in_review'
      AND NOT (r.status = 'in_progress' AND t.status = 'needs_revision') AND ${sqlIn('t.author_id', ids)}`)
  if (openNoReview) finding('MEDIUM', 'data: open review on a case that is not "in_review"', `${openNoReview} review(s)`)
  out.push(`open reviews on cases not "in_review": ${openNoReview}`)
  const mrDone = await n(db.$queryRaw`SELECT COUNT(*) AS n FROM module_review_requests m WHERE m.status IN ('pending','in_progress') AND ${sqlIn('m.requester_id', ids)}
    AND NOT EXISTS (SELECT 1 FROM review_requests r WHERE r.module_review_id = m.module_review_request_id AND r.status IN ('pending','in_progress'))`)
  if (mrDone) finding('MEDIUM', 'data: module review still open but no open case review inside', `${mrDone} module review(s)`)
  out.push(`open module reviews with nothing left to review: ${mrDone}`)
  const openToInactive = await n(db.$queryRaw`SELECT COUNT(*) AS n FROM review_requests r JOIN users u ON u.user_id = r.reviewer_id
    WHERE r.status IN ('pending','in_progress') AND u.is_active = 0 AND ${sqlIn('r.requester_id', ids)}`)
  out.push(`open reviews assigned to an inactive user (end of run): ${openToInactive}`)
  const dupReports = await db.$queryRaw`SELECT reported_by_id, report_date, COUNT(*) AS n FROM task_reports WHERE ${sqlIn('reported_by_id', ids)} GROUP BY reported_by_id, report_date HAVING COUNT(*) > 1`
  if (dupReports.length) finding('HIGH', 'data: duplicate work-log rows for one day', JSON.stringify(dupReports.slice(0, 3)))
  out.push(`duplicate work-log days: ${dupReports.length}`)
  const versionGaps = await n(db.$queryRaw`SELECT COUNT(*) AS n FROM (SELECT h.test_case_id, COUNT(*) c, COUNT(DISTINCT h.version) d FROM test_case_history h
    JOIN test_cases t ON t.test_case_id = h.test_case_id WHERE ${sqlIn('t.author_id', ids)} GROUP BY h.test_case_id HAVING c <> d) x`)
  if (versionGaps) finding('HIGH', 'data: duplicate version numbers in test case history (lost update)', `${versionGaps} case(s)`)
  out.push(`cases with duplicate history versions: ${versionGaps}`)
  return out
}

// ---------- report file ----------

function writeReport(extra) {
  const sev = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
  const rows = [...findings.entries()].sort((a, b) => sev[a[1].severity] - sev[b[1].severity] || b[1].count - a[1].count)
  const L = []
  L.push(`TCMS CHAOS TEST — 6 live users in parallel`)
  L.push(`Date: ${startedAt.toISOString()}  ->  ${new Date().toISOString()}`)
  L.push(`Server: ${BASE}   Duration: ${MINUTES} min   Requests: ${requests}   Stamp: ${stamp}`)
  L.push(`Users: vp, manager, product, developer, qa_engineer, viewer (temporary, removed after the run)`)
  L.push('')
  L.push(`RESULT: ${rows.length === 0 ? 'NOTHING BROKE' : `${rows.length} distinct problem(s) found`}`)
  L.push('')
  L.push('=== FINDINGS (where the app broke / a test failed) ===')
  if (!rows.length) L.push('none')
  rows.forEach(([title, f], i) => {
    L.push('')
    L.push(`${i + 1}. [${f.severity}] ${title}   (seen ${f.count}x, first ${f.first})`)
    for (const s of f.samples) L.push(`     - ${s}`)
  })
  L.push('')
  L.push('=== PLANNED RACE SCENARIOS (what happened) ===')
  for (const s of scenarioLog) L.push(`- ${s}`)
  L.push('')
  L.push('=== END-OF-RUN DATA CHECKS ===')
  for (const s of extra.dataChecks ?? []) L.push(`- ${s}`)
  L.push('')
  L.push('=== REQUESTS BY ACTION (status counts, slowest, first error text) ===')
  for (const [op, s] of [...stats.entries()].sort()) {
    const codes = Object.entries(s.byStatus).map(([k, v]) => `${k}x${v}`).join(' ')
    const errs = Object.entries(s.sample).map(([k, v]) => `${k}: ${v}`).join(' | ')
    L.push(`- ${op}: n=${s.n} [${codes}] max ${s.maxMs} ms${errs ? `  — ${errs}` : ''}`)
  }
  L.push('')
  L.push('=== CLEANUP ===')
  L.push(JSON.stringify(extra.cleanup ?? {}, null, 0))
  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, L.join('\n') + '\n')
}

// ---------- main ----------

async function main() {
  let guard
  try {
    guard = await openGuardedDb()
  } catch (err) {
    console.log(`NOT RUN: ${err instanceof GuardAbort ? err.message : err.message}`)
    process.exitCode = 2
    return
  }
  const { db } = guard
  let fixtures = []
  const extra = {}
  try {
    const pre = Number((await db.$queryRaw`SELECT COUNT(*) AS n FROM role_permissions`)[0].n)
    if (pre !== 0) {
      console.log(`NOT RUN: role_permissions has ${pre} override row(s) — the run restores to 0 and must not overwrite them`)
      process.exitCode = 2
      return
    }
    mkdirSync(path.dirname(OUT), { recursive: true })
    writeFileSync(LIVE_LOG, `chaos run ${stamp} on ${BASE}\n`)
    fixtures = await createFixtureUsers(db, ROLES.map((role) => ({ key: role, role, email: fixtureEmail('chaos', role, stamp), name: `Chaos ${role}` })))
    for (const f of fixtures) {
      const s = await login(f)
      actors[f.role] = { key: f.role, role: f.role, user: s.user, jar: s.jar, active: true }
    }
    const matrix = await api(actors.vp, 'read permission matrix', 'GET', '/api/permissions')
    defaults = matrix.json
    for (const c of matrix.json) perm.set(`${c.role}:${c.action}`, !!c.enabled)
    console.log(`six users signed in; running ${MINUTES} min against ${BASE} …  findings -> ${OUT}`)

    // A few modules + cases so everybody has something to work on from second one.
    for (let k = 0; k < 4; k++) {
      const r = await api(actors.vp, 'create module', 'POST', '/api/modules', { name: `Chaos module ${stamp} seed${k}` })
      const id = idOf(r.json, 'moduleId')
      if (id) pool.modules.push(id)
    }
    for (let k = 0; k < 4; k++) await createCase(actors.qa_engineer, pool.modules[k % pool.modules.length])

    stopAt = Date.now() + MINUTES * 60_000
    const progress = setInterval(() => console.log(`… ${Math.round((stopAt - Date.now()) / 1000)} s left, ${requests} requests, ${findings.size} finding(s)`), 30_000)
    await Promise.all([
      vpLoop(actors.vp), managerLoop(actors.manager), productLoop(actors.product),
      developerLoop(actors.developer), qaLoop(actors.qa_engineer), viewerLoop(actors.viewer),
      coordinator(), healthLoop(),
    ])
    clearInterval(progress)

    // Put people and permissions back through the API (then the DB cleanup removes the rows).
    for (const role of ['manager', 'developer']) if (actors[role].role !== role) await setUser(actors.vp, actors[role], { role }, 'restore role')
    for (const role of ['viewer', 'product']) if (!actors[role].active) await setUser(actors.vp, actors[role], { isActive: true }, 'restore active')
    for (const cell of TOGGLE_CELLS) {
      const def = defaults.find((c) => `${c.role}:${c.action}` === cell)
      if (def && perm.get(cell) !== !!def.enabled) await togglePerm(actors.vp, cell, !!def.enabled, 'restore permission')
    }
    await sleep(500)
    extra.dataChecks = await dataChecks(db, fixtures.map((f) => String(f.userId)))
  } catch (err) {
    finding('HIGH', 'chaos run aborted', err.stack?.split('\n').slice(0, 3).join(' | ') ?? err.message)
  } finally {
    stopAt = 0
    try {
      if (fixtures.length) extra.cleanup = await cleanupFixtureRun(db, fixtures, { prefix: 'chaos', stamp })
    } catch (err) {
      extra.cleanup = { error: err.message }
      console.log(`CLEANUP FAILED: ${err.message} — stamp ${stamp}`)
    }
    writeReport(extra)
    await guard.release()
    console.log(`\nDONE: ${requests} requests, ${findings.size} distinct finding(s). Report: ${OUT}`)
    console.log(`cleanup: ${JSON.stringify(extra.cleanup)}`)
  }
}

main()
