/**
 * Config normalization: defaults, environment fallbacks, type rejection.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { CONFIG_DEFAULTS, ConfigError, expandHome, normalizeConfig } from '../src/config.js'

const ENV = Object.freeze({
  DSH_AGENTS_HOME: '/tmp/dsm-config-test/agents',
  DSH_HOME: '/tmp/dsm-config-test/dsh',
})

test('defaults derive from DSH_AGENTS_HOME / DSH_HOME and the skills subdirectories', () => {
  const config = normalizeConfig({}, ENV)
  assert.equal(config.agentsHome, '/tmp/dsm-config-test/agents')
  assert.equal(config.dshHome, '/tmp/dsm-config-test/dsh')
  assert.equal(config.writableRoot, join('/tmp/dsm-config-test/agents', 'skills'))
  assert.equal(config.includeUserDshRoot, true)
  assert.equal(config.includeProjectRoots, true)
  assert.deepEqual(config.customSkillDirs, [])
  assert.deepEqual(config.libraries, [])
  assert.equal(config.maxSkillBytes, CONFIG_DEFAULTS.maxSkillBytes)
})

test('explicit paths are trimmed, expand ~, and resolve', () => {
  const config = normalizeConfig({
    agentsHome: '  ~/custom-agents  ',
    dshHome: '/tmp/dsm-config-test/other-dsh',
    writableRoot: '~/managed',
  }, ENV)
  assert.match(config.agentsHome, /custom-agents$/)
  assert.ok(config.agentsHome.startsWith('/'))
  assert.equal(config.dshHome, '/tmp/dsm-config-test/other-dsh')
  assert.match(config.writableRoot, /managed$/)
  assert.ok(config.writableRoot.startsWith('/'))
})

test('expandHome only rewrites a leading ~', () => {
  assert.equal(expandHome('/tmp/x'), '/tmp/x')
  assert.notEqual(expandHome('~/x'), '~/x')
  assert.equal(expandHome('~user/x'), '~user/x')
})

test('non-object configs are rejected with ConfigError', () => {
  for (const bad of ['nope', 42, ['array'], true]) {
    assert.throws(() => normalizeConfig(bad, ENV), error => (
      error instanceof ConfigError && /plain object/.test(error.message)
    ))
  }
})

test('path fields reject non-strings and empty strings, naming the field', () => {
  assert.throws(
    () => normalizeConfig({ agentsHome: 42 }, ENV),
    error => error instanceof ConfigError && error.field === 'agentsHome',
  )
  assert.throws(
    () => normalizeConfig({ writableRoot: '   ' }, ENV),
    error => error instanceof ConfigError && error.field === 'writableRoot',
  )
  assert.throws(
    () => normalizeConfig({ customSkillDirs: ['/a', 7] }, ENV),
    error => error instanceof ConfigError && error.field === 'customSkillDirs[1]',
  )
})

test('boolean flags reject non-booleans', () => {
  assert.throws(
    () => normalizeConfig({ includeProjectRoots: 'yes' }, ENV),
    error => error instanceof ConfigError && error.field === 'includeProjectRoots',
  )
  assert.throws(
    () => normalizeConfig({ includeUserDshRoot: 1 }, ENV),
    error => error instanceof ConfigError && error.field === 'includeUserDshRoot',
  )
})

test('libraries require an array of objects with a path', () => {
  assert.throws(
    () => normalizeConfig({ libraries: 'nope' }, ENV),
    error => error instanceof ConfigError && error.field === 'libraries',
  )
  assert.throws(
    () => normalizeConfig({ libraries: [{ id: 'x' }] }, ENV),
    error => error instanceof ConfigError && /libraries\[0\]\.path/.test(error.message),
  )
})

test('library id/label default from the directory basename and disambiguate', () => {
  const config = normalizeConfig({
    libraries: [
      { path: '/tmp/packs/one/skills' },
      { path: '/tmp/packs/two/skills' },
      { id: 'named', label: 'Named pack', path: '/tmp/packs/three' },
    ],
  }, ENV)
  assert.equal(config.libraries[0].id, 'skills')
  assert.equal(config.libraries[0].label, 'skills')
  assert.equal(config.libraries[1].id, 'skills-2', 'duplicate generated ids get a suffix')
  assert.equal(config.libraries[2].id, 'named')
  assert.equal(config.libraries[2].label, 'Named pack')
})

test('duplicate explicit library ids are rejected', () => {
  assert.throws(
    () => normalizeConfig({ libraries: [{ id: 'x', path: '/a' }, { id: 'x', path: '/b' }] }, ENV),
    error => error instanceof ConfigError && /already used/.test(error.message),
  )
})

test('maxSkillBytes must be a positive bounded integer', () => {
  assert.equal(normalizeConfig({ maxSkillBytes: 1024 }, ENV).maxSkillBytes, 1024)
  for (const bad of [0, -1, 1.5, '1024', Number.NaN, 70 * 1024 * 1024]) {
    assert.throws(
      () => normalizeConfig({ maxSkillBytes: bad }, ENV),
      error => error instanceof ConfigError && error.field === 'maxSkillBytes',
    )
  }
})
