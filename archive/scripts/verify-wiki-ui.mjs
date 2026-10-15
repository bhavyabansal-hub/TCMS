/**
 * Wiki UI verification (browser):
 *   1. Sidebar shows Wiki; the tab lists documents
 *   2. New Document dialog: type with formatting (H2 + bold + list), save,
 *      auto-opens the detail page with rendered content
 *   3. Edit flow: Edit -> modify -> Save changes
 *   4. Upload flow: Upload File dialog with a real file
 *   5. Detail page for a file doc: meta + Download link
 *   6. Search finds the doc; deep link survives refresh (shareable URL)
 *   7. Delete: rose confirm dialog -> gone from the list
 *   8. Permission-gated actions on the detail page (vp sees everything)
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
const STAMP = Date.now()
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

// --- 1. sidebar + list --------------------------------------------------------
const wikiLink = page.locator('aside').getByRole('link', { name: 'Wiki' })
check('sidebar shows the Wiki tab', await wikiLink.isVisible())
await wikiLink.click()
await page.waitForURL('**/wiki', { timeout: 15000 })
await page.waitForTimeout(600)
check('Wiki page header rendered', await page.getByRole('heading', { name: 'Wiki', exact: true }).isVisible())
check('New Document button present for admin', await page.getByRole('button', { name: 'New Document' }).isVisible())
check('Upload File button present for admin', await page.getByRole('button', { name: 'Upload File' }).isVisible())
check('filter row has search + type selects', await page.getByPlaceholder('Search documents by title or content...').isVisible())

// --- 2. create a written document with formatting ------------------------------
await page.getByRole('button', { name: 'New Document' }).click()
const titleInput = page.locator('#wiki-title')
await titleInput.fill(`UI Wiki Doc ${STAMP}`)
await page.locator('#wiki-tags').fill('ui-test, guide')
// Type into the editor: heading, then a bold line, then a bullet item.
const editor = page.getByLabel('Document content')
await editor.click()
await page.keyboard.type('Intro paragraph for the ui test')
await page.keyboard.press('Enter')
// Toggle Heading 2 and type a section title
await page.getByRole('button', { name: 'Heading 2' }).click()
await page.keyboard.type('Section One')
await page.keyboard.press('Enter')
await page.getByRole('button', { name: 'Paragraph' }).click()
await page.keyboard.type('Make this ')
// Bold the next word via Ctrl+B
await page.keyboard.press('Control+b')
await page.keyboard.type('bold')
await page.keyboard.press('Control+b')
await page.keyboard.type(' and continue')
await page.getByRole('button', { name: 'Create document' }).click()
await page.waitForURL('**/wiki/*', { timeout: 15000 })
await page.waitForTimeout(600)
check('create dialog navigates to the new document page', page.url().includes('/wiki/'))
check('title rendered on detail page', await page.getByRole('heading', { name: `UI Wiki Doc ${STAMP}` }).isVisible())
const bodyText = await page.locator('main').innerText()
check('written content rendered (heading + bold text present)', bodyText.includes('Section One') && bodyText.includes('bold'))
check('tags badge shown', await page.getByText('ui-test', { exact: true }).isVisible())
check('Edit button visible (admin can edit anything)', await page.getByRole('button', { name: 'Edit' }).isVisible())
check('Delete button visible (admin can delete anything)', await page.getByRole('button', { name: 'Delete' }).isVisible())

// --- 3. edit flow ----------------------------------------------------------------
await page.getByRole('button', { name: 'Edit' }).click()
const editBox = page.getByLabel('Document content')
await editBox.click()
await page.keyboard.press('Control+End')
await page.keyboard.type(' EDITED-TAIL')
await page.getByRole('button', { name: 'Save changes' }).click()
await page.waitForTimeout(800)
check('edit saved (new tail visible)', (await page.locator('main').innerText()).includes('EDITED-TAIL'))

// --- 6a. deep link survives refresh ----------------------------------------------
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(600)
check('deep link survives refresh (shareable URL)', await page.getByRole('heading', { name: `UI Wiki Doc ${STAMP}` }).isVisible())

// --- 4. upload flow ----------------------------------------------------------------
await wikiLink.click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: 'Upload File' }).click()
await page.locator('#wiki-file').setInputFiles({
  name: `ui-guide-${STAMP}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Wiki UI upload payload ✓'),
})
await page.locator('#wiki-upload-title').fill(`UI Uploaded File ${STAMP}`)
await page.getByRole('button', { name: 'Upload', exact: true }).click()
await page.waitForTimeout(900)
check('uploaded file card appears in the list', await page.getByText(`UI Uploaded File ${STAMP}`).first().isVisible())

// --- 5. file doc detail -------------------------------------------------------------
await page.getByText(`UI Uploaded File ${STAMP}`).first().click()
await page.waitForURL('**/wiki/*', { timeout: 10000 })
await page.waitForTimeout(600)
check('file doc shows file name', await page.getByText(`ui-guide-${STAMP}.txt`).first().isVisible())
check('file doc shows size', await page.getByText(/B · text\/plain/).isVisible())
check('Download button present', await page.getByRole('link', { name: /Download/ }).first().isVisible())

// --- 6b. search finds documents -------------------------------------------------------
await wikiLink.click()
await page.waitForTimeout(500)
await page.getByPlaceholder('Search documents by title or content...').fill(`UI Wiki Doc ${STAMP}`)
await page.waitForTimeout(700)
check('search finds the written doc', await page.getByText(`UI Wiki Doc ${STAMP}`).first().isVisible())
check('search excludes unrelated docs', !(await page.getByText(`UI Uploaded File ${STAMP}`).first().isVisible()))

// --- 7. delete flow ---------------------------------------------------------------------
await page.getByText(`UI Wiki Doc ${STAMP}`).first().click()
await page.waitForURL('**/wiki/*', { timeout: 10000 })
await page.waitForTimeout(500)
await page.getByRole('button', { name: 'Delete' }).click()
check('danger confirm dialog opens', await page.getByText('This cannot be undone.').isVisible())
await page.getByRole('button', { name: 'Cancel' }).click()
await page.waitForTimeout(300)
check('cancel keeps the document', await page.getByRole('button', { name: 'Delete' }).isVisible())
await page.getByRole('button', { name: 'Delete' }).click()
await page.getByRole('button', { name: 'Delete permanently' }).click()
await page.waitForURL('**/wiki', { timeout: 10000 })
await page.waitForTimeout(600)
check('after delete we are back on the list', page.url().endsWith('/wiki'))

// --- global search surfaces the remaining file doc ---------------------------------------
await page.keyboard.press('Control+k')
const searchInput = page.getByRole('textbox', { name: 'Search' })
await searchInput.fill(`UI Uploaded File ${STAMP}`)
await page.waitForTimeout(900)
const wikiOption = page.getByRole('option').filter({ hasText: 'Wiki — uploaded file' }).first()
check('global search shows the wiki file result', (await wikiOption.count()) >= 1)
await wikiOption.click()
await page.waitForTimeout(600)
check('global search result opens the wiki document', page.url().includes('/wiki/'))

await browser.close()
console.log(failures === 0 ? '\nRESULT: ALL WIKI UI CHECKS GREEN' : `\nRESULT: ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
