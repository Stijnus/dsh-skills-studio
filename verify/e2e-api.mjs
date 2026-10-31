#!/usr/bin/env node
/**
 * Independent API end-to-end verification for dsh-skills-manager.
 *
 * Drives the real HTTP API of a scratch DSH web instance against a scratch
 * agents home (never the user's ~/.agents). Every assertion records the
 * request, observed status/fields, and a pass/fail verdict; the JSON report is
 * the evidence artifact.
 *
 * Usage:
 *   node e2e-api.mjs --base http://127.0.0.1:PORT \
 *     --agents /tmp/dsm-verify-home/agents \
 *     --writable /tmp/dsm-verify-home/agents/skills \
 *     --readonly-root /tmp/dsm-verify-home/readonly-skills \
 *     --ds-skills /path/ds-stack/skills --ds-aliases /path/ds-stack/aliases \
 *     --out /path/to/e2e-api-results.json [--registry-expect positive|negative]
 *
 * Exit codes: 0 all assertions passed, 1 assertion failures, 2 setup error.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, rmSync, writeFileSync, mkdirSync, appendFileSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    out[key] = value
    i++
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const BASE = args.base
const AGENTS = args.agents
const WRITABLE = args.writable
const READONLY_ROOT = args['readonly-root']
const DS_SKILLS = args['ds-skills']
const DS_ALIASES = args['ds-aliases']
const OUT = args.out
const REGISTRY_EXPECT = args['registry-expect'] ?? 'positive'
if (!BASE || !AGENTS || !WRITABLE || !OUT) {
  console.error('usage: node e2e-api.mjs --base URL --agents DIR --writable DIR --out FILE [--readonly-root DIR] [--ds-skills DIR] [--ds-aliases DIR] [--registry-expect positive|negative]')
  process.exit(2)
}

const results = []
const startedAt = new Date().toISOString()
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const shaFile = (path) => sha256(readFileSync(path))
const walk = (dir, acc = []) => {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = lstatSync(full)
    if (stat.isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

function record(area, id, expected, observed, pass, extra = {}) {
  results.push({ area, id, expected, observed, pass, ...extra })
  const mark = pass ? 'PASS' : 'FAIL'
  console.log(`${mark} ${area}/${id}${pass ? '' : ` — expected ${JSON.stringify(expected)} observed ${JSON.stringify(observed)}`}`)
}

async function req(method, path, body, rawBody) {
  const url = `${BASE}${path}`
  const init = { method, headers: {}, redirect: 'manual' }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  } else if (rawBody !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = rawBody
  }
  const response = await fetch(url, init)
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text, json }
}

async function api(path) { return req('GET', `/skills-manager/api${path}`) }
async function post(path, body) { return req('POST', `/skills-manager/api${path}`, body) }

async function state() {
  const response = await api('/state')
  if (response.status !== 200 || !response.json?.ok) throw new Error(`state failed: ${response.status} ${response.text.slice(0, 200)}`)
  return response
}

async function skillEntry(rootId, relPath) {
  const current = await state()
  return current.json.skills.find((entry) => entry.rootId === rootId && entry.relPath === relPath)
}

function libraryStatus(current, libraryId, relPath) {
  const library = (current.json.libraries ?? []).find((item) => item.id === libraryId)
  const skill = library?.skills?.find((item) => item.relPath === relPath)
  return skill?.status ?? null
}

function assertNoTempFiles(label) {
  const leftovers = walk(WRITABLE).filter((file) => /\.tmp-|\.tmp$/.test(file))
  record('persistence', 'no-temp-files', [], leftovers.map((file) => relative(WRITABLE, file)), leftovers.length === 0, { label })
}

const CLEANUP = []
function cleanupLater(fn) { CLEANUP.push(fn) }

function removeTree(path) {
  try { rmSync(path, { recursive: true, force: true }) } catch { /* ignore */ }
}

// Do not trust the servers to clean up our own scratch fixtures.
mkdirSync(READONLY_ROOT ?? join(dirname(AGENTS), 'readonly-skills'), { recursive: true })

const realAgentsStatBefore = statSync(resolve(process.env.HOME ?? '/', '.agents', 'skills'), { throwIfNoEntry: false })
const readonlyBefore = walk(READONLY_ROOT ?? '').map((file) => `${relative(READONLY_ROOT ?? '/', file)}:${shaFile(file)}`).sort()
const pluginOnlyDir = join(dirname(AGENTS), 'plugin-skills')
const pluginBefore = walk(pluginOnlyDir).map((file) => `${relative(pluginOnlyDir, file)}:${shaFile(file)}`).sort()

async function main() {
  // ---------------------------------------------------------------- health
  {
    const response = await api('/health')
    record('health', 'ok', { status: 200, name: 'dsh-skills-manager' },
      { status: response.status, name: response.json?.name, writableRoot: response.json?.writableRoot },
      response.status === 200 && response.json?.ok === true && response.json?.name === 'dsh-skills-manager')
  }

  // ----------------------------------------------------------------- state
  let initial = await state()
  {
    const body = initial.json
    const ds = body.skills.filter((entry) => entry.name.startsWith('ds-'))
    const dsBundles = ds.filter((entry) => entry.kind === 'bundle')
    const dsFlat = ds.filter((entry) => entry.kind === 'flat')
    const writableRoot = body.roots.find((root) => root.id === 'user-agents')
    const lib = body.libraries.find((item) => item.id === 'deepseek-stack')
    const libAliases = body.libraries.find((item) => item.id === 'deepseek-stack-aliases')
    const libInstalled = (lib?.skills ?? []).filter((entry) => entry.status === 'installed').length
    const aliasInstalled = (libAliases?.skills ?? []).filter((entry) => entry.status === 'installed').length
    record('state', 'skill-counts', { dsEntries: 35, dsBundles: 29, dsFlat: 6 },
      { dsEntries: ds.length, dsBundles: dsBundles.length, dsFlat: dsFlat.length },
      ds.length === 35 && dsBundles.length === 29 && dsFlat.length === 6,
      { evidence: { skills: body.skills.length, stats: body.stats } })
    // Existing roots + the writable root are emitted; absent read-only roots are omitted.
    record('state', 'roots', { userAgentsWritable: true, readonlyCustomRootPresent: true },
      { roots: body.roots.map((root) => ({ id: root.id, rank: root.rank, writable: root.writable, exists: root.exists })), writableRoot: WRITABLE },
      writableRoot?.writable === true && body.roots.some((root) => root.id.startsWith('custom-') && root.writable === false))
    record('state', 'all-valid', { invalid: 0 }, { invalid: body.skills.filter((entry) => !entry.valid).length },
      body.skills.filter((entry) => !entry.valid).length === 0)
    record('state', 'library-installed', { dsInstalled: 29, aliasesInstalled: 6 },
      { ds: lib?.skills?.length, dsInstalled: libInstalled, aliases: libAliases?.skills?.length, aliasesInstalled: aliasInstalled },
      libInstalled === 29 && aliasInstalled === 6)
    record('state', 'cache-control', { 'cache-control': 'no-store' },
      { 'cache-control': initial.headers['cache-control'] },
      (initial.headers['cache-control'] ?? '').includes('no-store'))
    record('state', 'catalog', { available: true }, { available: body.catalog.available, entries: body.catalog.entries.length, error: body.catalog.error },
      body.catalog.available === true && Array.isArray(body.catalog.entries),
      { evidence: { catalogNames: body.catalog.entries.map((entry) => entry.name) } })
    record('state', 'plugin-catalog-entry', { name: 'plugin-only' },
      { names: body.catalog.entries.map((entry) => entry.name) },
      body.catalog.entries.some((entry) => entry.name === 'plugin-only'))
  }

  // ---------------------------------------------------------- skill reads
  {
    const dsMode = await skillEntry('user-agents', 'ds-mode/SKILL.md')
    const response = await api(`/skill?rootId=user-agents&relPath=${encodeURIComponent('ds-mode/SKILL.md')}`)
    record('skill-read', 'bundle', { status: 200, hasContent: true, shaMatches: true },
      { status: response.status, name: response.json?.skill?.name, contentBytes: response.json?.skill?.content?.length, shaMatches: response.json?.skill?.sha256 === dsMode?.sha256 },
      response.status === 200 && response.json?.ok === true && typeof response.json?.skill?.content === 'string' &&
      response.json.skill.content.includes('name: ds-mode') && response.json.skill.sha256 === dsMode?.sha256)

    const flat = await api(`/skill?rootId=user-agents&relPath=ds-plan.md`)
    record('skill-read', 'flat', { status: 200, name: 'ds-plan' },
      { status: flat.status, name: flat.json?.skill?.name },
      flat.status === 200 && flat.json?.skill?.name === 'ds-plan')

    const missing = await api('/skill?rootId=user-agents&relPath=missing/SKILL.md')
    record('skill-read', 'missing-404', { status: 404 }, { status: missing.status, code: missing.json?.error?.code }, missing.status === 404 && missing.json?.ok === false)

    const traversal = await api(`/skill?rootId=user-agents&relPath=${encodeURIComponent('../../../etc/passwd')}`)
    record('skill-read', 'traversal-rejected', [400, 404], { status: traversal.status, code: traversal.json?.error?.code }, [400, 404].includes(traversal.status) && traversal.json?.ok === false)
  }

  // ------------------------------------------------------------- validate
  const draftName = 'verify-api-skill'
  const draft = {
    action: 'create', rootId: 'user-agents', kind: 'bundle', name: draftName,
    description: 'Verification skill created through the API E2E harness.', body: '# verify-api-skill\n\nBody.\n',
  }
  {
    const response = await post('/validate', draft)
    record('validate', 'valid-draft', { status: 200, valid: true }, { status: response.status, valid: response.json?.valid, errors: response.json?.errors }, response.status === 200 && response.json?.valid === true && response.json?.errors?.length === 0)

    // /validate answers 200 with {ok:false, valid:false, errors|conflicts} for well-formed drafts;
    // 4xx is reserved for malformed requests (documented post-freeze behavior).
    const badName = await post('/validate', { ...draft, name: 'Bad_Name' })
    record('validate', 'invalid-name', { status: 200, ok: false, valid: false, field: 'name' },
      { status: badName.status, ok: badName.json?.ok, valid: badName.json?.valid, errors: badName.json?.errors },
      badName.status === 200 && badName.json?.ok === false && badName.json?.valid === false && badName.json?.errors?.some((error) => error.field === 'name'))

    const noDesc = await post('/validate', { ...draft, description: '   ' })
    record('validate', 'missing-description', { status: 200, field: 'description' },
      { status: noDesc.status, errors: noDesc.json?.errors },
      noDesc.status === 200 && noDesc.json?.errors?.some((error) => error.field === 'description'))

    const dotName = await post('/validate', { ...draft, name: '..' })
    record('validate', 'dotname-rejected', { status: 200, ok: false }, { status: dotName.status, ok: dotName.json?.ok, errors: dotName.json?.errors },
      dotName.status === 200 && dotName.json?.ok === false)

    const traversalName = await post('/validate', { ...draft, name: '../escape' })
    record('validate', 'traversal-name-rejected', { status: 200, ok: false }, { status: traversalName.status, ok: traversalName.json?.ok },
      traversalName.status === 200 && traversalName.json?.ok === false)

    const readonlyRoot = await post('/validate', { ...draft, rootId: 'custom-1' })
    record('validate', 'readonly-root-rejected', { status: 200, field: 'rootId' },
      { status: readonlyRoot.status, errors: readonlyRoot.json?.errors },
      readonlyRoot.status === 200 && readonlyRoot.json?.ok === false && readonlyRoot.json?.errors?.some((error) => error.field === 'rootId'))

    // duplicate across roots: dup-target exists in the configured read-only root
    const duplicate = await post('/validate', { ...draft, name: 'dup-target' })
    record('validate', 'duplicate-name', { status: 200, ok: false, conflict: 'duplicate-name' },
      { status: duplicate.status, ok: duplicate.json?.ok, conflicts: duplicate.json?.conflicts?.map((conflict) => conflict.code) },
      duplicate.status === 200 && duplicate.json?.ok === false && duplicate.json?.conflicts?.some((conflict) => conflict.code === 'duplicate-name'),
      { evidence: duplicate.json?.conflicts })

    // stale update: wrong sha
    const dsMode = await skillEntry('user-agents', 'ds-mode/SKILL.md')
    const stale = await post('/validate', {
      action: 'update', rootId: 'user-agents', relPath: 'ds-mode/SKILL.md', name: 'ds-mode',
      description: 'stale check', expectedSha256: '0'.repeat(64),
    })
    record('validate', 'stale-update', { status: 200, stale: true }, { status: stale.status, errors: stale.json?.errors },
      stale.status === 200 && stale.json?.ok === false && stale.json?.errors?.some((error) => error.code === 'stale' || error.field === 'expectedSha256'),
      { evidence: { currentSha: dsMode?.sha256 } })
  }

  // -------------------------------------------------------------- create
  let createdSha = null
  {
    const response = await post('/save', draft)
    const entry = response.json?.skill
    const onDisk = join(WRITABLE, draftName, 'SKILL.md')
    createdSha = entry?.sha256 ?? null
    record('save', 'create', { status: 200, visible: REGISTRY_EXPECT === 'positive', fileOnDisk: true },
      { status: response.status, path: entry?.path, sha: entry?.sha256, registry: response.json?.registry },
      response.status === 200 && response.json?.ok === true && entry?.name === draftName && existsSync(onDisk),
      { evidence: { registry: response.json?.registry, warnings: response.json?.warnings } })
    record('save', 'create-file-content', { frontmatterName: draftName, body: true },
      { content: existsSync(onDisk) ? readFileSync(onDisk, 'utf8').slice(0, 200) : null },
      existsSync(onDisk) && readFileSync(onDisk, 'utf8').includes(`name: ${draftName}`) && readFileSync(onDisk, 'utf8').includes('Verification skill created through the API E2E harness.'))
    if (REGISTRY_EXPECT === 'positive') {
      record('registry', 'visible-after-create', { checked: true, visible: true },
        response.json?.registry, response.json?.registry?.checked === true && response.json?.registry?.visible === true,
        { evidence: response.json?.registry })
    } else {
      record('registry', 'host-scope-visibility-negative', { checked: true, visible: false },
        response.json?.registry, response.json?.registry?.checked === true && response.json?.registry?.visible === false,
        { evidence: response.json?.registry })
    }
    assertNoTempFiles('after-create')
  }

  // ---------------------------------------------------- conflict before save
  {
    const response = await post('/save', { ...draft, name: 'dup-target' })
    const target = join(WRITABLE, 'dup-target', 'SKILL.md')
    record('save', 'duplicate-blocked-before-write', { status: 409, fileWritten: false },
      { status: response.status, conflicts: response.json?.conflicts?.map((conflict) => conflict.code), exists: existsSync(target) },
      response.status === 409 && !existsSync(target), { evidence: response.json?.conflicts })
    const forced = await post('/save', { ...draft, name: 'dup-target', force: true })
    record('save', 'force-duplicate-writes', { status: 200, fileWritten: true },
      { status: forced.status, path: forced.json?.skill?.path, exists: existsSync(target) },
      forced.status === 200 && existsSync(target), { evidence: { warnings: forced.json?.warnings, registry: forced.json?.registry } })
    if (existsSync(target)) {
      const forcedEntry = (await state()).json.skills.find((entry) => entry.rootId === 'user-agents' && entry.relPath === 'dup-target/SKILL.md')
      const deleted = await post('/delete', { rootId: 'user-agents', relPath: 'dup-target/SKILL.md', expectedSha256: forcedEntry?.sha256 })
      record('save', 'force-duplicate-cleanup', { status: 200 }, { status: deleted.status, removed: deleted.json?.removed }, deleted.status === 200)
    }
  }

  // -------------------------------------------------------------- update
  {
    const onDisk = join(WRITABLE, draftName, 'SKILL.md')
    const response = await post('/save', {
      action: 'update', rootId: 'user-agents', relPath: `${draftName}/SKILL.md`, name: draftName,
      description: 'Verification skill updated through the API E2E harness.', body: '# verify-api-skill\n\nUpdated body.\n',
      expectedSha256: createdSha,
    })
    const newSha = response.json?.skill?.sha256
    record('save', 'update-correct-sha', { status: 200, shaChanged: true, contentUpdated: true },
      { status: response.status, shaChanged: newSha !== createdSha, content: existsSync(onDisk) ? readFileSync(onDisk, 'utf8').includes('Updated body.') : null },
      response.status === 200 && newSha !== createdSha && readFileSync(onDisk, 'utf8').includes('Updated body.'), { evidence: { registry: response.json?.registry } })
    const current = await skillEntry('user-agents', `${draftName}/SKILL.md`)
    const stale = await post('/save', {
      action: 'update', rootId: 'user-agents', relPath: `${draftName}/SKILL.md`, name: draftName,
      description: 'stale write', body: '# stale\n', expectedSha256: createdSha,
    })
    record('save', 'stale-update-rejected', { status: 422, unchanged: true },
      { status: stale.status, errors: stale.json?.errors, content: readFileSync(onDisk, 'utf8').includes('Updated body.') },
      stale.status === 422 && readFileSync(onDisk, 'utf8').includes('Updated body.'), { evidence: { currentSha: current?.sha256 } })
    assertNoTempFiles('after-update')
    createdSha = current?.sha256 ?? newSha
  }

  // ------------------------------------------------------- delete + stale
  {
    // The documented mutation error mapping uses 409 Conflict for a stale sha on delete.
    const staleDelete = await post('/delete', { rootId: 'user-agents', relPath: `${draftName}/SKILL.md`, expectedSha256: 'f'.repeat(64) })
    record('delete', 'stale-rejected', { status: 409, code: 'stale', fileExists: true },
      { status: staleDelete.status, error: staleDelete.json?.error, fileExists: existsSync(join(WRITABLE, draftName, 'SKILL.md')) },
      staleDelete.status === 409 && staleDelete.json?.error?.code === 'stale' && existsSync(join(WRITABLE, draftName, 'SKILL.md')))
    const response = await post('/delete', { rootId: 'user-agents', relPath: `${draftName}/SKILL.md`, expectedSha256: createdSha })
    record('delete', 'remove', { status: 200, fileGone: true, registryVisible: false },
      { status: response.status, removed: response.json?.removed, exists: existsSync(join(WRITABLE, draftName)), registry: response.json?.registry },
      response.status === 200 && !existsSync(join(WRITABLE, draftName)) && response.json?.registry?.visible === false,
      { evidence: response.json?.registry })
    const again = await post('/delete', { rootId: 'user-agents', relPath: `${draftName}/SKILL.md`, expectedSha256: createdSha })
    record('delete', 'second-404', { status: 404 }, { status: again.status, error: again.json?.error }, again.status === 404)
    assertNoTempFiles('after-delete')
  }

  // ------------------------------------------------------------- libraries
  const bundleTarget = 'ds-unslop'
  const flatTarget = 'ds-plan'
  {
    // Remove a copied bundle + flat alias from the scratch writable root, then restore through the API.
    removeTree(join(WRITABLE, bundleTarget))
    removeTree(join(WRITABLE, 'ds-unslop'))
    try { rmSync(join(WRITABLE, 'ds-plan.md'), { force: true }) } catch { /* ignore */ }
    const afterRemoval = await state()
    record('library', 'status-available-after-removal', { bundle: 'available', flat: 'available' },
      { bundle: libraryStatus(afterRemoval, 'deepseek-stack', `${bundleTarget}/SKILL.md`), flat: libraryStatus(afterRemoval, 'deepseek-stack-aliases', 'ds-plan.md') },
      libraryStatus(afterRemoval, 'deepseek-stack', `${bundleTarget}/SKILL.md`) === 'available' &&
      libraryStatus(afterRemoval, 'deepseek-stack-aliases', 'ds-plan.md') === 'available')

    const installBundle = await post('/install', { libraryId: 'deepseek-stack', relPath: `${bundleTarget}/SKILL.md` })
    record('library', 'install-bundle', { status: 200, fileRestored: true, registryVisible: true },
      { status: installBundle.status, skill: installBundle.json?.skill?.name, registry: installBundle.json?.registry, exists: existsSync(join(WRITABLE, bundleTarget, 'SKILL.md')) },
      installBundle.status === 200 && existsSync(join(WRITABLE, bundleTarget, 'SKILL.md')))
    const installedState = await state()
    record('library', 'status-installed-after-install', { status: 'installed' },
      { status: libraryStatus(installedState, 'deepseek-stack', `${bundleTarget}/SKILL.md`) },
      libraryStatus(installedState, 'deepseek-stack', `${bundleTarget}/SKILL.md`) === 'installed')

    const installFlat = await post('/install', { libraryId: 'deepseek-stack-aliases', relPath: 'ds-plan.md' })
    record('library', 'install-flat-alias', { status: 200, fileRestored: true },
      { status: installFlat.status, exists: existsSync(join(WRITABLE, 'ds-plan.md')) },
      installFlat.status === 200 && existsSync(join(WRITABLE, 'ds-plan.md')))

    const already = await post('/install', { libraryId: 'deepseek-stack', relPath: `${bundleTarget}/SKILL.md` })
    record('library', 'already-installed', { status: 409, code: 'already-installed' },
      { status: already.status, error: already.json?.error },
      already.status === 409 && already.json?.error?.code === 'already-installed')

    // Update flow: tamper the installed copy so it differs from the library source.
    appendFileSync(join(WRITABLE, bundleTarget, 'SKILL.md'), '\n<!-- verifier tampered copy -->\n')
    const tampered = await state()
    const updateStatus = libraryStatus(tampered, 'deepseek-stack', `${bundleTarget}/SKILL.md`)
    record('library', 'status-update-after-tamper', { status: 'update' }, { status: updateStatus }, updateStatus === 'update')
    const noOverwrite = await post('/install', { libraryId: 'deepseek-stack', relPath: `${bundleTarget}/SKILL.md` })
    record('library', 'update-requires-overwrite', [400, 409, 422], { status: noOverwrite.status, error: noOverwrite.json?.error },
      [400, 409, 422].includes(noOverwrite.status) && noOverwrite.json?.ok === false)
    const installedEntry = tampered.json.skills.find((entry) => entry.rootId === 'user-agents' && entry.relPath === `${bundleTarget}/SKILL.md`)
    const updated = await post('/install', {
      libraryId: 'deepseek-stack', relPath: `${bundleTarget}/SKILL.md`, overwrite: true, expectedSha256: installedEntry?.sha256,
    })
    record('library', 'update-with-overwrite', { status: 200, restored: true, registryVisible: true },
      { status: updated.status, registry: updated.json?.registry, tamperedMarkerGone: !readFileSync(join(WRITABLE, bundleTarget, 'SKILL.md'), 'utf8').includes('verifier tampered copy') },
      updated.status === 200 && !readFileSync(join(WRITABLE, bundleTarget, 'SKILL.md'), 'utf8').includes('verifier tampered copy'))
    const finalState = await state()
    record('library', 'status-installed-after-update', { status: 'installed' },
      { status: libraryStatus(finalState, 'deepseek-stack', `${bundleTarget}/SKILL.md`) },
      libraryStatus(finalState, 'deepseek-stack', `${bundleTarget}/SKILL.md`) === 'installed')
    assertNoTempFiles('after-library-mutations')
  }

  // ------------------------------------------------------- path traversal
  {
    const badInstall = await post('/install', { libraryId: 'deepseek-stack', relPath: '../../../../etc/passwd' })
    record('safety', 'install-traversal', [400, 404, 422], { status: badInstall.status, error: badInstall.json?.error }, [400, 404, 422].includes(badInstall.status))
    const absInstall = await post('/install', { libraryId: 'deepseek-stack', relPath: '/etc/passwd' })
    record('safety', 'install-absolute', [400, 404, 422], { status: absInstall.status, error: absInstall.json?.error }, [400, 404, 422].includes(absInstall.status))
    const badLibrary = await post('/install', { libraryId: 'nope', relPath: 'x/SKILL.md' })
    record('safety', 'unknown-library', [400, 404], { status: badLibrary.status, error: badLibrary.json?.error }, [400, 404].includes(badLibrary.status))
    const unknownRoot = await post('/save', { ...draft, rootId: 'nope', name: 'verify-unknown-root' })
    record('safety', 'unknown-root', [400, 404, 422], { status: unknownRoot.status, error: unknownRoot.json?.error }, [400, 404, 422].includes(unknownRoot.status) && unknownRoot.json?.ok === false)

    const traversalDelete = await post('/delete', { rootId: 'user-agents', relPath: '../../../etc/passwd', expectedSha256: 'a'.repeat(64) })
    record('safety', 'delete-traversal', [400, 404, 422], { status: traversalDelete.status, error: traversalDelete.json?.error }, [400, 404, 422].includes(traversalDelete.status))

    const nulBody = { ...draft, name: 'verify\u0000nul' }
    const nul = await post('/validate', nulBody)
    record('safety', 'nul-rejected', { status: 200, ok: false }, { status: nul.status, ok: nul.json?.ok, errors: nul.json?.errors },
      nul.status === 200 && nul.json?.ok === false)

    const badJson = await req('POST', '/skills-manager/api/save', undefined, '{not json')
    record('safety', 'bad-json', [400, 422], { status: badJson.status, error: badJson.json?.error }, [400, 422].includes(badJson.status))

    const method = await req('POST', '/skills-manager/api/state', {})
    record('safety', 'method-not-allowed', 405, { status: method.status, error: method.json?.error }, method.status === 405)
    const unknownEndpoint = await api('/unknown')
    record('safety', 'unknown-endpoint', 404, { status: unknownEndpoint.status }, unknownEndpoint.status === 404)

    const huge = await req('POST', '/skills-manager/api/save', undefined, JSON.stringify({ ...draft, body: 'x'.repeat(1024 * 1024 + 1024) }))
    record('safety', 'oversized-body', 413, { status: huge.status, error: huge.json?.error?.code }, huge.status === 413)
  }

  // ------------------------------------------------- symlink escape attempt
  {
    const outsideDir = join(dirname(AGENTS), 'outside')
    mkdirSync(outsideDir, { recursive: true })
    const outsideFile = join(outsideDir, 'SKILL.md')
    writeFileSync(outsideFile, '---\nname: outside\n' + 'description: "outside target that must not be touched"\n---\n\n# outside\n')
    const linkPath = join(WRITABLE, 'escape-link')
    removeTree(linkPath)
    try { symlinkSync(outsideDir, linkPath, 'dir') } catch { /* platform */ }
    cleanupLater(() => removeTree(linkPath))
    const before = shaFile(outsideFile)
    const response = await post('/delete', { rootId: 'user-agents', relPath: 'escape-link/SKILL.md', expectedSha256: before })
    const after = shaFile(outsideFile)
    record('safety', 'symlink-escape-delete', { rejected: true, targetIntact: true },
      { status: response.status, error: response.json?.error, targetIntact: before === after },
      ![200, 204].includes(response.status) && before === after, { evidence: { response: response.json } })
    const update = await post('/save', {
      action: 'update', rootId: 'user-agents', relPath: 'escape-link/SKILL.md', name: 'outside',
      description: 'must not write', expectedSha256: before,
    })
    record('safety', 'symlink-escape-update', { rejected: true, targetIntact: true },
      { status: update.status, error: update.json?.error, targetIntact: shaFile(outsideFile) === before },
      ![200, 204].includes(update.status) && shaFile(outsideFile) === before)
  }

  // ----------------------------------------------------- alias collision
  {
    const bundleDir = join(WRITABLE, 'verify-alias-dup')
    const flatFile = join(WRITABLE, 'verify-alias-dup.md')
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(bundleDir, 'SKILL.md'), '---\nname: verify-alias-dup\ndescription: "bundle half of an alias collision fixture"\n---\n\n# bundle\n')
    writeFileSync(flatFile, '---\nname: verify-alias-dup\ndescription: "flat half of an alias collision fixture"\n---\n\n# flat\n')
    cleanupLater(() => { removeTree(bundleDir); try { rmSync(flatFile, { force: true }) } catch { /* ignore */ } })
    const bundleBefore = readFileSync(join(bundleDir, 'SKILL.md'), 'utf8')
    const response = await post('/validate', { ...draft, name: 'verify-alias-dup' })
    record('conflicts', 'alias-collision-validate', { status: 200, ok: false, conflict: 'alias-collision' },
      { status: response.status, ok: response.json?.ok, conflicts: response.json?.conflicts?.map((conflict) => conflict.code) },
      response.status === 200 && response.json?.ok === false && response.json?.conflicts?.some((conflict) => conflict.code === 'alias-collision'),
      { evidence: response.json?.conflicts })
    const save = await post('/save', { ...draft, name: 'verify-alias-dup' })
    record('conflicts', 'alias-collision-blocks-save', { status: [409, 422], bundleUnchanged: true },
      { status: save.status, bundleUnchanged: readFileSync(join(bundleDir, 'SKILL.md'), 'utf8') === bundleBefore },
      [409, 422].includes(save.status) && readFileSync(join(bundleDir, 'SKILL.md'), 'utf8') === bundleBefore)
  }

  // -------------------------------------------------------------- hygiene
  {
    assertNoTempFiles('final')
    const readonlyAfter = walk(READONLY_ROOT).map((file) => `${relative(READONLY_ROOT, file)}:${shaFile(file)}`).sort()
    record('safety', 'readonly-roots-unchanged', { unchanged: true },
      { readonlyChanged: JSON.stringify(readonlyAfter) !== JSON.stringify(readonlyBefore), pluginChanged: JSON.stringify(walk(pluginOnlyDir).map((file) => `${relative(pluginOnlyDir, file)}:${shaFile(file)}`).sort()) !== JSON.stringify(pluginBefore) },
      JSON.stringify(readonlyAfter) === JSON.stringify(readonlyBefore) &&
      JSON.stringify(walk(pluginOnlyDir).map((file) => `${relative(pluginOnlyDir, file)}:${shaFile(file)}`).sort()) === JSON.stringify(pluginBefore))
    const realAgentsStatAfter = statSync(resolve(process.env.HOME ?? '/', '.agents', 'skills'), { throwIfNoEntry: false })
    record('safety', 'real-agents-untouched', { unchanged: true },
      { before: realAgentsStatBefore?.mtimeMs ?? null, after: realAgentsStatAfter?.mtimeMs ?? null },
      (realAgentsStatBefore?.mtimeMs ?? null) === (realAgentsStatAfter?.mtimeMs ?? null))
  }

  // ------------------------------------------------------------- summary
  const passed = results.filter((result) => result.pass).length
  const failed = results.length - passed
  const report = {
    tool: 'e2e-api.mjs',
    startedAt,
    generatedAt: new Date().toISOString(),
    base: BASE,
    agents: AGENTS,
    writable: WRITABLE,
    registryExpect: REGISTRY_EXPECT,
    summary: { total: results.length, passed, failed },
    results,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(`\n${results.length} assertions: ${passed} passed, ${failed} failed -> ${OUT}`)
  return failed === 0 ? 0 : 1
}

let code = 2
try {
  code = await main()
} catch (error) {
  console.error('E2E harness error:', error?.stack ?? error)
  code = 2
} finally {
  for (const fn of CLEANUP.reverse()) {
    try { fn() } catch { /* ignore cleanup errors */ }
  }
}
process.exit(code)
