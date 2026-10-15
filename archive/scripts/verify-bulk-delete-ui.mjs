/**
 * Browser-level verification for the bulk-delete toolbar redesign:
 *  - filters stay visible at all times (never replaced by a selection bar)
 *  - Delete / Clear buttons exist on load, disabled with no selection
 *  - row checkboxes are fully visible WITHOUT hover
 *  - ticking rows causes ZERO layout shift (table top & toolbar box identical)
 *  - selecting enables Delete/Clear; Clear resets; confirm dialog opens
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

// --- login -----------------------------------------------------------------
await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', 'admin@tcms.com')
await page.fill('input[type="password"]', 'Admin@123')
await page.click('button[type="submit"]')
await page.waitForURL('**/dashboard', { timeout: 20000 })
await page.goto(BASE + '/test-cases', { waitUntil: 'networkidle' })
await page.waitForSelector('tbody tr', { timeout: 20000 })

// --- 1. filters always visible ---------------------------------------------
check('search input visible', await page.getByPlaceholder('Search by title...').isVisible())
const selects = page.locator('[data-slot="select-trigger"]')
check('3 filter selects visible on load', (await selects.count()) === 3, `count=${await selects.count()}`)

// --- 2. permanent, disabled action row --------------------------------------
const deleteBtn = page.getByRole('button', { name: 'Delete', exact: true })
const clearBtn = page.getByRole('button', { name: 'Clear', exact: true })
check('Delete button present with empty selection', (await deleteBtn.count()) === 1)
check('Clear button present with empty selection', (await clearBtn.count()) === 1)
check('Delete disabled on load', await deleteBtn.isDisabled())
check('Clear disabled on load', await clearBtn.isDisabled())
check('idle hint "No test cases selected" shown', await page.getByText('No test cases selected').isVisible())

// --- 3. checkbox visibility without hover ------------------------------------
const rowCb = page.locator('tbody button[role="checkbox"]').first()
check('row checkbox rendered', (await rowCb.count()) === 1)
const opacity = await rowCb.evaluate((el) => getComputedStyle(el).opacity)
check('row checkbox fully visible without hover', opacity === '1', `opacity=${opacity}`)
const borderColor = await rowCb.evaluate((el) => getComputedStyle(el).borderTopColor)
check('row checkbox has a strong border', borderColor !== 'rgba(0, 0, 0, 0)', borderColor)

// --- 4. zero layout shift when selecting -------------------------------------
const measure = () => ({
  tableTop: null, toolbarTop: null, toolbarH: null, searchTop: null,
})
const before = await page.evaluate(() => {
  const table = document.querySelector('table')
  const search = document.querySelector('input[placeholder="Search by title..."]')
  const toolbar = search.closest('[data-slot="card"]')
  const r = (el) => el.getBoundingClientRect()
  return { tableTop: r(table).top, toolbarTop: r(toolbar).top, toolbarH: r(toolbar).height, searchTop: r(search).top }
})

await rowCb.click()
await page.waitForTimeout(400)

const after = await page.evaluate(() => {
  const table = document.querySelector('table')
  const search = document.querySelector('input[placeholder="Search by title..."]')
  const toolbar = search.closest('[data-slot="card"]')
  const r = (el) => el.getBoundingClientRect()
  return { tableTop: r(table).top, toolbarTop: r(toolbar).top, toolbarH: r(toolbar).height, searchTop: r(search).top }
})

check('table did not move when selecting (zero shift)', Math.abs(before.tableTop - after.tableTop) < 0.5, `Δ=${Math.abs(before.tableTop - after.tableTop).toFixed(2)}px`)
check('toolbar card did not move/resize', Math.abs(before.toolbarTop - after.toolbarTop) < 0.5 && Math.abs(before.toolbarH - after.toolbarH) < 0.5, `Δtop=${Math.abs(before.toolbarTop - after.toolbarTop).toFixed(2)} Δh=${Math.abs(before.toolbarH - after.toolbarH).toFixed(2)}`)
check('filter search box did not move', Math.abs(before.searchTop - after.searchTop) < 0.5, `Δ=${Math.abs(before.searchTop - after.searchTop).toFixed(2)}px`)
check('filters still visible while selecting', (await selects.count()) === 3 && (await page.getByPlaceholder('Search by title...').isVisible()))
check('Delete enabled after selection', await deleteBtn.isEnabled())
check('Clear enabled after selection', await clearBtn.isEnabled())
check('count pill shows 1 selected', await page.getByText('test case selected', { exact: true }).isVisible())

// --- 5. select all -> count updates, still zero shift ------------------------
const topAfterFirst = after.tableTop
await page.locator('thead button[role="checkbox"]').first().click()
await page.waitForTimeout(300)
check('select-all ticks every row', await page.getByText('test cases selected', { exact: true }).isVisible())
const tableTopAll = await page.evaluate(() => document.querySelector('table').getBoundingClientRect().top)
check('still zero shift after select-all', Math.abs(topAfterFirst - tableTopAll) < 0.5, `Δ=${Math.abs(topAfterFirst - tableTopAll).toFixed(2)}px`)

// --- 6. Clear resets selection ------------------------------------------------
await clearBtn.click()
await page.waitForTimeout(300)
check('Clear empties selection (hint back)', await page.getByText('No test cases selected').isVisible())
check('Delete disabled again after Clear', await deleteBtn.isDisabled())

// --- 7. Delete opens confirm dialog, Cancel closes ----------------------------
await rowCb.click()
await page.waitForTimeout(200)
await deleteBtn.click()
await page.waitForTimeout(400)
const dialog = page.locator('[role="alertdialog"], [role="dialog"]')
check('confirm dialog opens', (await dialog.count()) >= 1)
check('dialog warns "This cannot be undone."', await page.getByText('This cannot be undone.').isVisible())
await page.getByRole('button', { name: 'Cancel' }).click()
await page.waitForTimeout(300)
check('cancel keeps selection intact', await page.getByText('test case selected', { exact: true }).isVisible())

await browser.close()
console.log(failures === 0 ? '\nRESULT: ALL BULK-DELETE UI CHECKS GREEN' : `\nRESULT: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
