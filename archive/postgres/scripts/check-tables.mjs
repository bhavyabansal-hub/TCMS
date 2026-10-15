import pg from '/home/z/my-project/node_modules/pg/lib/index.js'
const c = new pg.Client({ connectionString: 'postgresql://tcms:tcms@localhost:5499/tcms' })
await c.connect()
for (const t of ['users','modules','test_cases','crew_desk_links','login_attempts']) {
  const r = await c.query('SELECT count(*)::int AS n FROM ' + t)
  console.log(t, r.rows[0].n)
}
await c.end()
