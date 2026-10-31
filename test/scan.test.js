/**
 * Scanning: bundle/flat discovery, invalid entries, hashes, and library status.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { detectConflicts } from '../src/validate.js'
import {
  computeLibraryStatus,
  scanLibraries,
  scanRoot,
  scanSkills,
  sortSkills,
} from '../src/scan.js'
import {
  tempWorkspace,
  tempConfig,
  writeBundleSkill,
  writeFlatSkill,
  writeRaw,
} from './helpers.js'

test('scan discovers bundle and flat skills with the documented fields', async (t) => {
  const base = await tempWorkspace(t)
  const skillsRoot = join(base, 'agents', 'skills')
  await writeBundleSkill(skillsRoot, 'alpha-skill', {
    description: 'Alpha skill about release planning.',
    whenToUse: 'When planning a release.',
    modelInvocable: false,
    userInvocable: true,
    body: '# alpha\n',
  })
  await writeFlatSkill(skillsRoot, 'beta-skill', { description: 'Beta skill about testing.' })
  const config = normalizeConfig(tempConfig(base))
  const { roots, skills } = await scanSkills({ config })
  assert.equal(roots.find(root => root.id === 'user-agents')?.writable, true)
  const alpha = skills.find(skill => skill.name === 'alpha-skill')
  const beta = skills.find(skill => skill.name === 'beta-skill')
  assert.ok(alpha)
  assert.ok(beta)

  assert.equal(alpha.kind, 'bundle')
  assert.equal(alpha.relPath, 'alpha-skill/SKILL.md')
  assert.equal(alpha.entryName, 'alpha-skill')
  assert.equal(alpha.id, 'user-agents:alpha-skill/SKILL.md')
  assert.equal(alpha.rootId, 'user-agents')
  assert.equal(alpha.rootLabel, 'User (.agents)')
  assert.equal(alpha.scope, 'user')
  assert.equal(alpha.rank, 500)
  assert.equal(alpha.writable, true)
  assert.equal(alpha.valid, true)
  assert.deepEqual(alpha.errors, [])
  assert.equal(alpha.modelInvocable, false)
  assert.equal(alpha.userInvocable, true)
  assert.equal(alpha.whenToUse, 'When planning a release.')
  assert.match(alpha.sha256, /^[a-f0-9]{64}$/)
  assert.ok(alpha.size > 0)
  assert.equal(new Date(alpha.updatedAt).toISOString(), alpha.updatedAt)
  assert.ok(alpha.path.startsWith(skillsRoot))

  assert.equal(beta.kind, 'flat')
  assert.equal(beta.relPath, 'beta-skill.md')
  assert.equal(beta.entryName, 'beta-skill')
})

test('invalid frontmatter entries are reported, not thrown, and keep a display name', async (t) => {
  const base = await tempWorkspace(t)
  const skillsRoot = join(base, 'agents', 'skills')

  await mkdir(join(skillsRoot, 'no-frontmatter'), { recursive: true })
  await writeRaw(join(skillsRoot, 'no-frontmatter', 'SKILL.md'), '# just a body\n')
  await mkdir(join(skillsRoot, 'bad-yaml'), { recursive: true })
  await writeRaw(join(skillsRoot, 'bad-yaml', 'SKILL.md'), '---\n- a list item\n---\n')
  await mkdir(join(skillsRoot, 'missing-name'), { recursive: true })
  await writeRaw(join(skillsRoot, 'missing-name', 'SKILL.md'), '---\ndescription: No name here.\n---\n')
  await mkdir(join(skillsRoot, 'legacy-key'), { recursive: true })
  await writeRaw(
    join(skillsRoot, 'legacy-key', 'SKILL.md'),
    '---\nname: legacy-key\ndescription: Uses a legacy key.\ndisableModelInvocation: true\n---\n',
  )
  await mkdir(skillsRoot, { recursive: true })
  await writeRaw(join(skillsRoot, 'invalid-name.md'), '---\nname: Invalid Name\ndescription: Bad name.\n---\n')

  const config = normalizeConfig(tempConfig(base))
  const { skills } = await scanSkills({ config })
  assert.equal(skills.length, 5)
  for (const skill of skills) {
    assert.equal(skill.valid, false, skill.relPath)
    assert.ok(skill.errors.length > 0, `${skill.relPath} must carry errors`)
  }
  assert.equal(skills.find(skill => skill.relPath === 'no-frontmatter/SKILL.md')?.name, 'no-frontmatter')
  assert.ok(skills.find(skill => skill.relPath === 'no-frontmatter/SKILL.md')
    ?.errors.some(error => error.code === 'missing-frontmatter'))
  assert.ok(skills.find(skill => skill.relPath === 'bad-yaml/SKILL.md')
    ?.errors.some(error => error.code === 'invalid-frontmatter'))
  assert.ok(skills.find(skill => skill.relPath === 'missing-name/SKILL.md')
    ?.errors.some(error => error.field === 'name' && error.code === 'required'))
  assert.ok(skills.find(skill => skill.relPath === 'legacy-key/SKILL.md')
    ?.errors.some(error => /disableModelInvocation/.test(error.message)))
  assert.ok(skills.find(skill => skill.relPath === 'invalid-name.md')
    ?.errors.some(error => error.code === 'invalid'))
})

test('scan adds the description-truncated hint to invalid long-description entries', async (t) => {
  const base = await tempWorkspace(t)
  const skillsRoot = join(base, 'agents', 'skills')
  await mkdir(join(skillsRoot, 'long-desc'), { recursive: true })
  await writeRaw(
    join(skillsRoot, 'long-desc', 'SKILL.md'),
    `---\nname: long-desc\ndescription: ${'d'.repeat(520)}\ndisableModelInvocation: true\n---\n`,
  )
  const config = normalizeConfig(tempConfig(base))
  const { skills } = await scanSkills({ config })
  const entry = skills.find(skill => skill.relPath === 'long-desc/SKILL.md')
  assert.ok(entry)
  assert.equal(entry.valid, false)
  assert.ok(entry.errors.some(error => error.code === 'description-truncated'))
})

test('scan reports sha256, byte size, and mtime from the file itself', async (t) => {
  const base = await tempWorkspace(t)
  const skillsRoot = join(base, 'agents', 'skills')
  const raw = '---\nname: hashed\ndescription: Hashed skill.\n---\nbody\n'
  await mkdir(join(skillsRoot, 'hashed'), { recursive: true })
  const file = join(skillsRoot, 'hashed', 'SKILL.md')
  await writeFile(file, raw)
  const config = normalizeConfig(tempConfig(base))
  const { skills } = await scanSkills({ config })
  const skill = skills.find(candidate => candidate.name === 'hashed')
  assert.ok(skill)
  assert.equal(skill.sha256, createHash('sha256').update(raw).digest('hex'))
  assert.equal(skill.size, Buffer.byteLength(raw))
})

test('scan skips dot entries, non-markdown files, and directories without SKILL.md', async (t) => {
  const base = await tempWorkspace(t)
  const skillsRoot = join(base, 'agents', 'skills')
  await writeBundleSkill(skillsRoot, 'real-skill')
  await mkdir(join(skillsRoot, '.hidden'), { recursive: true })
  await writeRaw(join(skillsRoot, '.hidden', 'SKILL.md'), '---\nname: hidden\ndescription: Hidden.\n---\n')
  await mkdir(join(skillsRoot, 'not-a-skill'), { recursive: true })
  await writeRaw(join(skillsRoot, 'not-a-skill', 'README.md'), 'readme')
  await writeRaw(join(skillsRoot, 'notes.txt'), 'text')
  const config = normalizeConfig(tempConfig(base))
  const { skills } = await scanSkills({ config })
  assert.deepEqual(skills.map(skill => skill.name), ['real-skill'])
})

test('detectConflicts reports duplicate names, flat/bundle alias collisions, and overlap warnings', async (t) => {
  const base = await tempWorkspace(t)
  const agentsSkills = join(base, 'agents', 'skills')
  const managed = join(base, 'managed')
  const config = normalizeConfig({
    ...tempConfig(base),
    writableRoot: managed,
    includeUserDshRoot: false,
  })
  // duplicate name across roots: user-agents (rank 500) is read-only, managed (450) writes
  await writeBundleSkill(agentsSkills, 'dupe-skill', { description: 'Duplicate in read-only root.' })
  await writeBundleSkill(managed, 'dupe-skill', { description: 'Duplicate in writable root.' })
  // alias collision in one root: bundle + flat with the same entry name
  await writeBundleSkill(managed, 'alias-skill', { description: 'Bundle copy of alias skill.' })
  await writeFlatSkill(managed, 'alias-skill', { description: 'Flat copy of alias skill.' })
  // overlap warning: two descriptions with nearly identical routing tokens
  await writeBundleSkill(managed, 'plan-one', {
    description: 'Plan and verify every step of a long coding task with evidence.',
  })
  await writeBundleSkill(managed, 'plan-two', {
    description: 'Plan and verify every step of a long coding task with evidence and checks.',
  })

  const { skills } = await scanSkills({ config })
  const conflicts = detectConflicts(skills)
  const duplicate = conflicts.find(conflict => conflict.code === 'duplicate-name' && conflict.name === 'dupe-skill')
  assert.ok(duplicate)
  assert.equal(duplicate.severity, 'error')
  assert.equal(duplicate.entries.length, 2)
  assert.match(duplicate.message, /wins and shadows/)
  assert.deepEqual(duplicate.entries.map(entry => entry.rank), [450, 500])

  const alias = conflicts.find(conflict => conflict.code === 'alias-collision')
  assert.ok(alias)
  assert.equal(alias.severity, 'error')

  const sameRootDuplicate = conflicts.find(conflict => (
    conflict.code === 'duplicate-name' && conflict.name === 'alias-skill'
  ))
  assert.ok(sameRootDuplicate)
  assert.equal(
    sameRootDuplicate.message,
    'The name "alias-skill" is used twice in My skills; only one can be served.',
  )

  const overlap = conflicts.find(conflict => conflict.code === 'overlap')
  assert.ok(overlap)
  assert.equal(overlap.severity, 'warning')
  assert.ok(overlap.sharedWords.length > 0)
  assert.equal(overlap.entries.length, 2)
  assert.ok(conflicts.indexOf(overlap) > conflicts.indexOf(duplicate), 'errors sort before warnings')
})

test('alias collisions are reported even when one side is invalid', async (t) => {
  const base = await tempWorkspace(t)
  const managed = join(base, 'managed')
  await writeBundleSkill(managed, 'alias-invalid', { description: 'Valid bundle side.' })
  await writeRaw(join(managed, 'alias-invalid.md'), '# no frontmatter at all\n')
  const config = normalizeConfig({
    ...tempConfig(base),
    writableRoot: managed,
    includeUserDshRoot: false,
  })
  const { skills } = await scanSkills({ config })
  const conflicts = detectConflicts(skills)
  assert.ok(conflicts.some(conflict => conflict.code === 'alias-collision'))
})

test('library status is installed/update/available/conflict against the installed set', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  const writable = join(base, 'managed')
  const readOnly = join(base, 'agents', 'skills')
  const config = normalizeConfig({
    ...tempConfig(base),
    writableRoot: writable,
    libraries: [{ id: 'pack', label: 'Pack', path: libraryPath }],
  })
  // installed: identical bytes in library and writable root
  await writeBundleSkill(libraryPath, 'same-skill', { description: 'Identical copy.', body: '# same\n' })
  await writeBundleSkill(writable, 'same-skill', { description: 'Identical copy.', body: '# same\n' })
  // update: different body on disk
  await writeBundleSkill(libraryPath, 'old-skill', { description: 'Newer version.', body: '# new\n' })
  await writeBundleSkill(writable, 'old-skill', { description: 'Newer version.', body: '# old\n' })
  // available: not installed anywhere
  await writeFlatSkill(libraryPath, 'free-skill', { description: 'Not installed yet.' })
  // conflict: only a differing read-only copy exists
  await writeBundleSkill(libraryPath, 'shadow-skill', { description: 'Library copy.', body: '# library\n' })
  await writeBundleSkill(readOnly, 'shadow-skill', { description: 'Read-only copy.', body: '# read-only\n' })
  // installed: byte-identical copy in the read-only root needs no install
  await writeBundleSkill(libraryPath, 'readonly-same', { description: 'Same bytes.', body: '# same\n' })
  await writeBundleSkill(readOnly, 'readonly-same', { description: 'Same bytes.', body: '# same\n' })

  const { skills } = await scanSkills({ config })
  const libraries = await scanLibraries({ config, skills })
  const pack = libraries[0]
  assert.equal(pack.id, 'pack')
  assert.equal(pack.exists, true)
  assert.equal(pack.kind, 'skills')
  const byName = Object.fromEntries(pack.skills.map(skill => [skill.name, skill]))
  assert.equal(byName['same-skill'].status, 'installed')
  assert.deepEqual(byName['same-skill'].installed, {
    rootId: 'managed',
    relPath: 'same-skill/SKILL.md',
    sha256: byName['same-skill'].sha256,
  })
  assert.equal(byName['old-skill'].status, 'update')
  assert.equal(byName['free-skill'].status, 'available')
  assert.equal(byName['shadow-skill'].status, 'conflict')
  assert.equal(byName['shadow-skill'].conflict?.code, 'duplicate-name')
  assert.equal(byName['readonly-same'].status, 'installed')
  assert.deepEqual(byName['readonly-same'].installed, {
    rootId: 'user-agents',
    relPath: 'readonly-same/SKILL.md',
    sha256: byName['readonly-same'].sha256,
  })
  assert.equal(byName['free-skill'].installed, undefined)
})

test('an invalid installed copy never makes a library row look installed', async (t) => {
  const base = await tempWorkspace(t)
  const libraryPath = join(base, 'pack')
  const writable = join(base, 'managed')
  await writeBundleSkill(libraryPath, 'phantom-skill', { description: 'Real library skill.' })
  // Invalid on-disk copy with the same name (missing description) must not count.
  await mkdir(join(writable, 'phantom-skill'), { recursive: true })
  await writeRaw(join(writable, 'phantom-skill', 'SKILL.md'), '---\nname: phantom-skill\n---\n')
  const config = normalizeConfig({
    ...tempConfig(base),
    writableRoot: writable,
    libraries: [{ id: 'pack', path: libraryPath }],
  })
  const { skills } = await scanSkills({ config })
  const libraries = await scanLibraries({ config, skills })
  assert.equal(libraries[0].skills[0].status, 'available')
  assert.equal(computeLibraryStatus({ name: 'phantom-skill', sha256: 'x' }, skills).status, 'available')
})

test('scanRoot on a missing directory returns an empty list', async (t) => {
  const base = await tempWorkspace(t)
  const config = normalizeConfig(tempConfig(base))
  const root = {
    id: 'missing',
    label: 'Missing',
    path: join(base, 'nope'),
    scope: 'custom',
    rank: 300,
    writable: false,
    exists: false,
  }
  assert.deepEqual(await scanRoot(root, config), [])
})

test('sortSkills orders by rank, then name, then relPath', () => {
  const entries = [
    { rank: 500, name: 'b', relPath: 'b.md' },
    { rank: 100, name: 'z', relPath: 'z.md' },
    { rank: 500, name: 'a', relPath: 'a.md' },
  ]
  assert.deepEqual(sortSkills(entries).map(entry => entry.name), ['z', 'a', 'b'])
})
