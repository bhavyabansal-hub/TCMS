#!/usr/bin/env node
/**
 * E2E battery for the Test-Case CSV Import feature.
 * Proves the bidirectional permission rule and the full import flow:
 *   1. Template: 200 for create_test_case holders, 403 otherwise
 *   2. Template content: headers + instructions + multi-step example rows
 *   3. Import: QA imports a mixed CSV into a submodule -> created + per-row errors
 *   4. Imported cases REALLY live in the target module (list by moduleId)
 *   5. Developer (no create_test_case): import -> 403
 *   6. Bad requests: missing module / missing title column / no data rows -> 400
 */
const BASE = 'http://localhost:3000'
let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email, password }),
  })
  const json = await res.json()
  // Cookie-session contract: access token arrives as httpOnly cookie, not body.
  const raw = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tcms-access=')) ?? ''
  const token = raw.split(';')[0].replace(/^tcms-access=/, '')
  if (!token) throw new Error(`login for ${email} set no tcms-access cookie`)
  return { token, user: json.user, perms: json.permissions }
}
// First-party CSRF marker on every call (GETs tolerate it, mutations require it).
const H = (token) => ({ 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Cookie: `tcms-access=${token}` })

async function main() {
  // ---------- logins ----------
  const vp = await login('admin@tcms.com', 'Admin@123')
  const qa = await login('qa1@tcms.com', 'QA@12345')
  const dev = await login('developer@tcms.com', 'Dev@12345')
  // VP holds the FULL matrix — compare against the live matrix (the action
  // count grew when the wiki module shipped; never hardcode it again).
  const matrixRes = await fetch(`${BASE}/api/permissions`, { headers: H(vp.token) })
  const matrixJson = await matrixRes.json().catch(() => [])
  const vpFullCount = (Array.isArray(matrixJson) ? matrixJson : []).filter((t) => t.role === 'vp' && t.enabled).length
  check(`VP logged in with the FULL matrix (${vpFullCount} permissions)`, vp.perms.length === vpFullCount && vpFullCount >= 20)
  check('QA holds create_test_case', qa.perms.includes('create_test_case'))
  check('Developer lacks create_test_case', !dev.perms.includes('create_test_case'))

  // ---------- 1+2. template ----------
  const tplRes = await fetch(`${BASE}/api/test-cases?action=import-template`, { headers: H(vp.token) })
  const tpl = await tplRes.json()
  check('GET import-template -> 200 (VP)', tplRes.status === 200)
  check('template has fileName + csv', typeof tpl.fileName === 'string' && typeof tpl.csv === 'string')
  check('template fileName is a .csv', tpl.fileName?.toLowerCase().endsWith('.csv'))
  const lines = (tpl.csv || '').split('\n')
  check('template has # instruction lines', lines.some((l) => l.startsWith('# TCMS')))
  check('template header row uses app field names',
    lines.some((l) => l.startsWith('title,description,priority,expected_result,tags')))
  check('template documents title + description requirement', tpl.csv.includes('"title" and "description" are required'))
  check('template documents the P0-P3 priority rule', tpl.csv.includes('P0, P1, P2, P3'))
  const tplQa = await fetch(`${BASE}/api/test-cases?action=import-template`, { headers: H(qa.token) })
  check('GET import-template -> 200 (QA)', tplQa.status === 200)
  const tplDev = await fetch(`${BASE}/api/test-cases?action=import-template`, { headers: H(dev.token) })
  check('GET import-template -> 403 (developer, not granted)', tplDev.status === 403)
  const tplAnon = await fetch(`${BASE}/api/test-cases?action=import-template`)
  check('GET import-template -> 401 (anonymous)', tplAnon.status === 401)

  // ---------- 3. find a target submodule ----------
  const treeRes = await fetch(`${BASE}/api/modules`, { headers: H(qa.token) })
  const tree = await treeRes.json()
  const sub = tree.flat.find((m) => m.parentId)
  const target = sub ?? tree.flat[0]
  check('target module/submodule found', !!target?.moduleId, JSON.stringify(tree.flat.length))

  // ---------- 4. import a mixed CSV ----------
  // Format note (current contract): title + description are required per row;
  // the steps column is no longer in the template but stays backward-accepted
  // with the "action => expected;;action => expected" encoding.
  // Titles carry a per-run stamp so repeated runs never collide with (or
  // re-classify) cases imported by earlier runs.
  const stamp = Date.now()
  const P = `Imported: ${stamp}` // title prefix for this run
  const csv = [
    'title,description,preconditions,priority,expected_result,tags,steps',
    `${P} checkout with saved card,Happy path for saved card,User has a saved card,P1,Order is placed and confirmation shown,"smoke;import","Open checkout => Saved card is preselected;;Click Pay => Confirmation page opens"`,
    `${P} checkout with new card,New card flow validation,User is logged in,P2,Payment succeeds,import,Fill card form => Fields validate;;Click Pay => Confirmation page opens`,
    `${P} guest checkout limit,No auth required,,P3,Checkout allowed up to the limit,,`,
    `${P} bad priority row,This row must fail,,P9,should fail,,`,
    `,This row has no title,,P2,should fail,,`,
    `${P} missing description row,,P2,should fail,,`,
  ].join('\n')
  const impRes = await fetch(`${BASE}/api/test-cases?action=import`, {
    method: 'POST',
    headers: H(qa.token),
    body: JSON.stringify({ moduleId: target.moduleId, fileName: 'e2e-import.csv', csv }),
  })
  const imp = await impRes.json()
  check('POST import -> 200 (QA)', impRes.status === 200, JSON.stringify(imp).slice(0, 200))
  check('summary counts 3 imported / 3 failed', imp.imported === 3 && imp.failed === 3, `imported=${imp.imported} failed=${imp.failed}`)
  check('summary names the target module', imp.moduleName === target.name)
  check('row1 created with id', imp.results?.[0]?.status === 'created' && !!imp.results?.[0]?.testCaseId)
  check('row3 (no steps) created', imp.results?.[2]?.status === 'created')
  check('row4 failed on bad priority', imp.results?.[3]?.status === 'failed' && /P0, P1, P2, P3/.test(imp.results?.[3]?.error ?? ''))
  check('row5 failed on missing title', imp.results?.[4]?.status === 'failed' && /title is required/.test(imp.results?.[4]?.error ?? ''))
  check('row6 failed on missing description', imp.results?.[5]?.status === 'failed' && /description is required/.test(imp.results?.[5]?.error ?? ''))

  // ---------- 5. imported cases REALLY live in the target module ----------
  const listRes = await fetch(`${BASE}/api/test-cases?moduleId=${target.moduleId}&pageSize=100`, { headers: H(qa.token) })
  const list = await listRes.json()
  const titles = list.data.map((tc) => tc.title)
  check('imported cases appear in the module list', titles.includes(`${P} checkout with saved card`))
  check('imported case keeps its content', (() => {
    const tc = list.data.find((t) => t.title === `${P} checkout with saved card`)
    // `steps` were removed from the product — description + expectedResult are the body now.
    return tc && typeof tc.description === 'string' && tc.description.length > 0 && !!tc.expectedResult
  })())
  check('imported case carries tags', (() => {
    const tc = list.data.find((t) => t.title === `${P} checkout with saved card`)
    return tc && tc.tags.includes('smoke') && tc.tags.includes('import')
  })())
  check('imported cases are drafts', list.data.filter((t) => t.title.startsWith(`${P} `)).every((t) => t.status === 'draft'))
  check('imported case author is the importer', list.data
    .filter((t) => t.title.startsWith(`${P} `))
    .every((t) => t.author?.fullName === qa.user.fullName))

  // ---------- 6. permission boundary ----------
  const devRes = await fetch(`${BASE}/api/test-cases?action=import`, {
    method: 'POST',
    headers: H(dev.token),
    body: JSON.stringify({ moduleId: target.moduleId, fileName: 'x.csv', csv: 'title\ncase-x' }),
  })
  check('POST import -> 403 (developer, not granted)', devRes.status === 403)
  const anonRes = await fetch(`${BASE}/api/test-cases?action=import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ moduleId: target.moduleId, fileName: 'x.csv', csv: 'title\ncase-x' }),
  })
  check('POST import -> 401 (anonymous)', anonRes.status === 401)

  // ---------- 7. bad requests ----------
  const noModule = await fetch(`${BASE}/api/test-cases?action=import`, {
    method: 'POST', headers: H(qa.token),
    body: JSON.stringify({ moduleId: 'not-a-real-module', fileName: 'x.csv', csv: 'title\nabc' }),
  })
  check('import into missing module -> 404', noModule.status === 404)
  const noTitleCol = await fetch(`${BASE}/api/test-cases?action=import`, {
    method: 'POST', headers: H(qa.token),
    body: JSON.stringify({ moduleId: target.moduleId, fileName: 'x.csv', csv: 'name,desc\nabc,def' }),
  })
  check('CSV without title column -> 400', noTitleCol.status === 400)
  const headerOnly = await fetch(`${BASE}/api/test-cases?action=import`, {
    method: 'POST', headers: H(qa.token),
    body: JSON.stringify({ moduleId: target.moduleId, fileName: 'x.csv', csv: 'title,steps\n' }),
  })
  check('CSV with no data rows -> 400', headerOnly.status === 400)
  const wrongExt = await fetch(`${BASE}/api/test-cases?action=import`, {
    method: 'POST', headers: H(qa.token),
    body: JSON.stringify({ moduleId: target.moduleId, fileName: 'x.xlsx', csv: 'title\nabc' }),
  })
  check('non-csv file name -> 400', wrongExt.status === 400)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
