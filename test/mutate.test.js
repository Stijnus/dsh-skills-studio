/**
 * Mutations: atomic writes, optimistic sha, path/symlink containment, install.
 */

import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { serializeSkillFile } from '../src/frontmatter.js'
import { MutationError, createSkill, deleteSkill, installSkill, updateSkill } from '../src/mutate.js'
import { resolveRoots } from '../src/roots.js'
import { scanSkills, sha256 } from '../src/scan.js'
import { tempConfig, tempWorkspace, writeBundleSkill, writeFlatSkill } from './helpers.js'

/** @param {string} base */
async function setup(base) {
  const config = normalizeConfig({
    ...tempConfig(base),
    writableRoot: join(base, 'managed'),
    includeUserDshRoot: false,
  })
  const roots = await resolveRoots(config)
  const root = roots.find(candidate => candidate.writable === true)
  assert.ok(root)
  return { config, root }
}

/** @param {string} dir @returns {Promise<string[]>} every file/dir name below `dir` */
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

test('createSkill writes a bundle atomically with mode 0644 and leaves no temp file', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  const markdown = serializeSkillFile({ name: 'new-skill', description: 'Created by a test.', body: '# hi\n' })
  const result = await createSkill({ root, relPath: 'new-skill/SKILL.md', markdown })
  const file = join(root.path, 'new-skill', 'SKILL.md')
  assert.equal(result.path, file)
  assert.equal(await readFile(file, 'utf8'), markdown)
  assert.equal((await stat(file)).mode & 0o777, 0o644)
  const names = await listTree(root.path)
  assert.ok(names.includes('new-skill/SKILL.md'))
  assert.deepEqual(names.filter(name => name.includes('.tmp-')), [])
})

test('createSkill writes a flat skill', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  const markdown = serializeSkillFile({ name: 'flat-skill', description: 'Flat.', body: '' })
  await createSkill({ root, relPath: 'flat-skill.md', markdown })
  assert.equal(await readFile(join(root.path, 'flat-skill.md'), 'utf8'), markdown)
})

test('createSkill refuses an occupied target', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  await writeFlatSkill(root.path, 'taken-flat')
  await assert.rejects(
    () => createSkill({ root, relPath: 'taken-flat.md', markdown: 'x' }),
    error => error instanceof MutationError && error.code === 'target-exists',
  )
  await createSkill({ root, relPath: 'taken-bundle/SKILL.md', markdown: 'x' })
  await assert.rejects(
    () => createSkill({ root, relPath: 'taken-bundle/SKILL.md', markdown: 'x' }),
    error => error instanceof MutationError && error.code === 'target-exists',
  )
})

test('updateSkill round-trips and refuses a stale sha', async (t) => {
  const base = await tempWorkspace(t)
  const { config, root } = await setup(base)
  await createSkill({
    root,
    relPath: 'edit-me/SKILL.md',
    markdown: serializeSkillFile({ name: 'edit-me', description: 'v1', body: 'one' }),
  })
  const { skills } = await scanSkills({ config })
  const entry = skills.find(skill => skill.name === 'edit-me')
  assert.ok(entry)

  const next = serializeSkillFile({ name: 'edit-me', description: 'v2', body: 'two' })
  await updateSkill({ root, relPath: entry.relPath, markdown: next, expectedSha256: entry.sha256 })
  assert.equal(await readFile(entry.path, 'utf8'), next)

  await assert.rejects(
    () => updateSkill({ root, relPath: entry.relPath, markdown: next, expectedSha256: entry.sha256 }),
    error => error instanceof MutationError && error.code === 'stale',
  )
  await assert.rejects(
    () => updateSkill({ root, relPath: entry.relPath, markdown: next, expectedSha256: '' }),
    error => error instanceof MutationError && error.code === 'stale',
  )
  await assert.rejects(
    () => updateSkill({ root, relPath: 'missing/SKILL.md', markdown: next, expectedSha256: 'x' }),
    error => error instanceof MutationError && error.code === 'not-found',
  )
})

test('deleteSkill removes a bundle directory (resources included) and a flat file', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  const bundleDir = join(root.path, 'gone-skill')
  await mkdir(join(bundleDir, 'references'), { recursive: true })
  await writeFile(join(bundleDir, 'SKILL.md'), '---\nname: gone-skill\ndescription: Gone.\n---\n')
  await writeFile(join(bundleDir, 'references', 'note.md'), 'note')
  const sha = sha256(await readFile(join(bundleDir, 'SKILL.md')))
  const removed = await deleteSkill({ root, relPath: 'gone-skill/SKILL.md', expectedSha256: sha })
  assert.equal(removed.name, 'gone-skill')
  await assert.rejects(() => lstat(bundleDir), error => error.code === 'ENOENT')

  await writeFlatSkill(root.path, 'flat-gone')
  const flatSha = sha256(await readFile(join(root.path, 'flat-gone.md')))
  const removedFlat = await deleteSkill({ root, relPath: 'flat-gone.md', expectedSha256: flatSha })
  assert.equal(removedFlat.name, 'flat-gone')
  await assert.rejects(() => lstat(join(root.path, 'flat-gone.md')), error => error.code === 'ENOENT')
})

test('deleteSkill refuses a bundle that contains a symlink and a stale sha', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  const bundleDir = join(root.path, 'linked-skill')
  await mkdir(bundleDir, { recursive: true })
  const skillFile = join(bundleDir, 'SKILL.md')
  await writeFile(skillFile, '---\nname: linked-skill\ndescription: Linked.\n---\n')
  await symlink('/tmp', join(bundleDir, 'outside'))
  const sha = sha256(await readFile(skillFile))
  await assert.rejects(
    () => deleteSkill({ root, relPath: 'linked-skill/SKILL.md', expectedSha256: sha }),
    error => error instanceof MutationError && error.code === 'symlink-target',
  )
  await assert.rejects(
    () => deleteSkill({ root, relPath: 'linked-skill/SKILL.md', expectedSha256: 'wrong' }),
    error => error instanceof MutationError && error.code === 'stale',
  )
})

test('path traversal relPaths are refused for create, update, and delete', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  for (const relPath of ['../escape.md', '/etc/escape.md', 'a/../../escape.md', 'a\\escape.md', 'a/../b.md']) {
    await assert.rejects(
      () => createSkill({ root, relPath, markdown: 'x' }),
      error => error instanceof MutationError && error.code === 'invalid-path',
      relPath,
    )
    await assert.rejects(
      () => updateSkill({ root, relPath, markdown: 'x', expectedSha256: 'x' }),
      error => error instanceof MutationError && error.code === 'invalid-path',
      relPath,
    )
    await assert.rejects(
      () => deleteSkill({ root, relPath, expectedSha256: 'x' }),
      error => error instanceof MutationError && error.code === 'invalid-path',
      relPath,
    )
  }
})

test('mutations refuse to write through a symlinked component', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  const outside = join(base, 'outside')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'SKILL.md'), '---\nname: linked-skill\ndescription: Outside.\n---\n')
  const outsideSha = sha256(await readFile(join(outside, 'SKILL.md')))
  await mkdir(root.path, { recursive: true })
  await symlink(outside, join(root.path, 'linked'))

  await assert.rejects(
    () => createSkill({ root, relPath: 'linked/new-skill/SKILL.md', markdown: 'x' }),
    error => error instanceof MutationError && error.code === 'symlink-target',
  )
  await assert.rejects(
    () => updateSkill({
      root,
      relPath: 'linked/SKILL.md',
      markdown: 'x',
      expectedSha256: outsideSha,
    }),
    error => error instanceof MutationError && error.code === 'symlink-target',
  )
  await assert.rejects(
    () => deleteSkill({ root, relPath: 'linked/SKILL.md', expectedSha256: outsideSha }),
    error => error instanceof MutationError && error.code === 'symlink-target',
  )
  assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), '---\nname: linked-skill\ndescription: Outside.\n---\n')
})

test('installSkill copies a bundle and its resource files', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  const sourceDir = join(base, 'library', 'resource-skill')
  await mkdir(join(sourceDir, 'scripts'), { recursive: true })
  await mkdir(join(sourceDir, 'references'), { recursive: true })
  const content = Buffer.from('---\nname: resource-skill\ndescription: With resources.\n---\nbody\n')
  await writeFile(join(sourceDir, 'SKILL.md'), content)
  await writeFile(join(sourceDir, 'scripts', 'run.sh'), '#!/bin/sh\n')
  await writeFile(join(sourceDir, 'references', 'doc.md'), 'doc')
  const result = await installSkill({
    root,
    source: { kind: 'bundle', name: 'resource-skill', content, bundleDir: sourceDir },
  })
  assert.equal(result.relPath, 'resource-skill/SKILL.md')
  assert.equal(await readFile(join(root.path, 'resource-skill', 'SKILL.md'), 'utf8'), content.toString())
  assert.equal(await readFile(join(root.path, 'resource-skill', 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh\n')
  assert.equal(await readFile(join(root.path, 'resource-skill', 'references', 'doc.md'), 'utf8'), 'doc')
  assert.deepEqual((await listTree(root.path)).filter(name => name.includes('.tmp-')), [])
})

test('installSkill copies a flat skill', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  const content = Buffer.from('---\nname: flat-lib\ndescription: Flat library skill.\n---\n')
  const result = await installSkill({ root, source: { kind: 'flat', name: 'flat-lib', content } })
  assert.equal(result.relPath, 'flat-lib.md')
  assert.equal(await readFile(join(root.path, 'flat-lib.md'), 'utf8'), content.toString())
})

test('installSkill update requires overwrite + matching sha, and replacing works', async (t) => {
  const base = await tempWorkspace(t)
  const { config, root } = await setup(base)
  await writeBundleSkill(root.path, 'installed-skill', { description: 'Installed copy.', body: '# old\n' })
  const { skills } = await scanSkills({ config })
  const installed = skills.find(skill => skill.name === 'installed-skill')
  assert.ok(installed)
  const content = Buffer.from('---\nname: installed-skill\ndescription: Installed copy.\n---\n# new\n')

  await assert.rejects(
    () => installSkill({ root, source: { kind: 'bundle', name: 'installed-skill', content }, installed }),
    error => error instanceof MutationError && error.code === 'overwrite-required',
  )
  await assert.rejects(
    () => installSkill({
      root,
      source: { kind: 'bundle', name: 'installed-skill', content },
      installed,
      overwrite: true,
      expectedSha256: 'wrong',
    }),
    error => error instanceof MutationError && error.code === 'stale',
  )
  await installSkill({
    root,
    source: { kind: 'bundle', name: 'installed-skill', content },
    installed,
    overwrite: true,
    expectedSha256: installed.sha256,
  })
  assert.equal(await readFile(join(root.path, 'installed-skill', 'SKILL.md'), 'utf8'), content.toString())
})

test('installSkill update refuses a pre-existing symlinked resource directory inside the installed bundle', async (t) => {
  const base = await tempWorkspace(t)
  const { config, root } = await setup(base)
  await writeBundleSkill(root.path, 'target-skill', { description: 'Installed copy.', body: '# old\n' })
  const { skills } = await scanSkills({ config })
  const installed = skills.find(skill => skill.name === 'target-skill')
  assert.ok(installed)

  const outside = join(base, 'outside-target')
  await mkdir(outside, { recursive: true })
  await symlink(outside, join(root.path, 'target-skill', 'references'))

  const sourceDir = join(base, 'library', 'target-skill')
  await mkdir(join(sourceDir, 'references'), { recursive: true })
  const content = Buffer.from('---\nname: target-skill\ndescription: Installed copy.\n---\n# new\n')
  await writeFile(join(sourceDir, 'SKILL.md'), content)
  await writeFile(join(sourceDir, 'references', 'doc.md'), 'doc')

  await assert.rejects(
    () => installSkill({
      root,
      source: { kind: 'bundle', name: 'target-skill', content, bundleDir: sourceDir },
      installed,
      overwrite: true,
      expectedSha256: installed.sha256,
    }),
    error => error instanceof MutationError && error.code === 'symlink-target',
  )
  assert.deepEqual(await readdir(outside), [])
  assert.equal((await readFile(join(root.path, 'target-skill', 'SKILL.md'), 'utf8')).includes('# old'), true)
})

test('installSkill refuses a library bundle with a symlink source', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  const sourceDir = join(base, 'library', 'symlink-skill')
  await mkdir(sourceDir, { recursive: true })
  const content = Buffer.from('---\nname: symlink-skill\ndescription: Has a link.\n---\n')
  await writeFile(join(sourceDir, 'SKILL.md'), content)
  await symlink('/tmp', join(sourceDir, 'leak'))
  await assert.rejects(
    () => installSkill({ root, source: { kind: 'bundle', name: 'symlink-skill', content, bundleDir: sourceDir } }),
    error => error instanceof MutationError && error.code === 'symlink-source',
  )
  assert.deepEqual((await listTree(root.path)).filter(name => name.startsWith('.symlink-skill.tmp-')), [])
})

test('mutation errors name the refused case for the HTTP layer', async (t) => {
  const base = await tempWorkspace(t)
  const { root } = await setup(base)
  const readOnly = { ...root, writable: false }
  await assert.rejects(
    () => createSkill({ root: readOnly, relPath: 'x/SKILL.md', markdown: 'x' }),
    error => error instanceof MutationError && error.code === 'read-only',
  )
})
