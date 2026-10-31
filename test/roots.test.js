/**
 * Root resolution and path containment.
 */

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  ROOT_RANKS,
  findProjectRoot,
  isSafeRelPath,
  pathIsDirectory,
  resolveInside,
  resolveRoots,
} from '../src/roots.js'
import { normalizeConfig } from '../src/config.js'
import { tempWorkspace } from './helpers.js'

test('findProjectRoot returns the nearest ancestor containing .git', async (t) => {
  const base = await tempWorkspace(t)
  const project = join(base, 'project')
  const nested = join(project, 'packages', 'app')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(nested, { recursive: true })
  assert.equal(await findProjectRoot(nested), project)
})

test('findProjectRoot falls back to the resolved cwd when no .git exists', async (t) => {
  const base = await tempWorkspace(t)
  assert.equal(await findProjectRoot(base), base)
})

test('project roots are emitted with the documented labels and ranks when cwd is supplied', async (t) => {
  const base = await tempWorkspace(t)
  const project = join(base, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh', 'skills'), { recursive: true })
  await mkdir(join(project, '.agents', 'skills'), { recursive: true })
  const config = normalizeConfig({ agentsHome: join(base, 'agents'), dshHome: join(base, 'dsh') })
  const roots = await resolveRoots(config, join(project, 'src'))
  const projectDsh = roots.find(root => root.id === 'project-dsh')
  const projectAgents = roots.find(root => root.id === 'project-agents')
  assert.ok(projectDsh)
  assert.ok(projectAgents)
  assert.equal(projectDsh.label, 'Project (.dsh)')
  assert.equal(projectDsh.scope, 'project')
  assert.equal(projectDsh.rank, ROOT_RANKS.projectDsh)
  assert.equal(projectAgents.rank, ROOT_RANKS.projectAgents)
  assert.equal(projectDsh.exists, true)
})

test('project roots are skipped without a cwd or when disabled', async (t) => {
  const base = await tempWorkspace(t)
  const project = join(base, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  const config = normalizeConfig({
    agentsHome: join(base, 'agents'),
    dshHome: join(base, 'dsh'),
    includeProjectRoots: false,
  })
  assert.deepEqual(
    (await resolveRoots(config, project)).filter(root => root.scope === 'project'),
    [],
  )
  const enabled = normalizeConfig({ agentsHome: join(base, 'agents'), dshHome: join(base, 'dsh') })
  assert.deepEqual(
    (await resolveRoots(enabled, undefined)).filter(root => root.scope === 'project'),
    [],
  )
})

test('default writable root makes user-agents writable and emits no managed row', async (t) => {
  const base = await tempWorkspace(t)
  await mkdir(join(base, 'agents', 'skills'), { recursive: true })
  const config = normalizeConfig({ agentsHome: join(base, 'agents'), dshHome: join(base, 'dsh') })
  const roots = await resolveRoots(config)
  const userAgents = roots.find(root => root.id === 'user-agents')
  assert.ok(userAgents?.writable)
  assert.equal(userAgents.rank, ROOT_RANKS.userAgents)
  assert.equal(roots.find(root => root.id === 'managed'), undefined)
  assert.equal(userAgents.exists, true)
})

test('writableRoot override emits a writable managed root and a read-only user-agents root', async (t) => {
  const base = await tempWorkspace(t)
  await mkdir(join(base, 'agents', 'skills'), { recursive: true })
  await mkdir(join(base, 'managed-skills'), { recursive: true })
  const config = normalizeConfig({
    agentsHome: join(base, 'agents'),
    dshHome: join(base, 'dsh'),
    writableRoot: join(base, 'managed-skills'),
  })
  const roots = await resolveRoots(config)
  const managed = roots.find(root => root.id === 'managed')
  const userAgents = roots.find(root => root.id === 'user-agents')
  assert.ok(managed)
  assert.equal(managed.writable, true)
  assert.equal(managed.label, 'My skills')
  assert.equal(managed.rank, ROOT_RANKS.managed)
  assert.equal(managed.path, join(base, 'managed-skills'))
  assert.ok(userAgents)
  assert.equal(userAgents.writable, false)
  assert.equal(userAgents.rank, ROOT_RANKS.userAgents)
  // rank order: managed (450) before user-agents (500)
  assert.ok(roots.indexOf(managed) < roots.indexOf(userAgents))
})

test('the writable root is always emitted even when its directory is missing', async (t) => {
  const base = await tempWorkspace(t)
  const config = normalizeConfig({
    agentsHome: join(base, 'agents'),
    dshHome: join(base, 'dsh'),
    writableRoot: join(base, 'does-not-exist'),
  })
  const roots = await resolveRoots(config)
  const managed = roots.find(root => root.id === 'managed')
  assert.equal(managed.exists, false)
  assert.equal(managed.writable, true)
})

test('custom dirs become custom-N roots in configuration order', async (t) => {
  const base = await tempWorkspace(t)
  await mkdir(join(base, 'packs', 'alpha'), { recursive: true })
  await mkdir(join(base, 'packs', 'beta'), { recursive: true })
  const config = normalizeConfig({
    agentsHome: join(base, 'agents'),
    dshHome: join(base, 'dsh'),
    customSkillDirs: [join(base, 'packs', 'alpha'), join(base, 'packs', 'beta')],
  })
  const roots = await resolveRoots(config)
  const custom = roots.filter(root => root.scope === 'custom')
  assert.deepEqual(custom.map(root => root.id), ['custom-1', 'custom-2'])
  assert.deepEqual(custom.map(root => root.label), ['alpha', 'beta'])
  assert.deepEqual(custom.map(root => root.rank), [ROOT_RANKS.custom, ROOT_RANKS.custom])
  assert.deepEqual(custom.map(root => root.exists), [true, true])
})

test('includeUserDshRoot false skips the user .dsh root', async (t) => {
  const base = await tempWorkspace(t)
  await mkdir(join(base, 'dsh', 'skills'), { recursive: true })
  const config = normalizeConfig({
    agentsHome: join(base, 'agents'),
    dshHome: join(base, 'dsh'),
    includeUserDshRoot: false,
  })
  const roots = await resolveRoots(config)
  assert.equal(roots.find(root => root.id === 'user-dsh'), undefined)
})

test('missing read-only roots are not emitted', async (t) => {
  const base = await tempWorkspace(t)
  const config = normalizeConfig({
    agentsHome: join(base, 'agents'),
    dshHome: join(base, 'dsh'),
    writableRoot: join(base, 'managed'),
  })
  const roots = await resolveRoots(config)
  assert.deepEqual(roots.map(root => root.id), ['managed'])
})

test('a custom dir equal to the writable root is represented once', async (t) => {
  const base = await tempWorkspace(t)
  const config = normalizeConfig({
    agentsHome: join(base, 'agents'),
    dshHome: join(base, 'dsh'),
    writableRoot: join(base, 'managed'),
    customSkillDirs: [join(base, 'managed')],
  })
  const roots = await resolveRoots(config)
  assert.deepEqual(roots.map(root => root.id), ['managed'])
  assert.equal(roots[0].writable, true)
})

test('isSafeRelPath rejects traversal, absolute paths, backslashes, NUL, empty segments', () => {
  for (const safe of ['SKILL.md', 'my-skill/SKILL.md', 'a/b/c.md']) {
    assert.equal(isSafeRelPath(safe), true, safe)
  }
  for (const unsafe of ['', '.', '..', '../x', 'a/../b', '/abs', 'a\\b', 'a//b', 'a\0b', 'a/.', null, 42]) {
    assert.equal(isSafeRelPath(unsafe), false, String(unsafe))
  }
})

test('resolveInside refuses escapes and returns contained absolute paths', () => {
  assert.equal(resolveInside('/tmp/root', 'a/SKILL.md'), '/tmp/root/a/SKILL.md')
  assert.throws(() => resolveInside('/tmp/root', '../outside.md'), RangeError)
  assert.throws(() => resolveInside('/tmp/root', '/etc/passwd'), RangeError)
})

test('pathIsDirectory reports missing paths and files as false', async (t) => {
  const base = await tempWorkspace(t)
  assert.equal(await pathIsDirectory(base), true)
  assert.equal(await pathIsDirectory(join(base, 'missing')), false)
})
