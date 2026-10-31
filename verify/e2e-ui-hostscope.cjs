#!/usr/bin/env node
/**
 * Boot C UI delta-check: "From plugins" must render catalog rows even when the host-scope
 * catalog cannot cover the scanned roots, and must show the host-scope explanation note;
 * the Available stat must include those plugin entries (late-fix behaviour).
 *
 * Usage: node e2e-ui-hostscope.cjs --url <scratch-url-with-token> --screenshots DIR --out FILE
 */
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('/Users/stijnus/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    out[argv[i].slice(2)] = argv[i + 1]
    i++
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const URL = args.url
const SHOTS = args.screenshots
const OUT = args.out
if (!URL || !SHOTS || !OUT) {
  console.error('usage: node e2e-ui-hostscope.cjs --url URL --screenshots DIR --out FILE')
  process.exit(2)
}
fs.mkdirSync(SHOTS, { recursive: true })

const HOST_SCOPE_NOTE = 'The host-scope registry cannot verify a session catalog; local skill changes reach agents on their next step through the filesystem provider.'
const results = []
const record = (id, expected, observed, pass, extra) => {
  results.push({ id, expected, observed, pass, ...(extra ? { evidence: extra } : {}) })
  console.log(`${pass ? 'PASS' : 'FAIL'} ui-hostscope/${id}${pass ? '' : ` — expected ${JSON.stringify(expected)} observed ${JSON.stringify(observed)}`}`)
}
let code = 2
let browser = null
;(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const consoleErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)) })
  page.on('pageerror', (error) => consoleErrors.push(String(error).slice(0, 300)))
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3500)
  const cont = page.getByRole('button', { name: 'Continue' })
  if (await cont.count()) { await cont.first().click().catch(() => {}); await page.waitForTimeout(400) }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('menuitem', { name: /Settings/ }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('dialog').getByRole('button', { name: 'Skills', exact: true }).click()
  const root = page.locator('[role="dialog"] .dsm-root')
  await root.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(800)

  const state = await page.evaluate(async () => (await fetch('/skills-studio/api/state', { credentials: 'same-origin' })).json())
  record('api-state-hostscope', { coversLocalRoots: false, catalogEntries: 1 },
    { coversLocalRoots: state.catalog.coversLocalRoots, catalogEntries: state.catalog.entries.length, entryPaths: state.catalog.entries.map((entry) => entry.path) },
    state.catalog.coversLocalRoots === false && state.catalog.entries.length === 1)

  await root.getByRole('tab', { name: 'Available' }).click()
  await page.waitForTimeout(1200)
  const group = root.locator('[data-dsm="catalog-group"]')
  const rows = group.locator('[data-dsm="catalog-row"]')
  const rowCount = await rows.count()
  const rowNames = await rows.evaluateAll((elements) => elements.map((element) => element.innerText.split('\n')[1] || ''))
  const groupText = (await group.count()) ? await group.first().innerText() : ''
  record('catalog-rows-rendered', { catalogRows: 1, pluginSkill: 'plugin-only' },
    { catalogRows: rowCount, rowNames }, rowCount === 1 && rowNames.some((name) => name.includes('plugin-only')))
  record('host-scope-note', { note: HOST_SCOPE_NOTE }, { found: groupText.includes(HOST_SCOPE_NOTE) },
    groupText.includes(HOST_SCOPE_NOTE), { groupText: groupText.slice(0, 500) })

  const statValues = await root.locator('.dsm-stat-value').allInnerTexts()
  const librarySkillCount = state.libraries.reduce((sum, library) => sum + library.skills.length, 0)
  const installedNames = new Set(state.skills.map((skill) => skill.name))
  const catalogOnly = state.catalog.entries.filter((entry) => !installedNames.has(entry.name)).length
  record('available-stat-includes-plugins', { available: String(librarySkillCount + catalogOnly) },
    { statValues, expected: librarySkillCount + catalogOnly }, statValues[1] === String(librarySkillCount + catalogOnly))

  const shot = path.join(SHOTS, 'ui-available-hostscope-light.png')
  await page.screenshot({ path: shot })
  record('screenshot', true, { path: shot }, true)
  record('no-console-errors', { errors: 0 }, { consoleErrors }, consoleErrors.length === 0, { consoleErrors })

  const passed = results.filter((result) => result.pass).length
  const failed = results.length - passed
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ tool: 'e2e-ui-hostscope.cjs', generatedAt: new Date().toISOString(), url: URL.replace(/token=[^&]+/, 'token=REDACTED'), summary: { total: results.length, passed, failed }, results, consoleErrors }, null, 2))
  console.log(`\n${results.length} host-scope UI assertions: ${passed} passed, ${failed} failed -> ${OUT}`)
  code = failed === 0 ? 0 : 1
})().catch((error) => {
  console.error('UI host-scope harness error:', error && error.stack ? error.stack : error)
  code = 2
}).finally(async () => {
  try { if (browser) await browser.close() } catch { /* ignore */ }
  process.exit(code)
})
