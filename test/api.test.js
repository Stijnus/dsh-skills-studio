/**
 * HTTP API: routing, envelopes, statuses, limits, mutations, registry probe.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { API_PREFIX, BODY_LIMIT_BYTES, createApi } from '../src/api.js'
import { normalizeConfig } from '../src/config.js'
import { serializeSkillFile } from '../src/frontmatter.js'
import {
  fakeCtx,
  fakeRequest,
  fakeResponse,
  fakeSkills,
  jsonBody,
  tempConfig,
  tempWorkspace,
  writeBundleSkill,
  writeFlatSkill,
} from './helpers.js'

/**
 * @param {string} base
 * @param {object} [options]
 */
async function fixture(base, options = {}) {
  const config = normalizeConfig({
    ...tempConfig(base),
    ...(options.config ?? {}),
  })
  const api = createApi({
    config,
    ctx: options.ctx,
    registryTimeoutMs: options.registryTimeoutMs ?? 120,
    registryPollMs: options.registryPollMs ?? 5,
  })
  return { config, api, writable: config.writableRoot }
}

/** @param {string} dir @returns {Promise<string[]>} */
async function listTree(dir) {
  /** @type {string[]} */
  const names = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    names.push(entry.name)
    if (entry.isDirectory()) {
      for (const child of await listTree(join(dir, entry.name))) names.push(`${entry.name}/${child}`)
    }
  }
  return names
}

/** @param {import('node:http').ServerResponse & { captured: any }} res */
function captured(res) {
  return /** @type {{ statusCode?: number, headers?: Record<string, string>, body?: string }} */ (res.captured)
}

test('GET /state returns the documented envelope, roots, and zero stats', async (t) => {
  const base = await tempWorkspace(t)
  const { api } = await fixture(base)
  const response = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(response.status, 200)
  assert.deepEqual(response.headers, {})
  const payload = response.payload
  assert.equal(payload.ok, true)
  assert.equal(payload.version, 1)
  assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(payload.cwd, null)
  assert.ok(Array.isArray(payload.roots))
  assert.equal(payload.roots.find(root => root.id === 'user-agents')?.writable, true)
  assert.deepEqual(payload.skills, [])
  assert.deepEqual(payload.libraries, [])
  assert.equal(payload.catalog.available, false)
  assert.equal(typeof payload.catalog.error, 'string')
  assert.deepEqual(payload.catalog.entries, [])
  assert.deepEqual(payload.conflicts, [])
  assert.deepEqual(payload.stats, { skills: 0, editable: 0, libraries: 0, catalog: 0, conflicts: 0 })
})

test('the HTTP handler always answers JSON with no-store cache control', async (t) => {
  const base = await tempWorkspace(t)
  const { api } = await fixture(base)
  const res = fakeResponse()
  await api.handler(fakeRequest({ method: 'GET', url: `${API_PREFIX}/api/state` }), res)
  const result = captured(res)
  assert.equal(result.statusCode, 200)
  assert.equal(result.headers?.['cache-control'], 'no-store')
  assert.equal(result.headers?.['content-type'], 'application/json; charset=utf-8')
  assert.equal(result.headers?.['x-content-type-options'], 'nosniff')
  assert.equal(jsonBody(result).ok, true)
})

test('state lists installed skills and library statuses with correct stats', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  await writeBundleSkill(join(base, 'agents', 'skills'), 'installed-skill', { description: 'Installed.' })
  await writeBundleSkill(libraryPath, 'free-skill', { description: 'Free.' })
  await writeFlatSkill(libraryPath, 'other-free-skill', { description: 'Also free.' })
  const { api } = await fixture(base, {
    config: { libraries: [{ id: 'pack', label: 'Pack', path: libraryPath }] },
  })
  const { payload } = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(payload.skills.length, 1)
  assert.equal(payload.skills[0].name, 'installed-skill')
  assert.equal(payload.skills[0].writable, true)
  assert.equal(payload.libraries[0].skills.length, 2)
  assert.ok(payload.libraries[0].skills.every(skill => skill.status === 'available'))
  assert.deepEqual(payload.stats, {
    skills: 1,
    editable: 1,
    libraries: 1,
    catalog: 0,
    conflicts: 0,
  })
})

test('state projects the live registry catalog when ctx.skills is available', async (t) => {
  const base = await tempWorkspace(t)
  const service = fakeSkills({
    catalog: [
      { name: 'plugin-skill', description: 'From a plugin.', provider: 'filesystem', path: '/x/SKILL.md' },
      { name: 'other', description: 'Another.', provider: 'runtime' },
      { malformed: true },
    ],
  })
  const { api } = await fixture(base, { ctx: fakeCtx({ skills: service }) })
  const { payload } = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(payload.catalog.available, true)
  assert.equal(payload.catalog.error, null)
  assert.deepEqual(payload.catalog.entries, [
    { name: 'plugin-skill', description: 'From a plugin.', provider: 'filesystem', path: '/x/SKILL.md' },
    { name: 'other', description: 'Another.', provider: 'runtime' },
  ])
  assert.equal(payload.catalog.coversLocalRoots, true, 'no scanned skills means nothing to cover')
  assert.equal(payload.stats.catalog, 2)
})

test('state resolves project roots from an absolute cwd and rejects relative cwd', async (t) => {
  const base = await tempWorkspace(t)
  const project = join(base, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.agents', 'skills'), { recursive: true })
  await writeBundleSkill(join(project, '.agents', 'skills'), 'project-skill')
  const { api } = await fixture(base)
  const ok = await api.handle({
    method: 'GET',
    url: `${API_PREFIX}/api/state?cwd=${encodeURIComponent(project)}`,
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.cwd, project)
  assert.ok(ok.payload.roots.some(root => root.id === 'project-agents' && root.exists))
  assert.ok(ok.payload.skills.some(skill => skill.name === 'project-skill'))

  const bad = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state?cwd=relative/path` })
  assert.equal(bad.status, 400)
  assert.equal(bad.payload.error.code, 'bad-request')
})

test('GET /skill returns the full instruction text and 404s properly', async (t) => {
  const base = await tempWorkspace(t)
  await writeFlatSkill(join(base, 'agents', 'skills'), 'readable-skill', { body: '# readable\n' })
  const { api } = await fixture(base)
  const entry = (await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` }))
    .payload.skills[0]
  const found = await api.handle({
    method: 'GET',
    url: `${API_PREFIX}/api/skill?rootId=${entry.rootId}&relPath=${encodeURIComponent(entry.relPath)}`,
  })
  assert.equal(found.status, 200)
  assert.equal(found.payload.root.id, 'user-agents')
  assert.equal(found.payload.skill.content, await readFile(join(base, 'agents', 'skills', 'readable-skill.md'), 'utf8'))

  const missingEntry = await api.handle({
    method: 'GET',
    url: `${API_PREFIX}/api/skill?rootId=user-agents&relPath=nope.md`,
  })
  assert.equal(missingEntry.status, 404)
  assert.equal(missingEntry.payload.error.code, 'not-found')

  const missingRoot = await api.handle({
    method: 'GET',
    url: `${API_PREFIX}/api/skill?rootId=nope&relPath=x.md`,
  })
  assert.equal(missingRoot.status, 404)

  const noParams = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/skill` })
  assert.equal(noParams.status, 400)
})

test('unknown endpoints are 404 and wrong methods are 405 with Allow', async (t) => {
  const base = await tempWorkspace(t)
  const { api } = await fixture(base)
  const unknown = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/nope` })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.payload.ok, false)
  assert.equal(unknown.payload.error.code, 'not-found')

  const wrongMethod = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/save` })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.payload.error.code, 'method-not-allowed')
  assert.equal(wrongMethod.headers.allow, 'POST')

  const wrongGet = await api.handle({ method: 'POST', url: `${API_PREFIX}/api/state`, body: {} })
  assert.equal(wrongGet.status, 405)
  assert.equal(wrongGet.headers.allow, 'GET')
})

test('the handler rejects invalid JSON, an empty body, and an oversized body', async (t) => {
  const base = await tempWorkspace(t)
  const { api } = await fixture(base)
  for (const fixtureBody of [
    { kind: 'invalid-json', options: { method: 'POST', url: `${API_PREFIX}/api/validate`, chunks: [Buffer.from('{nope')] }, status: 400 },
    { kind: 'empty', options: { method: 'POST', url: `${API_PREFIX}/api/validate` }, status: 400 },
    {
      kind: 'oversized',
      options: { method: 'POST', url: `${API_PREFIX}/api/validate`, chunks: [Buffer.alloc(BODY_LIMIT_BYTES + 1, 0x20)] },
      status: 413,
    },
  ]) {
    const res = fakeResponse()
    await api.handler(fakeRequest(fixtureBody.options), res)
    assert.equal(captured(res).statusCode, fixtureBody.status, fixtureBody.kind)
    assert.equal(jsonBody(captured(res)).ok, false, fixtureBody.kind)
    if (fixtureBody.status === 413) {
      assert.equal(jsonBody(captured(res)).error.code, 'body-too-large')
    }
  }
})

test('POST /validate never writes and returns field errors, conflicts, and warnings arrays', async (t) => {
  const base = await tempWorkspace(t)
  const { api } = await fixture(base)
  const invalid = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/validate`,
    body: { action: 'create', rootId: 'user-agents', name: 'Bad Name', description: '', kind: 'bundle' },
  })
  assert.equal(invalid.status, 200, 'validation outcome belongs in the body, not the HTTP status')
  assert.equal(invalid.payload.ok, false)
  assert.equal(invalid.payload.valid, false)
  assert.equal(invalid.payload.error, undefined)
  assert.ok(Array.isArray(invalid.payload.errors))
  assert.ok(invalid.payload.errors.length >= 2)
  assert.ok(Array.isArray(invalid.payload.conflicts))
  assert.ok(Array.isArray(invalid.payload.warnings))

  const good = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/validate`,
    body: {
      action: 'create',
      rootId: 'user-agents',
      name: 'preview-skill',
      description: 'Only validated, never written.',
      body: 'text',
    },
  })
  assert.equal(good.status, 200)
  assert.equal(good.payload.ok, true)
  assert.equal(good.payload.relPath, 'preview-skill/SKILL.md')
  assert.equal(good.payload.valid, true)
  assert.deepEqual(good.payload.errors, [])
  assert.deepEqual(good.payload.conflicts, [])
  await assert.rejects(() => stat(join(base, 'agents', 'skills', 'preview-skill')), error => error.code === 'ENOENT')
})

test('POST /validate returns 200 with ok:false and field error codes for an invalid draft', async (t) => {
  const base = await tempWorkspace(t)
  const { api } = await fixture(base)
  const response = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/validate`,
    body: {
      action: 'create',
      rootId: 'user-agents',
      kind: 'bundle',
      name: 'Not_Kebab',
      description: '',
      whenToUse: 'w'.repeat(600),
      body: 'x',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)
  const byField = Object.fromEntries(response.payload.errors.map(error => [error.field, error.code]))
  assert.equal(byField.name, 'invalid')
  assert.equal(byField.description, 'required')
  assert.equal(byField.whenToUse, 'too-long')
  assert.deepEqual(response.payload.conflicts, [])
  assert.deepEqual(response.payload.warnings, [])
})

test('POST /save writes the canonical file, returns the scanned skill, and leaves no temp', async (t) => {
  const base = await tempWorkspace(t)
  const { api } = await fixture(base)
  const save = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: {
      action: 'create',
      rootId: 'user-agents',
      kind: 'bundle',
      name: 'saved-skill',
      description: 'Saved by an API test.',
      whenToUse: 'When testing the API.',
      modelInvocable: false,
      userInvocable: true,
      body: '# saved\n',
      force: false,
    },
  })
  assert.equal(save.status, 200)
  assert.equal(save.payload.ok, true)
  assert.equal(save.payload.skill.name, 'saved-skill')
  assert.equal(save.payload.skill.valid, true)
  assert.equal(save.payload.skill.modelInvocable, false)
  assert.equal(save.payload.registry.checked, false)
  assert.equal(typeof save.payload.registry.reason, 'string')
  assert.deepEqual(save.payload.warnings, [])

  const file = join(base, 'agents', 'skills', 'saved-skill', 'SKILL.md')
  const text = await readFile(file, 'utf8')
  assert.equal(text, serializeSkillFile({
    name: 'saved-skill',
    description: 'Saved by an API test.',
    whenToUse: 'When testing the API.',
    modelInvocable: false,
    userInvocable: true,
    body: '# saved\n',
  }))
  assert.equal((await stat(file)).mode & 0o777, 0o644)
  const names = await listTree(join(base, 'agents', 'skills'))
  assert.deepEqual(names.filter(name => name.includes('.tmp-')), [])
})

test('force bypasses only duplicate/alias conflicts: blocked save writes nothing, forced save writes', async (t) => {
  const base = await tempWorkspace(t)
  await mkdir(join(base, 'agents', 'skills'), { recursive: true })
  await writeBundleSkill(join(base, 'agents', 'skills'), 'shared-skill', { description: 'Read-only original.' })
  const { api, writable } = await fixture(base, {
    config: { writableRoot: join(base, 'managed') },
  })
  const body = {
    action: 'create',
    rootId: 'managed',
    kind: 'bundle',
    name: 'shared-skill',
    description: 'Writable duplicate.',
    body: 'dup',
    force: false,
  }
  const blocked = await api.handle({ method: 'POST', url: `${API_PREFIX}/api/save`, body })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.payload.ok, false)
  assert.ok(blocked.payload.conflicts.some(conflict => conflict.code === 'duplicate-name'))
  await assert.rejects(
    () => stat(join(writable, 'shared-skill')),
    error => error.code === 'ENOENT',
  )

  const forcedPreview = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/validate`,
    body: { ...body, force: true },
  })
  assert.equal(forcedPreview.status, 200)
  assert.ok(forcedPreview.payload.conflicts.some(conflict => conflict.code === 'duplicate-name'))

  const forced = await api.handle({ method: 'POST', url: `${API_PREFIX}/api/save`, body: { ...body, force: true } })
  assert.equal(forced.status, 200)
  assert.ok(forced.payload.warnings.some(conflict => conflict.code === 'duplicate-name'))
  assert.ok((await stat(join(writable, 'shared-skill', 'SKILL.md'))).isFile())

  const state = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.ok(state.payload.conflicts.some(conflict => conflict.code === 'duplicate-name'))
})

test('save update enforces the optimistic sha and the immutable name', async (t) => {
  const base = await tempWorkspace(t)
  const { api, writable } = await fixture(base)
  const created = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: { action: 'create', rootId: 'user-agents', name: 'edit-api', description: 'v1', body: 'one' },
  })
  assert.equal(created.status, 200)
  const entry = created.payload.skill

  const stale = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: {
      action: 'update',
      rootId: 'user-agents',
      relPath: entry.relPath,
      name: 'edit-api',
      description: 'v2',
      expectedSha256: '0'.repeat(64),
    },
  })
  assert.equal(stale.status, 422)
  assert.equal(stale.payload.errors.find(error => error.field === 'expectedSha256')?.code, 'stale')
  assert.equal((await readFile(join(writable, 'edit-api', 'SKILL.md'), 'utf8')).includes('v1'), true)

  const renamed = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: {
      action: 'update',
      rootId: 'user-agents',
      relPath: entry.relPath,
      name: 'renamed',
      description: 'v2',
      expectedSha256: entry.sha256,
    },
  })
  assert.equal(renamed.status, 422)
  assert.equal(renamed.payload.errors.find(error => error.field === 'name')?.code, 'name-immutable')

  const updated = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: {
      action: 'update',
      rootId: 'user-agents',
      relPath: entry.relPath,
      name: 'edit-api',
      description: 'v2',
      body: 'two',
      expectedSha256: entry.sha256,
    },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.payload.skill.description, 'v2')
  assert.notEqual(updated.payload.skill.sha256, entry.sha256)
})

test('save into a read-only root is refused without touching disk', async (t) => {
  const base = await tempWorkspace(t)
  await mkdir(join(base, 'agents', 'skills'), { recursive: true })
  await writeBundleSkill(join(base, 'agents', 'skills'), 'existing-readonly')
  const { api } = await fixture(base, { config: { writableRoot: join(base, 'managed') } })
  const attempted = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: { action: 'create', rootId: 'user-agents', name: 'nope-skill', description: 'Read only root.' },
  })
  assert.equal(attempted.status, 422)
  assert.equal(attempted.payload.error.code, 'validation-failed')
  assert.equal(attempted.payload.errors.find(error => error.field === 'rootId')?.code, 'root-not-writable')
})

test('create with a traversal name is rejected and writes nothing outside the root', async (t) => {
  const base = await tempWorkspace(t)
  const { api, writable } = await fixture(base)
  for (const name of ['../escape', '..', 'a/b', 'Bad Name']) {
    const response = await api.handle({
      method: 'POST',
      url: `${API_PREFIX}/api/save`,
      body: { action: 'create', rootId: 'user-agents', name, description: 'Traversal attempt.' },
    })
    assert.equal(response.status, 422, name)
    assert.equal(response.payload.ok, false)
  }
  await assert.rejects(
    () => stat(join(base, 'agents', 'escape')),
    error => error.code === 'ENOENT',
  )
  await assert.rejects(
    () => stat(join(writable, 'escape')),
    error => error.code === 'ENOENT',
  )
})

test('delete removes the entry, requires the sha, and reports the removal', async (t) => {
  const base = await tempWorkspace(t)
  const { api, writable } = await fixture(base)
  const created = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: { action: 'create', rootId: 'user-agents', name: 'delete-me', description: 'Delete me.', body: 'x' },
  })
  const entry = created.payload.skill

  const stale = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/delete`,
    body: { rootId: 'user-agents', relPath: entry.relPath, expectedSha256: 'wrong' },
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.payload.error.code, 'stale')

  const unknownEntry = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/delete`,
    body: { rootId: 'user-agents', relPath: 'never-existed.md', expectedSha256: 'x' },
  })
  assert.equal(unknownEntry.status, 404)
  assert.equal(unknownEntry.payload.error.code, 'not-found')

  const deleted = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/delete`,
    body: { rootId: 'user-agents', relPath: entry.relPath, expectedSha256: entry.sha256 },
  })
  assert.equal(deleted.status, 200)
  assert.deepEqual(deleted.payload.removed, {
    rootId: 'user-agents',
    relPath: 'delete-me/SKILL.md',
    name: 'delete-me',
  })
  assert.equal(deleted.payload.registry.checked, false)
  await assert.rejects(() => stat(join(writable, 'delete-me')), error => error.code === 'ENOENT')
})

test('install copies a library skill, then refuses the second install', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  await writeBundleSkill(libraryPath, 'library-skill', { description: 'From the library.', body: '# lib\n' })
  const { api, writable } = await fixture(base, {
    config: { libraries: [{ id: 'pack', label: 'Pack', path: libraryPath }] },
  })
  const installed = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: 'library-skill/SKILL.md' },
  })
  assert.equal(installed.status, 200)
  assert.equal(installed.payload.skill.name, 'library-skill')
  assert.deepEqual(installed.payload.library, { id: 'pack', relPath: 'library-skill/SKILL.md' })
  assert.ok((await stat(join(writable, 'library-skill', 'SKILL.md'))).isFile())

  const again = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: 'library-skill/SKILL.md' },
  })
  assert.equal(again.status, 409)
  assert.equal(again.payload.error.code, 'already-installed')

  const state = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(state.payload.libraries[0].skills[0].status, 'installed')
})

test('install update requires overwrite and the installed sha', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  await writeBundleSkill(libraryPath, 'update-skill', { description: 'Library version.', body: '# new\n' })
  await writeBundleSkill(join(base, 'agents', 'skills'), 'update-skill', {
    description: 'Library version.',
    body: '# old\n',
  })
  const { api, writable } = await fixture(base, {
    config: { libraries: [{ id: 'pack', label: 'Pack', path: libraryPath }] },
  })
  const entry = (await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` }))
    .payload.skills.find(skill => skill.name === 'update-skill')
  assert.ok(entry)

  const noOverwrite = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: 'update-skill/SKILL.md' },
  })
  assert.equal(noOverwrite.status, 409)
  assert.equal(noOverwrite.payload.error.code, 'overwrite-required')

  const wrongSha = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: {
      libraryId: 'pack',
      relPath: 'update-skill/SKILL.md',
      overwrite: true,
      expectedSha256: 'wrong',
    },
  })
  assert.equal(wrongSha.status, 409)
  assert.equal(wrongSha.payload.error.code, 'stale')

  const updated = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: {
      libraryId: 'pack',
      relPath: 'update-skill/SKILL.md',
      overwrite: true,
      expectedSha256: entry.sha256,
    },
  })
  assert.equal(updated.status, 200)
  assert.equal(
    (await readFile(join(writable, 'update-skill', 'SKILL.md'), 'utf8')).includes('# new'),
    true,
  )
})

test('install refuses a name shadowed by a read-only root unless forced', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  await writeBundleSkill(libraryPath, 'shadow-skill', { description: 'Library copy.' })
  await mkdir(join(base, 'agents', 'skills'), { recursive: true })
  await writeBundleSkill(join(base, 'agents', 'skills'), 'shadow-skill', {
    description: 'Read-only copy with different content.',
    body: '# read-only\n',
  })
  const { api, writable } = await fixture(base, {
    config: {
      writableRoot: join(base, 'managed'),
      libraries: [{ id: 'pack', label: 'Pack', path: libraryPath }],
    },
  })
  const blocked = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: 'shadow-skill/SKILL.md' },
  })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.payload.error.code, 'duplicate-name')
  assert.ok(blocked.payload.conflicts.some(conflict => conflict.code === 'duplicate-name'))
  await assert.rejects(() => stat(join(writable, 'shadow-skill')), error => error.code === 'ENOENT')

  const forced = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: 'shadow-skill/SKILL.md', force: true },
  })
  assert.equal(forced.status, 200)
  assert.ok(forced.payload.warnings.some(conflict => conflict.code === 'duplicate-name'))
})

test('a byte-identical read-only copy reports installed and refuses re-install', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  await writeBundleSkill(libraryPath, 'same-readonly', { description: 'Same bytes.', body: '# same\n' })
  await mkdir(join(base, 'agents', 'skills'), { recursive: true })
  await writeBundleSkill(join(base, 'agents', 'skills'), 'same-readonly', {
    description: 'Same bytes.',
    body: '# same\n',
  })
  const { api } = await fixture(base, {
    config: {
      writableRoot: join(base, 'managed'),
      libraries: [{ id: 'pack', label: 'Pack', path: libraryPath }],
    },
  })
  const state = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  const row = state.payload.libraries[0].skills[0]
  assert.equal(row.status, 'installed')
  assert.equal(row.installed?.rootId, 'user-agents')

  const install = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: 'same-readonly/SKILL.md' },
  })
  assert.equal(install.status, 409)
  assert.equal(install.payload.error.code, 'already-installed')
})

test('install reports unknown libraries and invalid library entries', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  await mkdir(join(libraryPath, 'broken'), { recursive: true })
  await writeFile(join(libraryPath, 'broken', 'SKILL.md'), '# no frontmatter\n')
  const { api } = await fixture(base, {
    config: { libraries: [{ id: 'pack', path: libraryPath }] },
  })
  const unknown = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'nope', relPath: 'x/SKILL.md' },
  })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.payload.error.code, 'library-not-found')

  const missing = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: 'absent/SKILL.md' },
  })
  assert.equal(missing.status, 404)

  const traversal = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: '../outside.md' },
  })
  assert.equal(traversal.status, 400)
  assert.equal(traversal.payload.error.code, 'invalid-path')
})

test('registry probe reports visible:true when the catalog catches up inside the deadline', async (t) => {
  const base = await tempWorkspace(t)
  await writeBundleSkill(join(base, 'agents', 'skills'), 'existing-skill', { description: 'Already installed.' })
  const existingPath = join(base, 'agents', 'skills', 'existing-skill', 'SKILL.md')
  let calls = 0
  const service = {
    calls: () => calls,
    async list() {
      calls += 1
      const rows = [{
        name: 'existing-skill',
        description: 'Already installed.',
        provider: 'filesystem',
        path: existingPath,
      }]
      if (calls >= 2) {
        rows.push({
          name: 'probed-skill',
          description: 'It is visible.',
          provider: 'filesystem',
          path: join(base, 'agents', 'skills', 'probed-skill', 'SKILL.md'),
        })
      }
      return rows
    },
  }
  const { api } = await fixture(base, {
    ctx: fakeCtx({ skills: service }),
    registryTimeoutMs: 500,
  })
  const response = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: { action: 'create', rootId: 'user-agents', name: 'probed-skill', description: 'Probed.' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.registry.checked, true)
  assert.equal(response.payload.registry.visible, true)
  assert.equal(response.payload.registry.provider, 'filesystem')
  assert.equal(response.payload.registry.path, join(base, 'agents', 'skills', 'probed-skill', 'SKILL.md'))
  assert.equal(response.payload.registry.catalogCount, 2)
  assert.ok(service.calls() >= 2, 'probe must poll once the view is observable')
})

test('registry probe reports visible:false after the injectable deadline', async (t) => {
  const base = await tempWorkspace(t)
  const existingPath = join(base, 'agents', 'skills', 'existing-skill', 'SKILL.md')
  await writeBundleSkill(join(base, 'agents', 'skills'), 'existing-skill', { description: 'Already installed.' })
  const service = fakeSkills({
    catalog: [{
      name: 'existing-skill',
      description: 'Already installed.',
      provider: 'filesystem',
      path: existingPath,
    }],
  })
  const { api } = await fixture(base, {
    ctx: fakeCtx({ skills: service }),
    registryTimeoutMs: 60,
    registryPollMs: 5,
  })
  const started = Date.now()
  const response = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: { action: 'create', rootId: 'user-agents', name: 'invisible-skill', description: 'Not visible yet.' },
  })
  const elapsed = Date.now() - started
  assert.equal(response.status, 200)
  assert.equal(response.payload.registry.checked, true)
  assert.equal(response.payload.registry.visible, false)
  assert.equal(response.payload.registry.catalogCount, 1)
  assert.ok(response.payload.registry.waitedMs >= 50, `waitedMs=${response.payload.registry.waitedMs}`)
  assert.ok(elapsed >= 50, `elapsed=${elapsed}`)
  assert.ok(elapsed < 2000, 'the injectable timeout must actually shorten the wait')
  assert.ok(service.calls() >= 2, 'an observable view keeps polling until the deadline')
})

test('registry probe reports checked:false when the host-scope view cannot cover the scanned roots', async (t) => {
  const scenarios = [
    {
      scenario: 'empty catalog',
      catalogCount: 0,
      service: (() => {
        let calls = 0
        return {
          calls: () => calls,
          async list() {
            calls += 1
            return []
          },
        }
      })(),
    },
    {
      scenario: 'unrelated catalog entries only',
      catalogCount: 1,
      service: (() => {
        let calls = 0
        return {
          calls: () => calls,
          async list() {
            calls += 1
            return [{ name: 'unrelated-plugin-skill', description: 'Not from these roots.', provider: 'runtime' }]
          },
        }
      })(),
    },
  ]
  for (const entry of scenarios) {
    const base = await tempWorkspace(t)
    await writeBundleSkill(join(base, 'agents', 'skills'), 'local-skill', { description: 'Installed locally.' })
    const { api } = await fixture(base, {
      ctx: fakeCtx({ skills: entry.service }),
      registryTimeoutMs: 1000,
    })
    const response = await api.handle({
      method: 'POST',
      url: `${API_PREFIX}/api/save`,
      body: { action: 'create', rootId: 'user-agents', name: 'scoped-skill', description: 'Written locally.' },
    })
    assert.equal(response.status, 200, entry.scenario)
    const registry = response.payload.registry
    assert.equal(registry.checked, false, entry.scenario)
    assert.equal(registry.visible, false, entry.scenario)
    assert.equal(registry.provider, null, entry.scenario)
    assert.equal(registry.path, null, entry.scenario)
    assert.equal(registry.catalogCount, entry.catalogCount, entry.scenario)
    assert.equal(typeof registry.waitedMs, 'number', entry.scenario)
    assert.match(registry.reason, /session-scoped skill providers/, entry.scenario)
    assert.equal(entry.service.calls(), 1, 'an unobservable view must not poll')
  }
})

test('state catalog reports coversLocalRoots from real path coverage, not a bare name overlap', async (t) => {
  const base = await tempWorkspace(t)
  await writeBundleSkill(join(base, 'agents', 'skills'), 'local-skill', { description: 'Installed locally.' })
  const localPath = join(base, 'agents', 'skills', 'local-skill', 'SKILL.md')

  const uncovered = await fixture(base, {
    ctx: fakeCtx({
      skills: fakeSkills({
        catalog: [{ name: 'plugin-skill', description: 'From a plugin.', provider: 'runtime' }],
      }),
    }),
  })
  const uncoveredState = await uncovered.api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(uncoveredState.payload.catalog.available, true)
  assert.equal(uncoveredState.payload.catalog.coversLocalRoots, false)

  // A plugin provider can serve a skill that shares a name with a file in a
  // scanned root (the desktop composition has this with
  // reverse-engineer-anything). Its path is outside our roots, so the listing
  // still does not cover them.
  const shadowed = await fixture(base, {
    ctx: fakeCtx({
      skills: fakeSkills({
        catalog: [{
          name: 'local-skill',
          description: 'Plugin copy of a locally installed name.',
          provider: 'rev-eng-skills',
          path: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/plugin/skills/local-skill/SKILL.md',
        }],
      }),
    }),
  })
  const shadowedState = await shadowed.api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(shadowedState.payload.catalog.coversLocalRoots, false)

  const covered = await fixture(base, {
    ctx: fakeCtx({
      skills: fakeSkills({
        catalog: [{ name: 'local-skill', description: 'Installed locally.', provider: 'filesystem', path: localPath }],
      }),
    }),
  })
  const coveredState = await covered.api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(coveredState.payload.catalog.coversLocalRoots, true)

  // Providers that publish no path fall back to a filesystem-provider name overlap.
  const fallback = await fixture(base, {
    ctx: fakeCtx({
      skills: fakeSkills({
        catalog: [{ name: 'local-skill', description: 'Installed locally.', provider: 'filesystem' }],
      }),
    }),
  })
  const fallbackState = await fallback.api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(fallbackState.payload.catalog.coversLocalRoots, true)
})

test('a throwing optional service never fails a request', async (t) => {
  const base = await tempWorkspace(t)
  const ctx = {
    get() {
      throw new Error('cannot get property "skills" without inject')
    },
  }
  const { api } = await fixture(base, { ctx })
  const state = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(state.status, 200)
  assert.equal(state.payload.catalog.available, false)

  const saved = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/save`,
    body: { action: 'create', rootId: 'user-agents', name: 'no-service', description: 'No registry here.' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.registry.checked, false)
})

test('install carries the library field warnings into the response', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  await writeBundleSkill(libraryPath, 'long-desc-skill', { description: 'd'.repeat(600) })
  const { api } = await fixture(base, {
    config: { libraries: [{ id: 'pack', label: 'Pack', path: libraryPath }] },
  })
  const response = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: 'long-desc-skill/SKILL.md' },
  })
  assert.equal(response.status, 200)
  assert.ok(response.payload.warnings.some(warning => warning.code === 'description-truncated'))
})

test('validate and save surface the description-truncated warning without blocking', async (t) => {
  const base = await tempWorkspace(t)
  const { api } = await fixture(base)
  const body = {
    action: 'create',
    rootId: 'user-agents',
    name: 'long-description-skill',
    description: 'd'.repeat(600),
    body: 'text',
  }
  const validated = await api.handle({ method: 'POST', url: `${API_PREFIX}/api/validate`, body })
  assert.equal(validated.status, 200)
  assert.ok(validated.payload.warnings.some(warning => warning.code === 'description-truncated'))

  const saved = await api.handle({ method: 'POST', url: `${API_PREFIX}/api/save`, body })
  assert.equal(saved.status, 200)
  assert.ok(saved.payload.warnings.some(warning => warning.code === 'description-truncated'))
  assert.equal(saved.payload.skill.description.length, 600)
})

test('install copies a flat library skill into the writable root', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  await writeFlatSkill(libraryPath, 'flat-library-skill', { description: 'Flat library entry.' })
  const { api, writable } = await fixture(base, {
    config: { libraries: [{ id: 'pack', label: 'Pack', path: libraryPath }] },
  })
  const installed = await api.handle({
    method: 'POST',
    url: `${API_PREFIX}/api/install`,
    body: { libraryId: 'pack', relPath: 'flat-library-skill.md' },
  })
  assert.equal(installed.status, 200)
  assert.equal(installed.payload.skill.kind, 'flat')
  assert.ok((await stat(join(writable, 'flat-library-skill.md'))).isFile())
  const state = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/state` })
  assert.equal(state.payload.libraries[0].skills[0].status, 'installed')
})

test('GET /health reports resolved roots and configured libraries', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  await mkdir(libraryPath, { recursive: true })
  const { api } = await fixture(base, {
    config: { libraries: [{ id: 'pack', label: 'Pack', path: libraryPath }] },
  })
  const response = await api.handle({ method: 'GET', url: `${API_PREFIX}/api/health` })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.name, 'dsh-skills-studio')
  assert.equal(response.payload.writableRoot, join(base, 'agents', 'skills'))
  assert.ok(response.payload.roots.some(root => root.id === 'user-agents'))
  assert.deepEqual(response.payload.libraries, [{ id: 'pack', label: 'Pack', path: libraryPath }])
})
