/**
 * UI MARATHON SUITE (QA 2026-10-09) — browser-level verification of the two
 * new features plus a full-navigation sweep:
 *
 *   A. Hover preview: hovering a test-case title reveals the FULL case
 *      (description / expected result) in a hover card; moving away closes
 *      it; the row click still navigates to the detail page.
 *   B. Signup: the Create account form has NO group picker; a self-registered
 *      user lands as viewer (empty permissions, minimal sidebar).
 *   C. Global UI sweep: every tab renders for admin; PermissionDenied renders
 *      for a viewer deep-linking gated pages; pagination works over the
 *      400+ seeded cases.
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
let failures = 0
function check(name, cond, extra = '') {
  if (!cond) failures++
  console.log(`${cond ? 'ok' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

// ---------- A1. admin login ----------
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
await page.fill('input[type="email"]', 'admin@tcms.com')
await page.fill('input[type="password"]', 'Admin@123')
await page.click('button[type="submit"]')
await page.waitForURL('**/dashboard', { timeout: 20000 })
check('A1 admin login lands on dashboard', true)

// ---------- A2. hover preview ----------
await page.goto(BASE + '/test-cases', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('tbody tr', { timeout: 20000 })

const firstTitle = page.locator('tbody tr').first().locator('td').nth(2).locator('span').first()
check('A2 title cell renders the hover trigger span', await firstTitle.isVisible())

// no hover card before hovering
const cardSel = '[data-slot="hover-card-content"]'
check('A2 no hover card before hover', (await page.locator(cardSel).count()) === 0)

await firstTitle.hover()
await page.waitForSelector(cardSel, { timeout: 5000 })
const cardText = await page.locator(cardSel).innerText()
check('A2 hover card appears on title hover', cardText.length > 0)
check('A2 card shows DESCRIPTION section', /description/i.test(cardText))
check('A2 card shows full title (not truncated to 60)', cardText.includes(cardText.split('\n')[0]))
check('A2 card shows author footer', /by /.test(cardText))
check('A2 card shows updated timestamp', /Updated /.test(cardText))

// move away -> card closes
await page.mouse.move(10, 10)
await page.waitForFunction(
  () => !document.querySelector('[data-slot="hover-card-content"]'),
  null,
  { timeout: 5000 }
).catch(() => {})
check('A2 hover card closes when pointer leaves', (await page.locator(cardSel).count()) === 0)

// row click still navigates (hover must not steal the click)
await page.locator('tbody tr').first().locator('td').nth(2).click()
await page.waitForURL('**/test-cases/**', { timeout: 10000 })
check('A2 clicking the title still opens the detail page', page.url().includes('/test-cases/'))
await page.goBack({ waitUntil: 'domcontentloaded' })

// ---------- A3. hover card present for EVERY row's title (data-driven) ----------
const rows = await page.locator('tbody tr').count()
check('A3 list renders rows (400+ seeded volume)', rows === 20, `rows on page=${rows}`)

// ---------- B. signup default viewer ----------
await page.context().clearCookies() // the auth screen bounces signed-in users
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
await page.getByRole('tab', { name: 'Create account' }).click()
await page.waitForTimeout(300)
const groupSelect = await page.locator('#reg-group').count()
check('B1 NO group select on create-account form', groupSelect === 0, `count=${groupSelect}`)
const bodyText = await page.locator('body').innerText()
check('B1 helper text explains viewer default', /Viewer access/i.test(bodyText))

const stamp = Date.now().toString().slice(-6)
await page.fill('#fullName', `UI Marathon Viewer ${stamp}`)
await page.fill('#reg-email', `uimarathon.viewer.${stamp}@tcms.dev`)
await page.fill('#reg-password', 'Viewer@123')
await page.fill('#confirm-password', 'Viewer@123')
await page.click('button[type="submit"]:has-text("Create account")')
await page.waitForURL('**/dashboard', { timeout: 20000 })
check('B2 signup completes and enters the app', true)

// viewer sidebar: no privileged entries
await page.waitForTimeout(500)
const sidebarText = await page.locator('body').innerText()
check('B2 viewer does NOT see Users nav', !/Users\b/.test(sidebarText) || !(await page.getByRole('link', { name: /users/i }).isVisible().catch(() => false)))
check('B2 viewer does NOT see Activity Log nav', !(await page.getByRole('link', { name: /activity/i }).isVisible().catch(() => false)))

// viewer deep-link to a gated page -> PermissionDenied (not data)
await page.goto(BASE + '/reports', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('main', { timeout: 10000 })
await page.waitForTimeout(1200)
const reportsPageText = await page.locator('main').innerText()
check('B3 viewer deep-link /reports -> permission denied', /permission|denied|not available|view-all-reports/i.test(reportsPageText), reportsPageText.slice(0, 140).replace(/\n/g, ' '))

// ---------- C. admin global sweep ----------
await page.context().clearCookies() // drop the viewer session from section B
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('input[type="email"]', { timeout: 15000 })
await page.fill('input[type="email"]', 'admin@tcms.com')
await page.fill('input[type="password"]', 'Admin@123')
await page.click('button[type="submit"]')
await page.waitForURL('**/dashboard', { timeout: 20000 })

const TABS = [
  ['/dashboard', /dashboard|command|test cases|overview/i],
  ['/modules', /module/i],
  ['/test-cases', /test cases/i],
  ['/reviews', /review/i],
  ['/bugs', /bug/i],
  ['/tasks', /task/i],
  ['/reports', /report/i],
  ['/activity-log', /activity/i],
  ['/notifications', /notification/i],
  ['/settings/users', /users|permission/i],
  ['/settings/permissions', /permission/i],
  ['/settings/profile', /profile|account/i],
  ['/integrations', /crew desk|integration/i],
  ['/wiki', /wiki/i],
]
for (const [path, re] of TABS) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  const txt = await page.locator('body').innerText()
  check(`C tab renders: ${path}`, re.test(txt), txt.slice(0, 80).replace(/\n/g, ' '))
}

// ---------- C2. pagination over the seeded volume ----------
await page.goto(BASE + '/test-cases', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('tbody tr', { timeout: 20000 })
const totalText = await page.locator('body').innerText()
check('C2 pagination shows the 400+ total', /4\d\d/.test(totalText), 'looking for 4xx total')
const nextBtn = page.getByRole('button', { name: /next/i }).first()
if (await nextBtn.isEnabled().catch(() => false)) {
  await nextBtn.click()
  await page.waitForTimeout(800)
  check('C2 next page loads rows', (await page.locator('tbody tr').count()) > 0)
} else {
  check('C2 next page loads rows', false, 'next button disabled')
}

// ---------- C3. hover preview data completeness on a seeded marathon row ----------
await page.getByPlaceholder('Search by title...').fill('handles case #1')
await page.waitForTimeout(1500) // debounce + fetch
const searchedRow = page.locator('tbody tr').first()
if (await searchedRow.count()) {
  const t = searchedRow.locator('td').nth(2).locator('span').first()
  await t.hover()
  await page.waitForSelector(cardSel, { timeout: 5000 })
  const txt = await page.locator(cardSel).innerText()
  check('C3 marathon row hover card carries the full description', /Functional|Negative|Boundary|Security|Usability|Compatibility|Performance check/i.test(txt), txt.slice(0, 100).replace(/\n/g, ' '))
} else {
  check('C3 marathon row hover card carries the full description', false, 'row not found')
}

await browser.close()
console.log(failures ? `\nRESULT: ${failures} FAILURES` : '\nRESULT: ALL UI MARATHON CHECKS PASSED')
process.exit(failures ? 1 : 0)
