#!/usr/bin/env node
/**
 * Boot C verification: desktop-shaped topology and the registry probe's 3-state reporting.
 *
 * Configuration under test (see /tmp/dsm-verify-home/overlay-c.yml):
 *  - plugin writableRoot = /tmp/dsm-verify-home/managed-skills (separate from the user root)
 *  - copied user root (byte-identical deepseek-stack files) is read-only
 *  - a custom read-only root holds one differing ds-tdd copy (conflict fixture) and dup-target
 *  - the only host-scope provider serves an unrelated plugin dir, so `ctx.skills.list()` from
 *    the plugin's host context cannot observe the managed root (this mirrors the shipped
 *    desktop topology, where local filesystem discovery lives in the per-agent preset layer).
 *
 * Asserts: library byte-identical read-only copies count as installed; a differing read-only
 * copy counts as conflict; /save still persists but reports registry.checked=false with a
 * reason instead of a misleading visible:false; duplicate creation is refused; delete works.
 *
 * Usage: node e2e-managed-root.mjs --base URL --writable DIR --readonly DIR --out FILE
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

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
const BASE = args.base
const WRITABLE = args.writable
const READONLY = args.readonly
const USER_ROOT = args['user-root']
const OUT = args.out
if (!BASE || !WRITABLE || !READONLY || !USER_ROOT || !OUT) {
  console.error('usage: node e2e-managed-root.mjs --base URL --writable DIR --readonly DIR --user-root DIR --out FILE')
  process.exit(2)
}

const results = []
const record = (id, expected, observed, pass, evidence) => {
  results.push({ id, expected, observed, pass, ...(evidence ? { evidence } : {}) })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}${pass ? '' : ` — expected ${JSON.stringify(expected)} observed ${JSON.stringify(observed)}`}`)
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const shaFile = (path) => sha256(readFileSync(path))
const walk = (dir, acc = []) => {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const info = lstatSync(full)
    if (info.isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}
async function req(method, path, body) {
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${BASE}/skills-manager/api${path}`, init)
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* ignore */ }
  return { status: response.status, json, text }
}
const get = (path) => req('GET', path)
const post = (path, body) => req('POST', path, body)
const state = async () => (await get('/state')).json

const readonlyBefore = walk(READONLY).map((file) => `${relative(READONLY, file)}:${shaFile(file)}`).sort()
// Precondition for the conflict case: hide the byte-identical user-root copy of ds-tdd so the
// only remaining copy is the differing read-only fixture. Restored in the finally block.
const identicalCopy = join(USER_ROOT, 'ds-tdd')
const hiddenCopy = join(USER_ROOT, '.verifier-ds-tdd-aside')
try { rmSync(hiddenCopy, { recursive: true, force: true }) } catch { /* ignore */ }
if (existsSync(identicalCopy)) (await import('node:fs')).renameSync(identicalCopy, hiddenCopy)
const name = 'boot-c-managed-skill'
const draft = {
  action: 'create', rootId: 'managed', kind: 'bundle', name,
  description: 'Skill written into the separate managed writable root during Boot C verification.',
  body: '# boot-c-managed-skill\n\nManaged root body.\n',
}
try { rmSync(join(WRITABLE, name), { recursive: true, force: true }) } catch { /* ignore */ }

let code = 0
try {
  const initial = await state()

  // 1) Roots: managed writable, user root read-only, custom read-only root present.
  {
    const managed = initial.roots.find((root) => root.id === 'managed')
    const userAgents = initial.roots.find((root) => root.id === 'user-agents')
    const custom = initial.roots.find((root) => root.id.startsWith('custom-'))
    record('roots', { managedWritable: true, userAgentsReadOnly: true, customReadOnly: true },
      { managed, userAgents, custom },
      managed?.writable === true && userAgents?.writable === false && custom?.writable === false)
  }

  // 1b) Host-scope-only catalog: coverage of the scanned local roots must be false,
  // because the only global provider publishes paths outside the scanned roots.
  {
    const catalog = initial.catalog
    record('catalog-covers-local-false', { coversLocalRoots: false, entries: 1 },
      { coversLocalRoots: catalog.coversLocalRoots, entries: catalog.entries.length, names: catalog.entries.map((entry) => entry.name) },
      catalog.coversLocalRoots === false && catalog.entries.length === 1)
  }

  // 2) Byte-identical read-only copies count as installed; a differing copy is a conflict.
  {
    const library = initial.libraries.find((item) => item.id === 'deepseek-stack')
    const aliases = initial.libraries.find((item) => item.id === 'deepseek-stack-aliases')
    const counts = library.skills.reduce((acc, skill) => { acc[skill.status] = (acc[skill.status] ?? 0) + 1; return acc }, {})
    const tdd = library.skills.find((skill) => skill.relPath === 'ds-tdd/SKILL.md')
    const aliasCounts = aliases.skills.reduce((acc, skill) => { acc[skill.status] = (acc[skill.status] ?? 0) + 1; return acc }, {})
    record('library-readonly-installed', { installed: 28, conflict: 1, aliasesInstalled: 6 },
      { counts, aliasCounts, dsTdd: tdd?.status },
      counts.installed === 28 && counts.conflict === 1 && aliasCounts.installed === 6 && tdd?.status === 'conflict',
      { evidence: { dsTdd: tdd }, note: 'differing ds-tdd copy in the read-only root must be conflict, identical copies installed' })
  }

  // 3) Duplicate creation against the read-only user root is refused before write.
  {
    const validate = await post('/validate', { ...draft, name: 'ds-mode' })
    const target = join(WRITABLE, 'ds-mode')
    record('duplicate-refused', { ok: false, conflict: 'duplicate-name', fileWritten: false },
      { status: validate.status, ok: validate.json?.ok, conflicts: validate.json?.conflicts?.map((conflict) => conflict.code), exists: existsSync(target) },
      validate.json?.ok === false && validate.json?.conflicts?.some((conflict) => conflict.code === 'duplicate-name') && !existsSync(target))
  }

  // 4) /save persists but the host-scope probe reports unobservable (checked:false), not a false negative.
  {
    const response = await post('/save', draft)
    const registry = response.json?.registry
    record('save-and-probe-3state', { status: 200, fileOnDisk: true, checked: false, visible: false, reason: 'session-scoped' },
      { status: response.status, registry, fileOnDisk: existsSync(join(WRITABLE, name, 'SKILL.md')) },
      response.status === 200 && existsSync(join(WRITABLE, name, 'SKILL.md')) &&
      registry?.checked === false && registry?.visible === false &&
      typeof registry?.reason === 'string' && /session-scoped/.test(registry.reason),
      { evidence: { registry } })
    const after = await state()
    const listed = after.skills.some((skill) => skill.name === name && skill.rootId === 'managed')
    record('state-lists-managed-skill', { listed: true }, { listed }, listed)
  }

  // 5) Delete returns the same unobservable probe state and removes the files.
  {
    const current = (await state()).skills.find((skill) => skill.rootId === 'managed' && skill.name === name)
    const response = await post('/delete', { rootId: 'managed', relPath: `${name}/SKILL.md`, expectedSha256: current?.sha256 })
    record('delete', { status: 200, fileGone: true, checked: false },
      { status: response.status, registry: response.json?.registry, fileGone: !existsSync(join(WRITABLE, name)) },
      response.status === 200 && !existsSync(join(WRITABLE, name)) && response.json?.registry?.checked === false,
      { evidence: { registry: response.json?.registry } })
  }

  // 6) Read-only fixture roots were never modified.
  {
    const after = walk(READONLY).map((file) => `${relative(READONLY, file)}:${shaFile(file)}`).sort()
    record('readonly-unchanged', { unchanged: true }, { changed: JSON.stringify(after) !== JSON.stringify(readonlyBefore) },
      JSON.stringify(after) === JSON.stringify(readonlyBefore))
  }
} catch (error) {
  console.error('Boot C harness error:', error?.stack ?? error)
  code = 2
} finally {
  try { if (existsSync(hiddenCopy)) (await import('node:fs')).renameSync(hiddenCopy, identicalCopy) } catch { /* ignore */ }
}

const passed = results.filter((result) => result.pass).length
const failed = results.length - passed
const report = { tool: 'e2e-managed-root.mjs', generatedAt: new Date().toISOString(), base: BASE, writable: WRITABLE, readonly: READONLY, summary: { total: results.length, passed, failed }, results }
const { mkdirSync, writeFileSync } = await import('node:fs')
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(report, null, 2))
console.log(`\n${results.length} Boot C assertions: ${passed} passed, ${failed} failed -> ${OUT}`)
process.exit(failed === 0 && code === 0 ? 0 : 1)
