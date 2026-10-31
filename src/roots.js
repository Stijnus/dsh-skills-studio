/**
 * Root resolution and path containment for the Skills manager.
 *
 * Ranks mirror the shipped filesystem provider so the page shows the same
 * shadowing order agents see: project `.dsh` (100), project `.agents` (200),
 * custom dirs (300), user `.dsh` (400), the writable managed root (450), and
 * user `.agents` (500, or the managed root when the writable path is the
 * default).
 *
 * @module dsh-skills-studio/roots
 */

import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Root ranks, matching `@deepseek-ai/dsh-skill-filesystem` root discovery. */
export const ROOT_RANKS = Object.freeze({
  projectDsh: 100,
  projectAgents: 200,
  custom: 300,
  userDsh: 400,
  managed: 450,
  userAgents: 500,
})

/**
 * @typedef {object} SkillRoot
 * @property {string} id stable root id
 * @property {string} label display label
 * @property {string} path absolute directory
 * @property {'project'|'custom'|'user'|'managed'} scope
 * @property {number} rank duplicate-resolution rank (lower wins)
 * @property {boolean} writable whether mutations are allowed under this root
 * @property {boolean} exists whether the directory currently exists
 */

/**
 * Whether a relative instruction path is safe to resolve under a root.
 * Rejects NUL, backslashes, absolute paths, empty/dot segments, and `..`.
 * @param {unknown} relPath
 * @returns {boolean}
 */
export function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 4096) return false
  if (relPath.includes('\0') || relPath.includes('\\')) return false
  if (isAbsolute(relPath)) return false
  return relPath.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Resolve a relative path under a root, refusing anything that escapes it.
 * Callers validate request paths with `isSafeRelPath` first; this is the
 * second, belt-and-braces containment check.
 * @param {string} rootPath absolute root
 * @param {string} relPath safe relative path using `/`
 * @returns {string} absolute target path
 */
export function resolveInside(rootPath, relPath) {
  if (!isSafeRelPath(relPath)) throw new RangeError(`unsafe relative path: ${JSON.stringify(relPath)}`)
  const root = resolve(rootPath)
  const target = resolve(root, relPath)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new RangeError(`path escapes root: ${JSON.stringify(relPath)}`)
  }
  return target
}

/**
 * Whether `path` exists as a directory. Any stat failure (absent, EACCES, a
 * file at that path) reports `false`: a root we cannot read is treated as an
 * absent root rather than failing the whole state response.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function pathIsDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Walk from `cwd` to the filesystem root and return the nearest ancestor
 * containing `.git` (a directory in a clone, a file in a worktree). Without a
 * git marker the resolved cwd itself is the project root, matching the shipped
 * filesystem provider.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function findProjectRoot(cwd) {
  const start = resolve(cwd)
  let current = start
  while (true) {
    try {
      await stat(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return start
      current = parent
    }
  }
}

/**
 * Resolve the roots for one request. Only existing roots and the writable root
 * are emitted; the writable root is always present with `exists:false` when its
 * directory has not been created yet.
 * @param {import('./config.js').SkillsManagerConfig} config
 * @param {string | undefined} cwd request working directory (absolute)
 * @returns {Promise<SkillRoot[]>}
 */
export async function resolveRoots(config, cwd) {
  /** @type {Omit<SkillRoot, 'exists'>[]} */
  const candidates = []
  if (config.includeProjectRoots && typeof cwd === 'string' && cwd.trim() !== '') {
    const projectRoot = await findProjectRoot(cwd)
    candidates.push(
      {
        id: 'project-dsh',
        label: 'Project (.dsh)',
        path: join(projectRoot, '.dsh/skills'),
        scope: 'project',
        rank: ROOT_RANKS.projectDsh,
        writable: false,
      },
      {
        id: 'project-agents',
        label: 'Project (.agents)',
        path: join(projectRoot, '.agents/skills'),
        scope: 'project',
        rank: ROOT_RANKS.projectAgents,
        writable: false,
      },
    )
  }
  config.customSkillDirs.forEach((dir, index) => {
    candidates.push({
      id: `custom-${index + 1}`,
      label: basename(dir) || dir,
      path: dir,
      scope: 'custom',
      rank: ROOT_RANKS.custom,
      writable: false,
    })
  })
  if (config.includeUserDshRoot) {
    candidates.push({
      id: 'user-dsh',
      label: 'User (.dsh)',
      path: join(config.dshHome, 'skills'),
      scope: 'user',
      rank: ROOT_RANKS.userDsh,
      writable: false,
    })
  }

  const defaultAgentsRoot = join(config.agentsHome, 'skills')
  const writableIsDefaultAgentsRoot = config.writableRoot === defaultAgentsRoot
  if (writableIsDefaultAgentsRoot) {
    candidates.push({
      id: 'user-agents',
      label: 'User (.agents)',
      path: defaultAgentsRoot,
      scope: 'user',
      rank: ROOT_RANKS.userAgents,
      writable: true,
    })
  } else {
    candidates.push(
      {
        id: 'user-agents',
        label: 'User (.agents)',
        path: defaultAgentsRoot,
        scope: 'user',
        rank: ROOT_RANKS.userAgents,
        writable: false,
      },
      {
        id: 'managed',
        label: 'My skills',
        path: config.writableRoot,
        scope: 'managed',
        rank: ROOT_RANKS.managed,
        writable: true,
      },
    )
  }

  // One directory must not appear twice: a custom root that happens to be the
  // writable root is represented by the managed/user-agents row instead.
  const writablePath = resolve(config.writableRoot)
  const seen = new Set()
  /** @type {SkillRoot[]} */
  const roots = []
  for (const candidate of candidates) {
    const path = resolve(candidate.path)
    if (seen.has(path)) continue
    if (!candidate.writable && path === writablePath) continue
    const exists = await pathIsDirectory(path)
    if (!exists && !candidate.writable) continue
    seen.add(path)
    roots.push({ ...candidate, path, exists })
  }
  roots.sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
  return roots
}
