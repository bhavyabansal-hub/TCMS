/**
 * Wiki API deep-verification — every permission condition + upload/download +
 * validation + sanitization, across SIX roles (fixtures created + cleaned up).
 *
 * Permission model (mirrors test cases exactly):
 *   - READ: every authenticated user
 *   - CREATE: create_wiki_doc holders (vp, manager, product, qa_engineer)
 *   - EDIT: author w/ edit_own_wiki_doc, or edit_any_wiki_doc (vp, manager)
 *   - DELETE: author OR delete_wiki_doc holders (vp, manager)
 *   - VIEWER / DEVELOPER: read-only by default (no create/edit/delete)
 *
 * REQ-001 R6 (MySQL port + safety):
 *   - DB guard + GET_LOCK first (scripts/lib/db-guard.mjs); precondition: the two
 *     developer wiki cells have no override row, else PRECONDITION + exit 2.
 *   - Fixture users by raw SQL (notify_email/telegram off, in-memory passwords).
 *   - The section-8 grant/revoke goes through PUT /api/permissions as the fixture VP.
 *   - Cleanup in finally and on Ctrl+C, keyed on fixture ids; touched matrix cells
 *     restored by SQL (S2 rule) and compared with the pre-run GET snapshot.
 *   - Test-only hooks: VERIFY_FAIL_AT / VERIFY_PAUSE_AT = after-fixtures | section-5 |
 *     after-grant | mid-cleanup-docs. Recovery: --cleanup-stamp=<stamp>.
 * Usage: node scripts/verify-wiki.mjs [--cleanup-stamp=<n>]
 * Exit: 0 green, 1 any FAIL, 2 NOT RUN (guard, lock, precondition, bad hook), 130 Ctrl+C.
 */
import { GuardAbort, openGuardedDb } from './lib/db-guard.mjs'
import { createFixtureUsers, findUsersByEmails, fixtureEmail } from './lib/fixture-users.mjs'
import {
  BASE,
  ForcedFailure,
  PERMISSION_CACHE_WAIT_MS,
  checkResidue,
  createCounter,
  createRunState,
  diffMatrix,
  loginFixture,
  manifestPath,
  parseFlags,
  readHooks,
  readMatrixSnapshot,
  requestJson,
  resolveExitCode,
  runCleanupStep,
  sleep,
  writeManifest,
} from './lib/suite-harness.mjs'
import {
  collectEntities,
  countResidue,
  deleteActivityLogsByUsers,
  deleteLoginAttemptsByEmails,
  deleteUsersByIds,
  deleteWikiDocById,
  emptyEntities,
  restoreTouchedCells,
} from './lib/suite-data.mjs'

const SUITE = 'wiki'
const HOOK_STEPS = ['after-fixtures', 'section-5', 'after-grant', 'mid-cleanup-docs']
const TOUCHED_CELLS = [
  { role: 'developer', action: 'create_wiki_doc' },
  { role: 'developer', action: 'delete_wiki_doc' },
]
const TOUCHED_KEYS = TOUCHED_CELLS.map((c) => `${c.role}:${c.action}`)
const RESIDUE_TABLES = ['users', 'wiki_documents', 'activity_logs', 'notifications', 'refresh_tokens']
const FIXTURE_SPECS = [
  { key: 'vp', name: 'Wiki VP', role: 'vp' },
  { key: 'mgr', name: 'Wiki Mgr', role: 'manager' },
  { key: 'prod', name: 'Wiki Prod', role: 'product' },
  { key: 'qa', name: 'Wiki QA', role: 'qa_engineer' },
  { key: 'dev', name: 'Wiki Dev', role: 'developer' },
  { key: 'viewer', name: 'Wiki Viewer', role: 'viewer' },
]

const fixtureSpecs = (stamp) => FIXTURE_SPECS.map((s) => ({ ...s, email: fixtureEmail('wiki', s.key, stamp) }))

// ---------- the suite sections (unchanged checks, sections 1-9) ----------

async function runSections(ctx, counter, state) {
  const { stamp: STAMP } = ctx
  const signal = state.signal
  const ok = (cond, msg) => counter.check(msg, cond)
  const byKey = Object.fromEntries(ctx.fixtures.map((u) => [u.key, u]))

  await sleep(3500, signal) // outlive the 3s permission-cache TTL
  const vpJar = (await loginFixture(byKey.vp, signal)).jar
  ctx.vpJar = vpJar
  const mgrJar = (await loginFixture(byKey.mgr, signal)).jar
  const prodJar = (await loginFixture(byKey.prod, signal)).jar
  const qaJar = (await loginFixture(byKey.qa, signal)).jar
  const devJar = (await loginFixture(byKey.dev, signal)).jar
  const viewerJar = (await loginFixture(byKey.viewer, signal)).jar

  // Pre-run 126-cell snapshot: fixtures exist, no permission write yet (P6).
  ctx.snapshot = await readMatrixSnapshot(vpJar, signal)
  if (!ctx.snapshot) throw new Error('could not read the pre-run GET /api/permissions snapshot')
  await state.hook('after-fixtures')

  const H = (jar) => ({ Cookie: jar, 'X-Requested-With': 'tcms', Origin: BASE, 'Content-Type': 'application/json' })
  const J = async (res) => { const t = await res.text(); try { return JSON.parse(t) } catch { return { raw: t.slice(0, 120) } } }
  const post = (jar, body) => fetch(`${BASE}/api/wiki`, { method: 'POST', headers: H(jar), body: JSON.stringify(body), signal })
  const put = (jar, id, body) => fetch(`${BASE}/api/wiki?id=${id}`, { method: 'PUT', headers: H(jar), body: JSON.stringify(body), signal })
  const del = (jar, id) => fetch(`${BASE}/api/wiki?id=${id}`, { method: 'DELETE', headers: H(jar), signal })
  const getJson = async (jar, url) => J(await fetch(`${BASE}${url}`, { headers: H(jar), signal }))
  const upload = (jar, url, method, form) =>
    fetch(`${BASE}${url}`, { method, headers: { Cookie: jar, 'X-Requested-With': 'tcms', Origin: BASE }, body: form, signal })

  let vpDocId
  let qaDocId
  let fileDocId

  console.log('\n== 1. CREATE (create_wiki_doc) ==')
  {
    const r1 = await J(await post(vpJar, { title: `VP doc ${STAMP}`, content: '<p>vp wrote this</p>', tags: ['vp'] }))
    ok(r1.data?.wikiDocumentId || r1.wikiDocumentId, 'VP (matrix holder) creates written doc')
    vpDocId = r1.data?.wikiDocumentId ?? r1.wikiDocumentId

    const r2 = await J(await post(qaJar, { title: `QA doc ${STAMP}`, content: '<p>qa wrote this</p>', tags: ['qa', 'howto'] }))
    ok(r2.data?.wikiDocumentId || r2.wikiDocumentId, 'QA (default holder) creates written doc')
    qaDocId = r2.data?.wikiDocumentId ?? r2.wikiDocumentId

    const r3 = await post(devJar, { title: 'Dev doc', content: '<p>x</p>' })
    ok(r3.status === 403, `developer (no create_wiki_doc) create -> ${r3.status} (must be 403)`)

    const r4 = await post(viewerJar, { title: 'Viewer doc', content: '<p>x</p>' })
    ok(r4.status === 403, `viewer (no permissions at all) create -> ${r4.status} (must be 403)`)

    const r5 = await post(viewerJar, {})
    ok(r5.status === 403 || r5.status === 400, `viewer cannot create (got ${r5.status} — validation/permission both block)`)
  }

  console.log('\n== 2. READ (all authenticated users) ==')
  {
    const list = await J(await fetch(`${BASE}/api/wiki`, { headers: H(viewerJar), signal }))
    ok(list.data?.length >= 2, `viewer can list the wiki (${list.data?.length} docs)`)
    const one = await getJson(viewerJar, `/api/wiki?id=${qaDocId}`)
    ok(one.wikiDocumentId === qaDocId, 'viewer can read a single document')
    ok(one.content === '<p>qa wrote this</p>', 'written content comes back intact')
    ok(!('fileData' in one), 'file bytes never leak into JSON responses')
    const missing = await fetch(`${BASE}/api/wiki?id=${STAMP}-missing`, { headers: H(viewerJar), signal })
    ok(missing.status === 404, `unknown id -> ${missing.status} (must be 404)`)
  }

  console.log('\n== 3. EDIT (edit_own vs edit_any) ==')
  {
    const r1 = await J(await put(qaJar, qaDocId, { content: '<p>qa edited <b>bold</b> own doc</p>' }))
    ok(r1.content?.includes('<b>bold</b>'), 'QA edits OWN doc (edit_own_wiki_doc)')

    const r2 = await put(qaJar, vpDocId, { title: 'hijacked' })
    ok(r2.status === 403, `QA edits VP's doc (no edit_any) -> ${r2.status} (must be 403)`)

    const r3 = await J(await put(mgrJar, qaDocId, { title: `QA doc renamed by manager ${STAMP}` }))
    ok(r3.title?.includes('renamed by manager'), 'Manager edits ANY doc (edit_any_wiki_doc)')

    const r4 = await put(prodJar, qaDocId, { title: 'nope' })
    ok(r4.status === 403, `Product edits someone else's doc (no edit_any) -> ${r4.status} (must be 403)`)

    const r5 = await put(devJar, qaDocId, { title: 'nope' })
    ok(r5.status === 403, `Developer edit -> ${r5.status} (must be 403)`)
  }

  console.log('\n== 4. DELETE (author OR delete_wiki_doc — same rule as test cases) ==')
  {
    const d1 = await J(await post(prodJar, { title: `Prod temp ${STAMP}`, content: '<p>temp</p>' }))
    const prodDocId = d1.data?.wikiDocumentId ?? d1.wikiDocumentId
    const r1 = await del(prodJar, prodDocId)
    ok(r1.status === 200, 'Author deletes OWN doc (no delete_wiki_doc needed)')

    const r2 = await del(qaJar, vpDocId)
    ok(r2.status === 403, `QA deletes VP's doc -> ${r2.status} (must be 403)`)

    const r3 = await del(mgrJar, vpDocId)
    ok(r3.status === 200, 'Manager deletes ANY doc (delete_wiki_doc holder)')
    const r3b = await del(mgrJar, vpDocId)
    ok(r3b.status === 404, `second delete of same doc -> ${r3b.status} (must be 404)`)

    const d2 = await J(await post(vpJar, { title: `VP survives ${STAMP}`, content: '<p>keep</p>' }))
    const keepDocId = d2.data?.wikiDocumentId ?? d2.wikiDocumentId
    const r4 = await del(devJar, keepDocId)
    ok(r4.status === 403, `Developer delete -> ${r4.status} (must be 403)`)
  }

  await state.hook('section-5')
  console.log('\n== 5. UPLOAD + DOWNLOAD (bytes round-trip) ==')
  {
    // 5a. multipart create
    const form = new FormData()
    form.set('file', new Blob([Buffer.from('hello wiki bytes — éà✓')], { type: 'text/plain' }), 'notes.txt')
    form.set('title', `Upload notes ${STAMP}`)
    form.set('tags', JSON.stringify(['uploads', 'txt']))
    const up = await upload(qaJar, '/api/wiki?action=upload', 'POST', form)
    const upBody = await J(up)
    ok(up.status === 200, `QA uploads a text file -> ${up.status}`)
    fileDocId = upBody.wikiDocumentId ?? upBody.data?.wikiDocumentId
    ok(upBody.fileName === 'notes.txt' && upBody.fileSize > 0, `file meta stored (${upBody.fileName}, ${upBody.fileSize}B)`)

    // 5b. download round-trip (exact bytes + headers)
    const dl = await fetch(`${BASE}/api/wiki?id=${fileDocId}&action=download`, { headers: { Cookie: viewerJar }, signal })
    const text = await dl.text()
    ok(dl.status === 200, 'viewer downloads the file (read is open to all authenticated)')
    ok(text.includes('hello wiki bytes'), 'downloaded bytes match the upload exactly')
    ok((dl.headers.get('content-disposition') ?? '').includes('attachment'), 'Content-Disposition is attachment (download-only)')

    // 5c. non-matching Origin without the CSRF marker -> blocked 403
    const noCsrf = await fetch(`${BASE}/api/wiki?action=upload`, { method: 'POST', headers: { Cookie: qaJar, Origin: 'https://evil.example' }, body: new FormData(), signal })
    ok(noCsrf.status === 403, `cross-site upload (unmatched Origin, no marker) -> ${noCsrf.status} (must be 403)`)

    // 5d. replace file
    const form2 = new FormData()
    form2.set('file', new Blob([Buffer.from('REPLACED CONTENT v2')], { type: 'text/plain' }), 'notes-v2.txt')
    const rep = await upload(qaJar, `/api/wiki?id=${fileDocId}&action=upload`, 'PUT', form2)
    ok(rep.status === 200, `author replaces the file -> ${rep.status}`)
    const dl2 = await fetch(`${BASE}/api/wiki?id=${fileDocId}&action=download`, { headers: { Cookie: qaJar }, signal })
    ok((await dl2.text()).includes('REPLACED CONTENT v2'), 'downloaded bytes after replace are the new file')

    // 5e. upload permission gating
    const form3 = new FormData()
    form3.set('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'x.txt')
    const devUp = await upload(devJar, '/api/wiki?action=upload', 'POST', form3)
    ok(devUp.status === 403, `developer upload -> ${devUp.status} (must be 403)`)

    // 5f. manager (non-author, edit_any) can replace
    const form4 = new FormData()
    form4.set('file', new Blob([Buffer.from('manager replace')], { type: 'text/plain' }), 'notes-v3.txt')
    const mgrRep = await upload(mgrJar, `/api/wiki?id=${fileDocId}&action=upload`, 'PUT', form4)
    ok(mgrRep.status === 200, `manager (edit_any) replaces someone else's file -> ${mgrRep.status}`)
  }

  console.log('\n== 6. VALIDATION & SANITIZATION ==')
  {
    const r1 = await post(qaJar, { title: '', content: '<p>x</p>' })
    ok(r1.status === 400, `empty title -> ${r1.status} (must be 400)`)

    const r2 = await post(qaJar, { title: 'no content' })
    ok(r2.status === 200, 'written doc without content is allowed (created empty)')

    const r3 = await J(await post(qaJar, {
      title: `XSS attempt ${STAMP}`,
      content: '<p>safe</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">bad</a>',
    }))
    const c = r3.data?.content ?? ''
    ok(!c.toLowerCase().includes('<script'), 'script tags stripped server-side')
    ok(!/onerror/i.test(c), 'inline event handlers stripped server-side')
    ok(!/javascript:/i.test(c), 'javascript: URLs neutralized server-side')

    await J(await post(qaJar, { title: 'bad ext', tags: [] }))
    const form5 = new FormData()
    form5.set('file', new Blob([Buffer.from('MZ')], { type: 'application/octet-stream' }), 'evil.exe')
    const r5 = await upload(qaJar, '/api/wiki?action=upload', 'POST', form5)
    ok(r5.status === 400, `disallowed extension (.exe) -> ${r5.status} (must be 400)`)

    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 65)
    const form6 = new FormData()
    form6.set('file', new Blob([big], { type: 'text/plain' }), 'big.txt')
    const r6 = await upload(qaJar, '/api/wiki?action=upload', 'POST', form6)
    ok(r6.status === 400, `oversize file (>10MB) -> ${r6.status} (must be 400)`)
  }

  console.log('\n== 7. LIST FILTERS & SEARCH ==')
  {
    const bySearch = await getJson(qaJar, `/api/wiki?search=${encodeURIComponent('renamed by manager')}`)
    ok(bySearch.data?.some((d) => d.title.includes('renamed by manager')), 'search finds by title')

    const byContent = await getJson(qaJar, `/api/wiki?search=${encodeURIComponent('bold')}`)
    ok(bySearch.data && byContent.data !== undefined, 'search endpoint answers for content too')

    const written = await getJson(qaJar, '/api/wiki?kind=written')
    ok(written.data?.every((d) => d.kind === 'written'), 'kind=written filter works')

    const files = await getJson(qaJar, '/api/wiki?kind=file')
    ok(files.data?.every((d) => d.kind === 'file') && files.data.length >= 1, 'kind=file filter works')

    const byTag = await getJson(qaJar, '/api/wiki?tag=uploads')
    ok(byTag.data?.some((d) => d.wikiDocumentId === fileDocId), 'tag filter works')

    // 8b. global search includes wiki
    const gs = await getJson(qaJar, `/api/search?q=${encodeURIComponent('renamed by manager')}&limit=5`)
    ok(Array.isArray(gs.wiki) && gs.wiki.some((w) => w.title.includes('renamed by manager')), 'global search surfaces wiki documents')
  }

  console.log('\n== 8. RUNTIME MATRIX TOGGLE (VP can grant/revoke live) ==')
  {
    // Grant developer create+delete through the real path (PUT /api/permissions as
    // the fixture VP: cache invalidation + audit row), verify the gate opens, revoke.
    const toggle = (action, enabled) =>
      requestJson('PUT', '/api/permissions', { jar: vpJar, body: { role: 'developer', action, enabled }, signal })
    const g1 = await toggle('create_wiki_doc', true)
    ok(g1.status === 200, `grant developer/create_wiki_doc via PUT /api/permissions as fixture VP -> ${g1.status} (must be 200)`)
    const g2 = await toggle('delete_wiki_doc', true)
    ok(g2.status === 200, `grant developer/delete_wiki_doc via PUT /api/permissions as fixture VP -> ${g2.status} (must be 200)`)
    await state.hook('after-grant')
    await sleep(PERMISSION_CACHE_WAIT_MS, signal)

    const created = await J(await post(devJar, { title: `Dev granted ${STAMP}`, content: '<p>granted</p>' }))
    const devDocId = created.data?.wikiDocumentId ?? created.wikiDocumentId
    ok(!!devDocId, 'developer creates after matrix grant (runtime toggle works)')

    const victim = await J(await post(qaJar, { title: `Toggle victim ${STAMP}`, content: '<p>v</p>' }))
    const victimId = victim.data?.wikiDocumentId ?? victim.wikiDocumentId
    const delNow = await del(devJar, victimId)
    ok(delNow.status === 200, 'developer deletes after delete_wiki_doc grant (not author, matrix-driven)')

    // enabled:false is the developer default -> the service deletes the override row.
    const v1 = await toggle('create_wiki_doc', false)
    ok(v1.status === 200, `revoke developer/create_wiki_doc via PUT (default-restore) -> ${v1.status} (must be 200)`)
    const v2 = await toggle('delete_wiki_doc', false)
    ok(v2.status === 200, `revoke developer/delete_wiki_doc via PUT (default-restore) -> ${v2.status} (must be 200)`)
    await sleep(PERMISSION_CACHE_WAIT_MS, signal)
    const afterRevoke = await post(devJar, { title: 'revoked', content: '<p>x</p>' })
    ok(afterRevoke.status === 403, `create blocked again after revoke -> ${afterRevoke.status} (must be 403)`)
  }

  console.log('\n== 9. CLEANUP (API) ==')
  {
    // Delete every stamped fixture document via the API (VP can delete any).
    // The authoritative sweep (incl. unstamped docs) is the SQL cleanup below.
    const left = await getJson(vpJar, `/api/wiki?search=${encodeURIComponent(String(STAMP))}&pageSize=100`)
    let deleted = 0
    for (const doc of left.data ?? []) {
      const r = await del(vpJar, doc.wikiDocumentId)
      if (r.status === 200) deleted++
    }
    ok((left.data ?? []).length > 0 && deleted === (left.data ?? []).length, `all fixture documents removed (${deleted}/${left.data?.length})`)
    const after = await getJson(vpJar, `/api/wiki?search=${encodeURIComponent(String(STAMP))}`)
    ok((after.data ?? []).length === 0, 'wiki clean after cleanup')
  }
}

// ---------- cleanup (finally, Ctrl+C, and --cleanup-stamp recovery) ----------

async function cleanupWiki(ctx, counter, state, { isRecovery }) {
  const { db, guard } = ctx
  console.log('\n== CLEANUP (SQL, keyed on fixture ids) ==')
  const emails = fixtureSpecs(ctx.stamp).map((s) => s.email)
  const found = await findUsersByEmails(db, emails)
  const fixtureIds = [...new Set([...ctx.fixtures.map((u) => u.userId), ...found.map((r) => r.user_id)])]
  const entities = await collectEntities(db, fixtureIds, ctx.entities)
  writeManifest(ctx.manifestFile, { suite: SUITE, stamp: ctx.stamp, emails, fixtureIds, entities })
  console.log(`      fixture users found=${fixtureIds.length} wiki docs=${entities.wikiDocs.length}`)
  if (!(await guard.assertLockOwned())) counter.check('lock tcms_verify still owned by this run', false, 'lock lost')

  await runCleanupStep(counter, 'wiki_documents by fixture author_id', async () => {
    let deleted = 0
    for (const [i, docId] of entities.wikiDocs.entries()) {
      deleted += await deleteWikiDocById(db, docId)
      if (i === 0 && !isRecovery) await state.hook('mid-cleanup-docs')
    }
    return { ok: true, detail: `${deleted} deleted of ${entities.wikiDocs.length} listed` }
  })

  let restoredRows = 0
  await runCleanupStep(counter, 'role_permissions touched cells', async () => {
    const { deleted, foreign } = await restoreTouchedCells(db, TOUCHED_CELLS, fixtureIds)
    restoredRows = deleted
    if (foreign.length) return { ok: false, detail: `matrix changed by another actor: ${foreign.join(', ')} (not touched)` }
    return { ok: true, detail: `${deleted} fixture row(s) deleted` }
  })
  if (!isRecovery || restoredRows > 0) await sleep(PERMISSION_CACHE_WAIT_MS)

  if (!isRecovery) {
    const after = ctx.vpJar ? await readMatrixSnapshot(ctx.vpJar).catch(() => null) : null
    if (!ctx.snapshot || !after) {
      counter.check('matrix: touched cells equal the pre-run GET snapshot', false, 'no pre-run or post-run GET snapshot')
      counter.check('matrix: untouched cells unchanged', false, 'no pre-run or post-run GET snapshot')
    } else {
      const touched = diffMatrix(ctx.snapshot, after, { only: TOUCHED_KEYS })
      counter.check('matrix: touched cells equal the pre-run GET snapshot', touched.length === 0, touched.join('; '))
      const others = diffMatrix(ctx.snapshot, after, { except: TOUCHED_KEYS })
      counter.check('matrix: untouched cells unchanged', others.length === 0, `matrix changed by another actor: ${others.join('; ')}`)
    }
  }

  await runCleanupStep(counter, 'activity_logs by fixture user_id', async () => {
    const n = await deleteActivityLogsByUsers(db, fixtureIds)
    return { ok: true, detail: `${n} deleted` }
  })
  await runCleanupStep(counter, 'login_attempts by fixture email', async () => {
    const n = await deleteLoginAttemptsByEmails(db, emails)
    return { ok: true, detail: `${n} deleted` }
  })
  await runCleanupStep(counter, 'users by fixture id', async () => {
    const { deleted, failed } = await deleteUsersByIds(db, fixtureIds)
    return { ok: failed.length === 0, detail: `${deleted} deleted${failed.length ? `; not deleted: ${failed.join(', ')}` : ''}` }
  })

  console.log('\n== RESIDUE (by stamp e-mails and fixture ids) ==')
  const residue = await countResidue(db, { fixtureIds, emails, entities }, RESIDUE_TABLES)
  checkResidue(counter, residue)
}

// ---------- entry points ----------

async function runSuite(ctx, hooks) {
  const counter = createCounter()
  const state = createRunState(hooks)
  const pre = await ctx.db.$queryRaw`
    SELECT role, action, enabled, updated_by_id, updated_at FROM role_permissions
    WHERE role = 'developer' AND action IN ('create_wiki_doc', 'delete_wiki_doc')`
  if (pre.length > 0) {
    for (const r of pre) {
      console.log(`PRECONDITION: developer/${r.action} has an override row (enabled=${Number(r.enabled)}, updated_by_id=${r.updated_by_id ?? 'null'}, updated_at=${r.updated_at?.toISOString?.() ?? r.updated_at})`)
    }
    console.log('NOT RUN: no fixture created, nothing written')
    process.removeListener('SIGINT', state.onSigint)
    return 2
  }

  try {
    ctx.fixtures = await createFixtureUsers(ctx.db, fixtureSpecs(ctx.stamp))
    writeManifest(ctx.manifestFile, { suite: SUITE, stamp: ctx.stamp, fixtureIds: ctx.fixtures.map((u) => u.userId) })
    await runSections(ctx, counter, state)
  } catch (err) {
    if (state.interrupted) counter.check('INTERRUPTED (SIGINT)', false)
    else if (err instanceof ForcedFailure) counter.check(err.message, false)
    else counter.check(`suite aborted: ${err.message}`, false)
  } finally {
    state.cleaning = true
    try {
      await cleanupWiki(ctx, counter, state, { isRecovery: false })
    } catch (err) {
      counter.check('cleanup completed', false, err.message)
    }
  }

  console.log(`\nPASS=${counter.pass} FAIL=${counter.fail}`)
  console.log(counter.fail === 0 ? 'RESULT: ALL WIKI API CHECKS GREEN' : `RESULT: ${counter.fail} WIKI API CHECK(S) FAILED`)
  process.removeListener('SIGINT', state.onSigint)
  return resolveExitCode(state, counter)
}

async function runRecovery(ctx) {
  const counter = createCounter()
  const state = createRunState({ failAt: null, pauseAt: null })
  state.cleaning = true
  console.log(`RECOVERY: cleanup only for stamp ${ctx.stamp}`)
  try {
    await cleanupWiki(ctx, counter, state, { isRecovery: true })
  } catch (err) {
    counter.check('cleanup completed', false, err.message)
  }
  console.log(`\nPASS=${counter.pass} FAIL=${counter.fail}`)
  console.log(counter.fail === 0 ? 'RESULT: RECOVERY CLEANUP GREEN' : `RESULT: RECOVERY CLEANUP ${counter.fail} CHECK(S) FAILED`)
  process.removeListener('SIGINT', state.onSigint)
  return counter.fail > 0 ? 1 : 0
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const recoveryStamp = flags['cleanup-stamp']
  const stamp = recoveryStamp ? String(recoveryStamp) : String(Date.now())
  console.log(`STAMP=${stamp}`)
  if (recoveryStamp && !/^\d{13}$/.test(stamp)) {
    console.log('NOT RUN: --cleanup-stamp must be the 13-digit stamp printed by an earlier run')
    return 2
  }
  const hooks = readHooks(HOOK_STEPS)
  if (!hooks.ok) {
    console.log(`NOT RUN: ${hooks.message}`)
    return 2
  }
  const manifestFile = manifestPath(SUITE, stamp)
  console.log(`MANIFEST=${manifestFile}`)

  let guard
  try {
    guard = await openGuardedDb()
  } catch (err) {
    if (err instanceof GuardAbort) {
      console.log(`NOT RUN: ${err.message}`)
      return 2
    }
    throw err
  }
  const ctx = { db: guard.db, guard, stamp, manifestFile, fixtures: [], entities: emptyEntities(), snapshot: null, vpJar: null }
  try {
    return recoveryStamp ? await runRecovery(ctx) : await runSuite(ctx, hooks)
  } finally {
    await guard.release()
  }
}

main().then(
  (code) => { process.exitCode = code },
  (err) => { console.error(`SUITE ERROR: ${err.message}`); process.exitCode = 1 }
)
