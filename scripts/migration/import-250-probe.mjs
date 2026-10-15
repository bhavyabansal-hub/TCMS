// Bulk-import probe on MySQL: 200 rows (at the cap) must import; 250+ rows
// must be cleanly rejected with the documented cap message (strict, no
// silent truncation). Cleans up after itself.
const BASE = 'http://localhost:3000'

async function main() {
  const login = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }),
  })
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error('login failed')

  const mod = await fetch(`${BASE}/api/modules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', cookie },
    body: JSON.stringify({ name: 'Import bulk probe 🧪', description: 'mysql migration 250-row check' }),
  })
  const modBody = await mod.json()
  const moduleId = modBody?.moduleId ?? modBody?.module?.moduleId ?? modBody?.data?.module?.moduleId
  if (!moduleId) throw new Error('module create failed: ' + JSON.stringify(modBody).slice(0, 200))

  function csv(n) {
    const rows = []
    for (let i = 1; i <= n; i++) {
      rows.push(`Bulk probe case ${i} हिन्दी ${'x'.repeat(10)},Description row ${i} 🧪,Precond ${i},Expected ${i},P${i % 4},bulk;probe${i}`)
    }
    return 'title,description,preconditions,expectedResult,priority,tags\n' + rows.join('\n')
  }

  async function imp(n) {
    const res = await fetch(`${BASE}/api/test-cases?action=import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, 'X-Requested-With': 'tcms' },
      body: JSON.stringify({ moduleId, fileName: 'probe.csv', csv: csv(n) }),
    })
    return { status: res.status, body: await res.text() }
  }

  const atCap = await imp(200)
  const atCapOk = atCap.status === 200 || atCap.status === 201
  console.log(`200 rows (at cap): ${atCap.status} -> ${atCapOk ? 'OK' : atCap.body.slice(0, 200)}`)

  const overCap = await imp(250)
  const overCapRejected = overCap.status === 400
  console.log(`250 rows (over cap): ${overCap.status} -> ${overCapRejected ? 'correctly rejected (strict)' : overCap.body.slice(0, 200)}`)

  // cleanup: delete the probe module (cascades to its cases)
  await fetch(`${BASE}/api/modules?id=${moduleId}`, {
    method: 'DELETE', headers: { cookie, 'X-Requested-With': 'tcms' },
  })
  console.log(`RESULT: ${atCapOk && overCapRejected ? 'PASS' : 'FAIL'} (200-at-cap=${atCapOk}, 250-rejected=${overCapRejected})`)
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
