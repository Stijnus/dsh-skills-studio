/**
 * Validation: field rules, target/staleness checks, conflicts, overlap warnings.
 */

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.js'
import { scanSkills } from '../src/scan.js'
import { detectConflicts, validateDraft, validateFields } from '../src/validate.js'
import {
  tempConfig,
  tempWorkspace,
  writeBundleSkill,
  writeFlatSkill,
} from './helpers.js'

/**
 * @param {string} base
 * @param {object} [overrides]
 */
async function workspace(base, overrides = {}) {
  const config = normalizeConfig({
    ...tempConfig(base),
    writableRoot: join(base, 'managed'),
    includeUserDshRoot: false,
    ...overrides,
  })
  const { roots, skills } = await scanSkills({ config })
  return { config, roots, skills }
}

test('field validation collects name, description, whenToUse, body, and boolean errors', async (t) => {
  const base = await tempWorkspace(t)
  const { config, roots, skills } = await workspace(base, { maxSkillBytes: 32 })
  const draft = await validateDraft({
    config,
    roots,
    skills,
    body: {
      action: 'create',
      rootId: 'managed',
      name: 'Bad_Name',
      description: '',
      whenToUse: 'a'.repeat(513),
      body: 'x'.repeat(40),
      modelInvocable: 'yes',
    },
  })
  const fields = draft.errors.map(error => error.field)
  assert.ok(fields.includes('name'))
  assert.ok(fields.includes('description'))
  assert.ok(fields.includes('whenToUse'))
  assert.ok(fields.includes('body'))
  assert.ok(fields.includes('modelInvocable'))
  const nameError = draft.errors.find(error => error.field === 'name')
  assert.equal(nameError?.code, 'invalid')
  const bodyError = draft.errors.find(error => error.field === 'body')
  assert.equal(bodyError?.code, 'too-large')
})

test('name over 64 chars and description over 1024 chars are rejected', async (t) => {
  const base = await tempWorkspace(t)
  const { config, roots, skills } = await workspace(base)
  const draft = await validateDraft({
    config,
    roots,
    skills,
    body: {
      action: 'create',
      rootId: 'managed',
      name: 'a'.repeat(65),
      description: 'd'.repeat(1025),
    },
  })
  assert.equal(draft.errors.find(error => error.field === 'name')?.code, 'too-long')
  assert.equal(draft.errors.find(error => error.field === 'description')?.code, 'too-long')
})

test('description warning fires above 500 characters with the Lead-refined code', () => {
  const atLimit = validateFields({ name: 'x-skill', description: 'd'.repeat(500) }, 262144)
  assert.deepEqual(atLimit.warnings, [])
  const overLimit = validateFields({ name: 'x-skill', description: 'd'.repeat(501) }, 262144)
  assert.equal(overLimit.warnings.length, 1)
  assert.equal(overLimit.warnings[0].code, 'description-truncated')
  assert.equal(overLimit.warnings[0].severity, 'warning')
  assert.match(overLimit.warnings[0].message, /500 characters are truncated/)
  assert.equal(overLimit.errors.length, 0, 'a long-but-legal description is not an error')
})

test('create rejects an existing file and an existing (even empty) directory', async (t) => {
  const base = await tempWorkspace(t)
  const managed = join(base, 'managed')
  await writeFlatSkill(managed, 'taken-flat')
  await mkdir(join(managed, 'empty-bundle'), { recursive: true })
  const { config, roots, skills } = await workspace(base)

  const flatDraft = await validateDraft({
    config,
    roots,
    skills,
    body: { action: 'create', rootId: 'managed', kind: 'flat', name: 'taken-flat', description: 'A skill.' },
  })
  assert.equal(flatDraft.errors.find(error => error.field === 'relPath')?.code, 'target-exists')

  const bundleDraft = await validateDraft({
    config,
    roots,
    skills,
    body: { action: 'create', rootId: 'managed', kind: 'bundle', name: 'empty-bundle', description: 'A skill.' },
  })
  assert.equal(bundleDraft.errors.find(error => error.field === 'relPath')?.code, 'target-exists')
})

test('update requires an existing entry, an immutable name, and a matching expected sha', async (t) => {
  const base = await tempWorkspace(t)
  const managed = join(base, 'managed')
  await writeBundleSkill(managed, 'edit-me', { description: 'Original description.' })
  const { config, roots, skills } = await workspace(base)
  const entry = skills.find(skill => skill.name === 'edit-me')
  assert.ok(entry)

  const ok = await validateDraft({
    config,
    roots,
    skills,
    body: {
      action: 'update',
      rootId: 'managed',
      relPath: 'edit-me/SKILL.md',
      name: 'edit-me',
      description: 'Updated description.',
      expectedSha256: entry.sha256,
    },
  })
  assert.deepEqual(ok.errors, [])

  const stale = await validateDraft({
    config,
    roots,
    skills,
    body: {
      action: 'update',
      rootId: 'managed',
      relPath: 'edit-me/SKILL.md',
      name: 'edit-me',
      description: 'Updated description.',
      expectedSha256: '0'.repeat(64),
    },
  })
  assert.equal(stale.errors.find(error => error.field === 'expectedSha256')?.code, 'stale')

  const missingSha = await validateDraft({
    config,
    roots,
    skills,
    body: { action: 'update', rootId: 'managed', relPath: 'edit-me/SKILL.md', name: 'edit-me', description: 'Updated.' },
  })
  assert.equal(missingSha.errors.find(error => error.field === 'expectedSha256')?.code, 'required')

  const renamed = await validateDraft({
    config,
    roots,
    skills,
    body: {
      action: 'update',
      rootId: 'managed',
      relPath: 'edit-me/SKILL.md',
      name: 'other-name',
      description: 'Updated.',
      expectedSha256: entry.sha256,
    },
  })
  assert.equal(renamed.errors.find(error => error.field === 'name')?.code, 'name-immutable')

  const missing = await validateDraft({
    config,
    roots,
    skills,
    body: {
      action: 'update',
      rootId: 'managed',
      relPath: 'gone/SKILL.md',
      name: 'gone',
      description: 'Updated.',
      expectedSha256: entry.sha256,
    },
  })
  assert.equal(missing.errors.find(error => error.field === 'relPath')?.code, 'not-found')

  const traversal = await validateDraft({
    config,
    roots,
    skills,
    body: {
      action: 'update',
      rootId: 'managed',
      relPath: '../escape/SKILL.md',
      name: 'escape',
      description: 'Updated.',
      expectedSha256: entry.sha256,
    },
  })
  assert.equal(traversal.errors.find(error => error.field === 'relPath')?.code, 'invalid-path')
})

test('root must exist and be writable', async (t) => {
  const base = await tempWorkspace(t)
  await mkdir(join(base, 'agents', 'skills'), { recursive: true })
  await writeBundleSkill(join(base, 'agents', 'skills'), 'read-only-skill')
  const { config, roots, skills } = await workspace(base)
  const unknown = await validateDraft({
    config,
    roots,
    skills,
    body: { action: 'create', rootId: 'nope', name: 'x-skill', description: 'A skill.' },
  })
  assert.equal(unknown.errors.find(error => error.field === 'rootId')?.code, 'not-found')

  const readOnly = await validateDraft({
    config,
    roots,
    skills,
    body: { action: 'create', rootId: 'user-agents', name: 'x-skill', description: 'A skill.' },
  })
  assert.equal(readOnly.errors.find(error => error.field === 'rootId')?.code, 'root-not-writable')
})

test('creating a name that already exists in another root yields a duplicate-name conflict', async (t) => {
  const base = await tempWorkspace(t)
  await mkdir(join(base, 'agents', 'skills'), { recursive: true })
  await writeBundleSkill(join(base, 'agents', 'skills'), 'shared-skill', { description: 'In the read-only root.' })
  const { config, roots, skills } = await workspace(base)
  const draft = await validateDraft({
    config,
    roots,
    skills,
    body: { action: 'create', rootId: 'managed', kind: 'bundle', name: 'shared-skill', description: 'A new copy.' },
  })
  const conflict = draft.conflicts.find(candidate => candidate.code === 'duplicate-name')
  assert.ok(conflict)
  assert.equal(conflict.severity, 'error')
  assert.equal(conflict.name, 'shared-skill')
  assert.ok(conflict.entries.some(entry => entry.rootId === 'user-agents'))
  assert.ok(conflict.entries.some(entry => entry.rootId === 'managed'))
  assert.match(conflict.message, /wins and shadows/)
})

test('creating a flat skill next to a bundle with the same entry name yields alias-collision', async (t) => {
  const base = await tempWorkspace(t)
  await writeBundleSkill(join(base, 'managed'), 'alias-skill')
  const { config, roots, skills } = await workspace(base)
  const draft = await validateDraft({
    config,
    roots,
    skills,
    body: { action: 'create', rootId: 'managed', kind: 'flat', name: 'alias-skill', description: 'A flat copy.' },
  })
  assert.ok(draft.conflicts.some(conflict => conflict.code === 'alias-collision'))
  const duplicate = draft.conflicts.find(conflict => conflict.code === 'duplicate-name')
  assert.equal(duplicate?.message, 'The name "alias-skill" is used twice in My skills; only one can be served.')
})

test('overlap warnings carry shared words and are reported for a draft', async (t) => {
  const base = await tempWorkspace(t)
  await writeBundleSkill(join(base, 'managed'), 'plan-one', {
    description: 'Plan and verify every step of a long coding task with evidence.',
  })
  const { config, roots, skills } = await workspace(base)
  const draft = await validateDraft({
    config,
    roots,
    skills,
    body: {
      action: 'create',
      rootId: 'managed',
      name: 'plan-two',
      description: 'Plan and verify each step of a long coding task with evidence.',
    },
  })
  const warning = draft.warnings.find(candidate => candidate.code === 'overlap')
  assert.ok(warning)
  assert.equal(warning.severity, 'warning')
  assert.ok(warning.sharedWords.includes('plan'))
  assert.ok(warning.sharedWords.includes('verify'))
  assert.equal(warning.entries.length, 2)
  assert.equal(draft.errors.length, 0)
})

test('detectConflicts caps overlap warnings and de-duplicates pairs', async (t) => {
  const base = await tempWorkspace(t)
  const managed = join(base, 'managed')
  const description = 'Plan and verify every step of a long coding task with evidence.'
  for (const name of ['a-one', 'a-two', 'a-three', 'a-four', 'a-five', 'a-six']) {
    await writeBundleSkill(managed, name, { description })
  }
  const { config } = await workspace(base)
  const { skills } = await scanSkills({ config })
  const warnings = detectConflicts(skills).filter(conflict => conflict.code === 'overlap')
  assert.equal(warnings.length, 5, 'cap at five warnings')
  assert.equal(new Set(warnings.map(warning => warning.name)).size, warnings.length)
})
