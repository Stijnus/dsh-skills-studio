#!/usr/bin/env node
/**
 * Independent UI end-to-end verification for dsh-skills-manager (playwright-core).
 *
 * Drives the real Settings > Skills section of a scratch DSH web instance:
 * Installed/Available tabs, Add/Edit/Delete through the form, duplicate-name
 * blocked before save, library install, keyboard/a11y essentials, light+dark
 * screenshots. Writes a JSON report plus PNG evidence.
 *
 * The playwright-cli daemon cannot launch a browser inside this sandbox
 * (EPERM on its cache dir; Chrome sandbox init fails), so this script uses the
 * same installed playwright-core package with the system Chrome channel,
 * headless, --no-sandbox. That is real browser automation, not a DOM mock.
 *
 * Usage:
 *   node e2e-ui.cjs --url <scratch-url-with-token> --writable <dir> \
 *     --screenshots <dir> --out <file> [--plugin-skill plugin-only] [--remove-before ds-unslop]
 */
const fs = require('node:fs')
const path = require('node:path')

const PLAYWRIGHT_CORE = '/Users/stijnus/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`)
    out[key] = value
    i++
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const URL = args.url
const WRITABLE = args.writable
const SHOTS = args.screenshots
const OUT = args.out
const PLUGIN_SKILL = args['plugin-skill'] ?? 'plugin-only'
const REMOVE_BEFORE = args['remove-before'] ?? 'ds-unslop'
const UNIQUE = `e2e-ui-${Date.now().toString(36)}`
if (!URL || !WRITABLE || !SHOTS || !OUT) {
  console.error('usage: node e2e-ui.cjs --url URL --writable DIR --screenshots DIR --out FILE [--plugin-skill NAME] [--remove-before NAME]')
  process.exit(2)
}
fs.mkdirSync(SHOTS, { recursive: true })

const results = []
const consoleErrors = []
const pageErrors = []
const apiLog = []
const startedAt = new Date().toISOString()

function record(id, expected, observed, pass, evidence) {
  results.push({ id, expected, observed, pass, ...(evidence ? { evidence } : {}) })
  console.log(`${pass ? 'PASS' : 'FAIL'} ui/${id}${pass ? '' : ` — expected ${JSON.stringify(expected)} observed ${JSON.stringify(observed)}`}`)
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  return file
}

async function ensureSkillsOpen(page) {
  const root = page.locator('[role="dialog"] .dsm-root')
  if ((await root.count()) === 0 || !(await root.first().isVisible().catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.waitForTimeout(400)
    await page.getByRole('menuitem', { name: /Settings/ }).click()
    await page.waitForTimeout(1000)
    await page.getByRole('dialog').getByRole('button', { name: 'Skills', exact: true }).click()
    await root.waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(600)
  }
  return root
}

async function openSkillsSection(page) {
  // First-run modals: preview notice, then the auth "Get started" dialog.
  const cont = page.getByRole('button', { name: 'Continue' })
  if (await cont.count()) {
    await cont.first().click().catch(() => {})
    await page.waitForTimeout(400)
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.waitForTimeout(500)
  await page.getByRole('menuitem', { name: /Settings/ }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('dialog').getByRole('button', { name: 'Skills', exact: true }).click()
  await page.locator('.dsm-root').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(800)
}

let pageRef = null;
let browserRef = null;
let sawEditorAlertRole = false;

(async () => {
  const { chromium } = require(PLAYWRIGHT_CORE)

  const librarySkillDir = path.join(WRITABLE, REMOVE_BEFORE)
  // Pre-clean leftovers from an earlier failed run.
  for (const leftover of [UNIQUE, 'e2e-ui-skill']) {
    fs.rmSync(path.join(WRITABLE, leftover), { recursive: true, force: true })
  }

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  browserRef = browser
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const page = await context.newPage()
  pageRef = page
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500)) })
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 500)))
  page.on('response', (response) => {
    const url = response.url()
    if (url.includes('/skills-manager/api/')) {
      apiLog.push({ method: response.request().method(), url: url.replace(/^https?:\/\/[^/]+/, ''), status: response.status() })
    }
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3500)
  await openSkillsSection(page)

  const root = page.locator('[role="dialog"] .dsm-root')
  await root.waitFor({ state: 'visible' })

  // ------------------------------------------------------------- section
  {
    const navSkills = await page.getByRole('dialog').getByRole('button', { name: 'Skills', exact: true }).count()
    const eyebrow = (await root.locator('.dsm-eyebrow').first().innerText().catch(() => '')).trim().toLowerCase()
    record('section-registered', { navEntry: true, sectionVisible: true, eyebrow: 'agent skills' },
      { navEntry: navSkills > 0, sectionVisible: await root.isVisible(), eyebrow }, navSkills > 0 && (await root.isVisible()) && eyebrow === 'agent skills')
  }

  // --------------------------------------------------------------- stats
  {
    const values = await root.locator('.dsm-stat-value').allInnerTexts()
    const labels = await root.locator('.dsm-stat-label').allInnerTexts()
    // 49 copied user skills + 1 read-only fixture; available = 35 library skills + 1 plugin-only catalog entry.
    record('stats-strip', { installed: '50', available: '36', conflicts: '0' },
      { values, labels }, values[0] === '50' && values[1] === '36' && values[2] === '0')
  }

  // ----------------------------------------------------------- installed
  let initialRowCount = 0
  {
    const rows = root.locator('[data-dsm="skill-row"]')
    initialRowCount = await rows.count()
    const names = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-skill')))
    const dsCount = names.filter((name) => name && name.startsWith('ds-')).length
    const groupCounts = await root.locator('.dsm-group-count').allInnerTexts().catch(() => [])
    record('installed-rows', { total: 50, ds: 35 }, { total: initialRowCount, ds: dsCount, groupCounts },
      initialRowCount === 50 && dsCount === 35)
    const editButtons = await root.locator('button[aria-label^="Edit "]').count()
    const deleteButtons = await root.locator('button[aria-label^="Delete "]').count()
    const readOnlyTags = await root.getByText('Read-only', { exact: true }).count()
    record('writable-actions', { edit: 49, delete: 49, readOnlyTags: 1 },
      { editButtons, deleteButtons, readOnlyTags }, editButtons === 49 && deleteButtons === 49 && readOnlyTags === 1)
    const groupText = await root.innerText()
    record('root-group', { group: 'USER (.AGENTS)', count: '49 skills', readonlyGroup: '1 skill' },
      { hasGroup: groupText.includes('USER (.AGENTS)'), hasCount: groupText.includes('49 skills'), hasReadonlyGroup: groupText.includes('1 skill') },
      groupText.includes('USER (.AGENTS)') && groupText.includes('49 skills') && groupText.includes('1 skill'))
    const installedShot = await shot(page, 'ui-installed-light')
    record('screenshot-installed', true, installedShot, true, { path: installedShot })
  }

  // ------------------------------------------------------------- available
  {
    await root.getByRole('tab', { name: 'Available' }).click()
    await page.waitForTimeout(1200)
    const text = await root.innerText()
    const cards = root.locator('[data-dsm="library-card"]')
    const cardCount = await cards.count()
    const dsCard = root.locator('[data-dsm="library-card"][data-library="deepseek-stack"]')
    const aliasCard = root.locator('[data-dsm="library-card"][data-library="deepseek-stack-aliases"]')
    const dsRows = await dsCard.locator('[data-dsm="library-row"]').count()
    const aliasRows = await aliasCard.locator('[data-dsm="library-row"]').count()
    const dsRowTexts = await dsCard.locator('[data-dsm="library-row"]').evaluateAll((elements) => elements.map((element) => element.innerText.toLowerCase()))
    const installedRows = dsRowTexts.filter((text) => /\binstalled\b/.test(text)).length
    record('available-libraries', { cards: 2, dsRows: 29, aliasRows: 6, installedRows: 29 },
      { cardCount, dsRows, aliasRows, installedRows },
      cardCount === 2 && dsRows === 29 && aliasRows === 6 && installedRows === 29)
    const catalogGroup = root.locator('[data-dsm="catalog-group"]')
    const pluginRowVisible = (await catalogGroup.count()) > 0 && (await catalogGroup.first().innerText()).includes(PLUGIN_SKILL)
    record('from-plugins', { heading: 'From plugins', pluginSkillRow: true },
      { count: await catalogGroup.count(), text: (await catalogGroup.count()) ? (await catalogGroup.first().innerText()).slice(0, 200) : '' , pluginRowVisible },
      text.includes('From plugins') && pluginRowVisible)
    const availableShot = await shot(page, 'ui-available-light')
    record('screenshot-available', true, availableShot, true, { path: availableShot })
  }

  // --------------------------------------------------------- install library
  {
    // Now remove one installed library copy from disk and refresh through the UI.
    fs.rmSync(librarySkillDir, { recursive: true, force: true })
    await root.getByRole('button', { name: 'Refresh' }).click()
    await page.waitForTimeout(1500)
    const statsAfterRemoval = await root.locator('.dsm-stat-value').allInnerTexts()
    await root.getByRole('tab', { name: 'Installed' }).click()
    await page.waitForTimeout(900)
    const installedRowsAfterRemoval = await root.locator('[data-dsm="skill-row"]').count()
    record('library-available-after-removal', { installedRows: 49, installedStat: '49' },
      { installedRowsAfterRemoval, statsAfterRemoval },
      installedRowsAfterRemoval === 49 && statsAfterRemoval[0] === '49')
    await root.getByRole('tab', { name: 'Available' }).click()
    await page.waitForTimeout(900)
    const installButton = root.locator(`button[aria-label="Install ${REMOVE_BEFORE}"]`)
    await installButton.waitFor({ state: 'visible', timeout: 10000 })
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/skills-manager/api/install'), { timeout: 20000 }),
      installButton.click(),
    ])
    await page.waitForTimeout(1500)
    const after = { exists: fs.existsSync(path.join(librarySkillDir, 'SKILL.md')) }
    record('install-library-skill', { httpStatus: 200, fileRestored: true },
      { httpStatus: response.status(), after }, response.status() === 200 && after.exists,
      { response: (await response.text()).slice(0, 400) })
    record('install-updates-status', { rowNoLongerInstallable: true },
      { installButtonCount: await root.locator(`button[aria-label="Install ${REMOVE_BEFORE}"]`).count() },
      (await root.locator(`button[aria-label="Install ${REMOVE_BEFORE}"]`).count()) === 0)
  }

  // ------------------------------------------------------------------ add
  {
    await root.getByRole('tab', { name: 'Installed' }).click()
    await page.waitForTimeout(1200)
    const addButton = root.getByRole('button', { name: 'Add a new skill' })
    await addButton.waitFor({ state: 'visible', timeout: 10000 })
    await addButton.click()
    await page.locator('#dsm-f-name').waitFor({ state: 'visible', timeout: 10000 })
    const focused = await page.evaluate(() => document.activeElement?.id ?? null)
    await page.locator('#dsm-f-name').fill(UNIQUE)
    await page.locator('#dsm-f-description').fill('Skill created by the independent UI E2E harness.')
    await page.locator('#dsm-f-body').fill('# ' + UNIQUE + '\n\nCreated through the Settings form.\n')
    await page.waitForTimeout(900)
    const editorText = await root.innerText()
    const addFormShot = await shot(page, 'ui-add-form-light')
    record('add-editor-focus', { focusedField: 'dsm-f-name', valid: true, screenshot: addFormShot },
      { focused, looksGood: editorText.includes('Looks good.') }, focused === 'dsm-f-name' && editorText.includes('Looks good.'), { path: addFormShot })
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/skills-manager/api/save'), { timeout: 20000 }),
      root.getByRole('button', { name: /^Save/ }).click(),
    ])
    await page.waitForTimeout(1500)
    const live = (await root.locator('[data-dsm="live"]').innerText().catch(() => '')).trim()
    const row = root.locator(`[data-dsm="skill-row"][data-skill="${UNIQUE}"]`)
    const onDisk = fs.existsSync(path.join(WRITABLE, UNIQUE, 'SKILL.md'))
    record('add-through-form', { httpStatus: 200, rowVisible: true, diskFile: true, live: 'Saved · agents can see it now' },
      { httpStatus: response.status(), live, onDisk, rowCount: await row.count() },
      response.status() === 200 && onDisk && (await row.count()) === 1)
    record('add-success-message', { contains: 'agents can see it now' }, { live }, live.includes('agents can see it now'))
    const stats = await root.locator('.dsm-stat-value').allInnerTexts()
    record('add-updates-count', { installed: '51' }, { stats }, stats[0] === '51')
    const addShot = await shot(page, 'ui-added-light')
    record('screenshot-added', true, addShot, true, { path: addShot })
  }

  // ----------------------------------------------------------------- edit
  {
    const row = root.locator(`[data-dsm="skill-row"][data-skill="${UNIQUE}"]`).first()
    await row.locator(`button[aria-label="Edit ${UNIQUE}"]`).click()
    await page.locator('#dsm-f-description').waitFor({ state: 'visible', timeout: 10000 })
    const nameDisabled = await page.locator('#dsm-f-name').isDisabled()
    await page.locator('#dsm-f-description').fill('Skill edited by the independent UI E2E harness.')
    await page.waitForTimeout(800)
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/skills-manager/api/save'), { timeout: 20000 }),
      root.getByRole('button', { name: /^Save/ }).click(),
    ])
    await page.waitForTimeout(1500)
    const updatedRow = root.locator(`[data-dsm="skill-row"][data-skill="${UNIQUE}"]`).first()
    const rowText = await updatedRow.innerText()
    record('edit-through-form', { nameDisabled: true, httpStatus: 200, descriptionUpdated: true },
      { nameDisabled, httpStatus: response.status(), rowText: rowText.slice(0, 120) },
      nameDisabled && response.status() === 200 && rowText.includes('Skill edited by the independent UI E2E harness.'))
  }

  // --------------------------------------- duplicate name blocked pre-save
  {
    const saveRequestsBefore = apiLog.filter((entry) => entry.url.includes('/api/save') && entry.method === 'POST').length
    await root.getByRole('button', { name: 'Add a new skill' }).click()
    await page.locator('#dsm-f-name').waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('#dsm-f-name').fill('dup-target')
    await page.locator('#dsm-f-description').fill('Attempt to create a duplicate name through the UI.')
    await page.waitForTimeout(1200)
    const blockingLists = root.locator('.dsm-errors[role="alert"]')
    sawEditorAlertRole = (await blockingLists.count()) > 0
    const blockingTexts = await blockingLists.evaluateAll((elements) => elements.map((element) => element.innerText))
    const blockingText = blockingTexts.join('\n')
    const saveButton = root.getByRole('button', { name: /^Save/ })
    const disabled = await saveButton.isDisabled()
    const saveRequestsAfter = apiLog.filter((entry) => entry.url.includes('/api/save') && entry.method === 'POST').length
    await saveButton.click({ force: true }).catch(() => {})
    await page.waitForTimeout(700)
    const saveRequestsFinal = apiLog.filter((entry) => entry.url.includes('/api/save') && entry.method === 'POST').length
    const blockedShot = await shot(page, 'ui-duplicate-blocked-light')
    record('duplicate-blocked-before-save', { blockingConflictsShown: true, saveDisabled: true, saveRequests: 0 },
      { blockingText: blockingText.slice(0, 200), saveDisabled: disabled, saveRequestsBefore, saveRequestsAfter, saveRequestsFinal, screenshot: blockedShot },
      /Blocking conflicts|Duplicate name/i.test(blockingText) && disabled && saveRequestsFinal === saveRequestsBefore,
      { blockingText, path: blockedShot })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    const stillEditing = await page.locator('#dsm-f-name').count()
    record('escape-cancels-editor', { editorClosed: true }, { stillEditing }, stillEditing === 0)
    await ensureSkillsOpen(page)
  }

  // --------------------------------------------------------------- delete
  {
    await ensureSkillsOpen(page)
    await root.getByRole('tab', { name: 'Installed' }).click().catch(() => {})
    await page.waitForTimeout(700)
    const row = root.locator(`[data-dsm="skill-row"][data-skill="${UNIQUE}"]`).first()
    await row.locator(`button[aria-label="Delete ${UNIQUE}"]`).click()
    await page.waitForTimeout(500)
    const confirmText = await root.locator('.dsm-confirm-text').first().innerText().catch(() => '')
    const deleteConfirmShot = await shot(page, 'ui-delete-confirm-light')
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/skills-manager/api/delete'), { timeout: 20000 }),
      root.locator(`button[aria-label="Confirm deleting ${UNIQUE}"]`).click(),
    ])
    await page.waitForTimeout(1500)
    const gone = (await root.locator(`[data-dsm="skill-row"][data-skill="${UNIQUE}"]`).count()) === 0
    const diskGone = !fs.existsSync(path.join(WRITABLE, UNIQUE))
    record('delete-through-form', { confirmText: `Delete "${UNIQUE}"? This removes the file(s).`, httpStatus: 200, rowGone: true, diskGone: true, screenshot: deleteConfirmShot },
      { confirmText, httpStatus: response.status(), gone, diskGone },
      confirmText.includes('This removes the file(s).') && response.status() === 200 && gone && diskGone, { path: deleteConfirmShot })
    // Regression check: the Installed tabpanel must stay mounted after a delete (the
    // earlier client build could leave a dead panel), and the tabs must still switch.
    const installedTabAfterDelete = root.getByRole('tab', { name: 'Installed' })
    const selectedAfterDelete = await installedTabAfterDelete.getAttribute('aria-selected')
    const rowsAfterDelete = await root.locator('[data-dsm="skill-row"]').count()
    await root.getByRole('tab', { name: 'Available' }).click()
    await page.waitForTimeout(700)
    const availableVisible = await root.locator('#dsm-panel-available').isVisible().catch(() => false)
    await root.getByRole('tab', { name: 'Installed' }).click()
    await page.waitForTimeout(700)
    record('delete-keeps-tabpanel', { installedSelected: 'true', rowsRemain: true, tabsStillWork: true },
      { selectedAfterDelete, rowsAfterDelete, availableVisible },
      selectedAfterDelete === 'true' && rowsAfterDelete > 0 && availableVisible === true)
  }

  // ------------------------------------------------- accessibility basics
  {
    await root.getByRole('button', { name: 'Add a new skill' }).click()
    await page.locator('#dsm-f-name').waitFor({ state: 'visible', timeout: 10000 })
    const labelled = await page.evaluate(() => {
      const ids = ['dsm-f-name', 'dsm-f-description', 'dsm-f-body', 'dsm-f-whenToUse']
      return ids.map((id) => {
        const element = document.getElementById(id)
        if (!element) return { id, present: false, label: null }
        const label = document.querySelector(`label[for="${id}"]`)
        return { id, present: true, label: label ? label.textContent.trim() : element.getAttribute('aria-label') }
      })
    })
    record('a11y-labelled-inputs', { allPresent: true, allLabelled: true }, labelled,
      labelled.every((field) => field.present && typeof field.label === 'string' && field.label.length > 0))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await ensureSkillsOpen(page)
    await root.getByRole('button', { name: 'Refresh skills' }).click()
    await page.waitForTimeout(900)
    const statusRoles = await root.evaluate((element) => ({
      live: element.querySelectorAll('[data-dsm="live"][role="status"],[data-dsm="live"][aria-live]').length,
      liveAria: [...element.querySelectorAll('[data-dsm="live"]')].map((node) => ({ role: node.getAttribute('role'), ariaLive: node.getAttribute('aria-live'), text: (node.innerText || '').slice(0, 80) })),
      tablist: element.querySelectorAll('[role="tablist"][aria-label]').length,
    }))
    record('a11y-announcements', { liveRegion: '>=1', tablist: 1, editorAlertRole: true },
      { ...statusRoles, editorAlertRole: sawEditorAlertRole },
      statusRoles.live >= 1 && statusRoles.tablist === 1 && sawEditorAlertRole === true)
    // Keyboard: the Installed tab keeps focus; ArrowRight switches to Available.
    const installedTab = root.getByRole('tab', { name: 'Installed' })
    await installedTab.focus()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(700)
    const availableSelected = await root.getByRole('tab', { name: 'Available' }).getAttribute('aria-selected')
    record('a11y-keyboard-tabs', { availableSelected: 'true' }, { availableSelected }, availableSelected === 'true')
  }

  // ------------------------------------------------------------ dark theme
  {
    await root.getByRole('tab', { name: 'Installed' }).click().catch(() => {})
    await page.waitForTimeout(600)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(900)
    const darkInstalled = await shot(page, 'ui-installed-dark')
    await root.getByRole('tab', { name: 'Available' }).click().catch(() => {})
    await page.waitForTimeout(600)
    const darkAvailable = await shot(page, 'ui-available-dark')
    record('theme-dark', true, { darkInstalled, darkAvailable }, true)
  }

  record('no-console-errors', { consoleErrors: 0, pageErrors: 0 }, { consoleErrors, pageErrors },
    consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors })
  record('api-no-errors', { all2xxOr4xxExpected: true }, { apiLog: apiLog.slice(-20) },
    apiLog.every((entry) => entry.status < 500), { apiLog })

  const passed = results.filter((result) => result.pass).length
  const failed = results.length - passed
  const report = {
    tool: 'e2e-ui.cjs',
    startedAt,
    generatedAt: new Date().toISOString(),
    url: URL.replace(/token=[^&]+/, 'token=REDACTED'),
    writable: WRITABLE,
    browser: 'playwright-core + system Chrome channel (headless, --no-sandbox)',
    note: 'playwright-cli daemon cannot launch a browser in this sandbox; playwright-core used with the same package.',
    uniqueSkill: UNIQUE,
    summary: { total: results.length, passed, failed },
    results,
    artifacts: { screenshots: fs.readdirSync(SHOTS).filter((name) => name.endsWith('.png')).sort() },
    apiLog,
    consoleErrors,
    pageErrors,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2))

  await browser.close()
  console.log(`\n${results.length} UI assertions: ${passed} passed, ${failed} failed -> ${OUT}`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(async (error) => {
  console.error('UI E2E harness error:', error && error.stack ? error.stack : error)
  const diagnostics = { error: String(error && error.message ? error.message : error), results, consoleErrors, pageErrors, apiLog }
  try {
    if (pageRef) {
      diagnostics.screenshot = path.join(SHOTS, 'ui-failure.png')
      await pageRef.screenshot({ path: diagnostics.screenshot }).catch(() => {})
      diagnostics.bodyText = (await pageRef.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 4000)
      diagnostics.dialogCount = await pageRef.getByRole('dialog').count().catch(() => -1)
      diagnostics.skillRows = await pageRef.locator('[data-dsm="skill-row"]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-skill'))).catch(() => [])
    }
  } catch (diagnosticError) {
    diagnostics.diagnosticError = String(diagnosticError)
  }
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify({ tool: 'e2e-ui.cjs', startedAt, failedEarly: true, summary: { total: results.length, passed: results.filter((result) => result.pass).length, failed: results.filter((result) => !result.pass).length + 1 }, results, diagnostics, consoleErrors, pageErrors, apiLog }, null, 2))
  } catch { /* ignore */ }
  try { if (browserRef) await browserRef.close() } catch { /* ignore */ }
  process.exit(2)
})
