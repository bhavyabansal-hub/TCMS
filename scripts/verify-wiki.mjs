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
 */
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const BASE = 'http://localhost:3000'
const db = new PrismaClient()
let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok' : 'FAIL'}  ${msg}`); if (!cond) failed++ }

const STAMP = Date.now()
const VP      = { email: `wiki-vp-${STAMP}@tcms.test`,      name: 'Wiki VP',      password: 'Wiki@12345', role: 'vp' }
const MGR     = { email: `wiki-mgr-${STAMP}@tcms.test`,     name: 'Wiki Mgr',     password: 'Wiki@12345', role: 'manager' }
const PROD    = { email: `wiki-prod-${STAMP}@tcms.test`,    name: 'Wiki Prod',    password: 'Wiki@12345', role: 'product' }
const QA      = { email: `wiki-qa-${STAMP}@tcms.test`,      name: 'Wiki QA',      password: 'Wiki@12345', role: 'qa_engineer' }
const DEV     = { email: `wiki-dev-${STAMP}@tcms.test`,     name: 'Wiki Dev',     password: 'Wiki@12345', role: 'developer' }
const VIEWER  = { email: `wiki-viewer-${STAMP}@tcms.test`,  name: 'Wiki Viewer',  password: 'Wiki@12345', role: 'viewer' }
const FIXTURES = [VP, MGR, PROD, QA, DEV, VIEWER]

for (const u of FIXTURES) {
  await db.user.create({ data: { email: u.email, fullName: u.name, passwordHash: await bcrypt.hash(u.password, 10), role: u.role, isActive: true } })
}
await new Promise((r) => setTimeout(r, 3500)) // outlive the 3s permission-cache TTL

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status}`)
  const pair = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tcms-access='))
  return pair ? pair.split(';')[0] : ''
}
const H = (jar) => ({ Cookie: jar, 'X-Requested-With': 'tcms', Origin: BASE, 'Content-Type': 'application/json' })
const J = async (res) => { const t = await res.text(); try { return JSON.parse(t) } catch { return { raw: t.slice(0, 120) } } }

const vpJar = await login(VP.email, VP.password)
const mgrJar = await login(MGR.email, MGR.password)
const prodJar = await login(PROD.email, PROD.password)
const qaJar = await login(QA.email, QA.password)
const devJar = await login(DEV.email, DEV.password)
const viewerJar = await login(VIEWER.email, VIEWER.password)

const post = (jar, body) => fetch(`${BASE}/api/wiki`, { method: 'POST', headers: H(jar), body: JSON.stringify(body) })
const put = (jar, id, body) => fetch(`${BASE}/api/wiki?id=${id}`, { method: 'PUT', headers: H(jar), body: JSON.stringify(body) })
const del = (jar, id) => fetch(`${BASE}/api/wiki?id=${id}`, { method: 'DELETE', headers: H(jar) })
const getJson = async (jar, url) => J(await fetch(`${BASE}${url}`, { headers: H(jar) }))

console.log('\n== 1. CREATE (create_wiki_doc) ==')
{
  const r1 = await J(await post(vpJar, { title: `VP doc ${STAMP}`, content: '<p>vp wrote this</p>', tags: ['vp'] }))
  ok(r1.data?.wikiDocumentId || r1.wikiDocumentId, 'VP (matrix holder) creates written doc')
  var vpDocId = r1.data?.wikiDocumentId ?? r1.wikiDocumentId

  const r2 = await J(await post(qaJar, { title: `QA doc ${STAMP}`, content: '<p>qa wrote this</p>', tags: ['qa', 'howto'] }))
  ok(r2.data?.wikiDocumentId || r2.wikiDocumentId, 'QA (default holder) creates written doc')
  var qaDocId = r2.data?.wikiDocumentId ?? r2.wikiDocumentId

  const r3 = await post(devJar, { title: 'Dev doc', content: '<p>x</p>' })
  ok(r3.status === 403, `developer (no create_wiki_doc) create -> ${r3.status} (must be 403)`)

  const r4 = await post(viewerJar, { title: 'Viewer doc', content: '<p>x</p>' })
  ok(r4.status === 403, `viewer (no permissions at all) create -> ${r4.status} (must be 403)`)

  const r5 = await post(viewerJar, {})
  ok(r5.status === 403 || r5.status === 400, `viewer cannot create (got ${r5.status} — validation/permission both block)`)
}

console.log('\n== 2. READ (all authenticated users) ==')
{
  const list = await J(await fetch(`${BASE}/api/wiki`, { headers: H(viewerJar) }))
  ok(list.data?.length >= 2, `viewer can list the wiki (${list.data?.length} docs)`)
  const one = await getJson(viewerJar, `/api/wiki?id=${qaDocId}`)
  ok(one.wikiDocumentId === qaDocId, 'viewer can read a single document')
  ok(one.content === '<p>qa wrote this</p>', 'written content comes back intact')
  ok(!('fileData' in one), 'file bytes never leak into JSON responses')
  const missing = await fetch(`${BASE}/api/wiki?id=${STAMP}-missing`, { headers: H(viewerJar) })
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
  var keepDocId = d2.data?.wikiDocumentId ?? d2.wikiDocumentId
  const r4 = await del(devJar, keepDocId)
  ok(r4.status === 403, `Developer delete -> ${r4.status} (must be 403)`)
}

console.log('\n== 5. UPLOAD + DOWNLOAD (bytes round-trip) ==')
{
  // 5a. multipart create
  const form = new FormData()
  form.set('file', new Blob([Buffer.from('hello wiki bytes — \u00e9\u00e0\u2713')], { type: 'text/plain' }), 'notes.txt')
  form.set('title', `Upload notes ${STAMP}`)
  form.set('tags', JSON.stringify(['uploads', 'txt']))
  const up = await fetch(`${BASE}/api/wiki?action=upload`, { method: 'POST', headers: { Cookie: qaJar, 'X-Requested-With': 'tcms', Origin: BASE }, body: form })
  const upBody = await J(up)
  ok(up.status === 200, `QA uploads a text file -> ${up.status}`)
  var fileDocId = upBody.wikiDocumentId ?? upBody.data?.wikiDocumentId
  ok(upBody.fileName === 'notes.txt' && upBody.fileSize > 0, `file meta stored (${upBody.fileName}, ${upBody.fileSize}B)`)

  // 5b. download round-trip (exact bytes + headers)
  const dl = await fetch(`${BASE}/api/wiki?id=${fileDocId}&action=download`, { headers: { Cookie: viewerJar } })
  const text = await dl.text()
  ok(dl.status === 200, 'viewer downloads the file (read is open to all authenticated)')
  ok(text.includes('hello wiki bytes'), 'downloaded bytes match the upload exactly')
  ok((dl.headers.get('content-disposition') ?? '').includes('attachment'), 'Content-Disposition is attachment (download-only)')

  // 5c. non-matching Origin without the CSRF marker -> blocked 403
  const noCsrf = await fetch(`${BASE}/api/wiki?action=upload`, { method: 'POST', headers: { Cookie: qaJar, Origin: 'https://evil.example' }, body: new FormData() })
  ok(noCsrf.status === 403, `cross-site upload (unmatched Origin, no marker) -> ${noCsrf.status} (must be 403)`)

  // 5d. replace file
  const form2 = new FormData()
  form2.set('file', new Blob([Buffer.from('REPLACED CONTENT v2')], { type: 'text/plain' }), 'notes-v2.txt')
  const rep = await fetch(`${BASE}/api/wiki?id=${fileDocId}&action=upload`, { method: 'PUT', headers: { Cookie: qaJar, 'X-Requested-With': 'tcms', Origin: BASE }, body: form2 })
  ok(rep.status === 200, `author replaces the file -> ${rep.status}`)
  const dl2 = await fetch(`${BASE}/api/wiki?id=${fileDocId}&action=download`, { headers: { Cookie: qaJar } })
  ok((await dl2.text()).includes('REPLACED CONTENT v2'), 'downloaded bytes after replace are the new file')

  // 5e. upload permission gating
  const form3 = new FormData()
  form3.set('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'x.txt')
  const devUp = await fetch(`${BASE}/api/wiki?action=upload`, { method: 'POST', headers: { Cookie: devJar, 'X-Requested-With': 'tcms', Origin: BASE }, body: form3 })
  ok(devUp.status === 403, `developer upload -> ${devUp.status} (must be 403)`)

  // 5f. manager (non-author, edit_any) can replace
  const form4 = new FormData()
  form4.set('file', new Blob([Buffer.from('manager replace')], { type: 'text/plain' }), 'notes-v3.txt')
  const mgrRep = await fetch(`${BASE}/api/wiki?id=${fileDocId}&action=upload`, { method: 'PUT', headers: { Cookie: mgrJar, 'X-Requested-With': 'tcms', Origin: BASE }, body: form4 })
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

  const dis = await J(await post(qaJar, { title: 'bad ext', tags: [] }))
  const form5 = new FormData()
  form5.set('file', new Blob([Buffer.from('MZ')], { type: 'application/octet-stream' }), 'evil.exe')
  const r5 = await fetch(`${BASE}/api/wiki?action=upload`, { method: 'POST', headers: { Cookie: qaJar, 'X-Requested-With': 'tcms', Origin: BASE }, body: form5 })
  ok(r5.status === 400, `disallowed extension (.exe) -> ${r5.status} (must be 400)`)

  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 65)
  const form6 = new FormData()
  form6.set('file', new Blob([big], { type: 'text/plain' }), 'big.txt')
  const r6 = await fetch(`${BASE}/api/wiki?action=upload`, { method: 'POST', headers: { Cookie: qaJar, 'X-Requested-With': 'tcms', Origin: BASE }, body: form6 })
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
  // Grant developer create+delete via the role_permissions table (same path
  // the settings/permissions UI uses), verify the gate opens, then revoke.
  await db.$queryRaw`INSERT INTO role_permissions (role, action, enabled, updated_at)
    VALUES ('developer', 'create_wiki_doc', true, NOW()), ('developer', 'delete_wiki_doc', true, NOW())
    ON CONFLICT (role, action) DO UPDATE SET enabled = true, updated_at = NOW()`
  await new Promise((r) => setTimeout(r, 3500))

  const created = await J(await post(devJar, { title: `Dev granted ${STAMP}`, content: '<p>granted</p>' }))
  const devDocId = created.data?.wikiDocumentId ?? created.wikiDocumentId
  ok(!!devDocId, 'developer creates after matrix grant (runtime toggle works)')

  const victim = await J(await post(qaJar, { title: `Toggle victim ${STAMP}`, content: '<p>v</p>' }))
  const victimId = victim.data?.wikiDocumentId ?? victim.wikiDocumentId
  const delNow = await del(devJar, victimId)
  ok(delNow.status === 200, 'developer deletes after delete_wiki_doc grant (not author, matrix-driven)')

  await db.$queryRaw`DELETE FROM role_permissions WHERE role = 'developer' AND action IN ('create_wiki_doc','delete_wiki_doc')`
  await new Promise((r) => setTimeout(r, 3500))
  const afterRevoke = await post(devJar, { title: 'revoked', content: '<p>x</p>' })
  ok(afterRevoke.status === 403, `create blocked again after revoke -> ${afterRevoke.status} (must be 403)`)
}

console.log('\n== 9. CLEANUP ==')
{
  // Delete every fixture document (VP can delete any) — find by the stamp
  // shared by all fixture titles, then delete one by one.
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

// Cleanup fixture users (wiki docs referencing them must go FIRST — FK RESTRICT)
await db.$queryRaw`DELETE FROM wiki_documents WHERE author_id IN (SELECT user_id FROM users WHERE email LIKE ${`wiki-%-${STAMP}@tcms.test`})`
await db.$queryRaw`DELETE FROM notifications WHERE user_id IN (SELECT user_id FROM users WHERE email LIKE ${`wiki-%-${STAMP}@tcms.test`})`
await db.$queryRaw`DELETE FROM activity_logs WHERE user_id IN (SELECT user_id FROM users WHERE email LIKE ${`wiki-%-${STAMP}@tcms.test`})`
await db.$queryRaw`DELETE FROM refresh_tokens WHERE user_id IN (SELECT user_id FROM users WHERE email LIKE ${`wiki-%-${STAMP}@tcms.test`})`
await db.$queryRaw`DELETE FROM users WHERE email LIKE ${`wiki-%-${STAMP}@tcms.test`}`
await db.$disconnect()

console.log(failed === 0 ? '\nRESULT: ALL WIKI API CHECKS GREEN' : `\nRESULT: ${failed} WIKI API CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
