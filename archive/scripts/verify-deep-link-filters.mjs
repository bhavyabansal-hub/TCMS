/**
 * Browser-level verification for deep-linked filters:
 *  1. Module detail "View all" → /test-cases?moduleId=… with the module
 *     filter pre-applied (select shows the module, rows are filtered).
 *  2. Hard refresh of the deep link keeps the filter (shareable URL).
 *  3. Reset button: disabled on clean list, enabled with filters, clears
 *     everything and cleans the URL query.
 *  4. Global search: module result jumps to the module detail page.
 *  5. Bulk-delete UI regression still green (zero shift, permanent row).
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

// --- login -------------------------------------------------------------------
await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', 'admin@tcms.com')
await page.fill('input[type="password"]', 'Admin@123')
await page.click('button[type="submit"]')
await page.waitForURL('**/dashboard', { timeout: 20000 })

// Pick a module that actually has test cases (from the API the UI itself uses).
const listRes = await page.request.get(BASE + '/api/test-cases?page=1&pageSize=5')
const list = await listRes.json()
const firstCase = list?.data?.[0]
check('seed data present (>=1 test case via API)', !!firstCase)
const moduleId = firstCase?.moduleId

// --- 1. module detail → "View all" → filtered test cases ----------------------
await page.goto(`${BASE}/modules/${moduleId}`, { waitUntil: 'networkidle' })
const viewAll = page.getByRole('button', { name: /View all/ }).first()
check('module detail shows "View all" button', await viewAll.isVisible())
await viewAll.click()
await page.waitForURL('**/test-cases?moduleId=*', { timeout: 15000 })
const url1 = page.url()
check('View all lands on /test-cases?moduleId=…', url1.includes(`moduleId=${moduleId}`), url1)
await page.waitForSelector('tbody tr', { timeout: 15000 })
await page.waitForTimeout(500)

const triggerText = await page.locator('[data-slot="select-trigger"]').nth(2).textContent()
check('module filter select shows the module (not "All modules")', !!triggerText && !/All modules/.test(triggerText), triggerText?.trim())

const tableTop1 = await page.evaluate(() => document.querySelector('table')?.getBoundingClientRect().top ?? -1)

// --- 2. hard refresh keeps the deep-linked filter ------------------------------
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('tbody tr', { timeout: 15000 })
const triggerText2 = await page.locator('[data-slot="select-trigger"]').nth(2).textContent()
check('hard refresh keeps module filter (shareable URL)', !!triggerText2 && !/All modules/.test(triggerText2), triggerText2?.trim())

// --- 3. Reset button -----------------------------------------------------------
const resetBtn = page.getByRole('button', { name: /Reset/ })
check('Reset button present in filter row', await resetBtn.isVisible())
check('Reset enabled while a filter is active', await resetBtn.isEnabled())
await resetBtn.click()
await page.waitForTimeout(700)
check('Reset cleans the URL query', !page.url().includes('moduleId'), page.url())
const triggerText3 = await page.locator('[data-slot="select-trigger"]').nth(2).textContent()
check('Reset restores the unfiltered module select (placeholder)', triggerText3?.trim() === 'Module', triggerText3?.trim())
check('Reset disabled on the clean list', await resetBtn.isDisabled())

// --- 4. global search: module result → module detail ---------------------------
await page.keyboard.press('Control+k')
const searchInput = page.getByRole('textbox', { name: 'Search' })
await searchInput.waitFor({ state: 'visible', timeout: 5000 })
const modName = (list?.data?.[0]?.module?.name) || 'Test'
// Fetch the module name from the API result of the search itself.
await searchInput.fill(modName.length > 1 ? modName : 'Test')
await page.waitForTimeout(900)
const moduleResult = page.getByRole('option').filter({ hasText: /Module$/ }).first()
const hasModuleResult = await moduleResult.count()
if (hasModuleResult > 0) {
  await moduleResult.click()
  await page.waitForTimeout(700)
  check('global search module result opens module detail', /\/modules\/[0-9a-f-]{36}/.test(page.url()), page.url())
} else {
  check('global search module result opens module detail', false, 'no module result rendered for query')
}

// --- 5. bulk-delete UI regression ----------------------------------------------
await page.goto(BASE + '/test-cases', { waitUntil: 'networkidle' })
await page.waitForSelector('tbody tr', { timeout: 15000 })
const deleteBtn = page.getByRole('button', { name: 'Delete', exact: true })
const clearBtn = page.getByRole('button', { name: 'Clear', exact: true })
check('bulk delete: Delete/Clear still permanent + disabled on load', (await deleteBtn.count()) === 1 && (await deleteBtn.isDisabled()) && (await clearBtn.isDisabled()))
const rowCb = page.locator('tbody button[role="checkbox"]').first()
const beforeTop = await page.evaluate(() => document.querySelector('table').getBoundingClientRect().top)
await rowCb.click()
await page.waitForTimeout(300)
const afterTop = await page.evaluate(() => document.querySelector('table').getBoundingClientRect().top)
check('bulk delete: zero layout shift on select (Δ<0.5px)', Math.abs(beforeTop - afterTop) < 0.5, `Δ=${Math.abs(beforeTop - afterTop).toFixed(2)}px`)
check('bulk delete: filters still visible while selecting', (await page.locator('[data-slot="select-trigger"]').count()) === 3)
await browser.close()

console.log(failures === 0 ? '\nRESULT: ALL DEEP-LINK + RESET CHECKS GREEN' : `\nRESULT: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
