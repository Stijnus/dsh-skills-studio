/**
 * Config normalization for the Skills manager.
 *
 * The plugin row's `config` is user-authored YAML, so every field is checked
 * here instead of being trusted downstream. A malformed value throws a
 * `ConfigError` naming the field; `apply()` surfaces that at load time, which
 * is the only place a bad config should ever fail.
 *
 * @module dsh-skills-manager/config
 */

import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** Raised for a config that cannot be normalized. Carries the offending field. */
export class ConfigError extends Error {
  /**
   * @param {string} message human-readable diagnostic
   * @param {string} [field] dotted config field, e.g. `libraries[0].path`
   */
  constructor(message, field) {
    super(message)
    this.name = 'ConfigError'
    this.field = field
  }
}

/** @type {Readonly<{ includeUserDshRoot: boolean, includeProjectRoots: boolean, maxSkillBytes: number }>} */
export const CONFIG_DEFAULTS = Object.freeze({
  includeUserDshRoot: true,
  includeProjectRoots: true,
  maxSkillBytes: 262144,
})

/** Hard ceiling for a configured body cap; keeps a typo from asking for gigabytes. */
const MAX_MAX_SKILL_BYTES = 64 * 1024 * 1024

/**
 * @typedef {object} SkillsManagerConfig
 * @property {string} agentsHome absolute shared agents config root
 * @property {string} dshHome absolute harness config root
 * @property {string} writableRoot absolute directory this plugin may write into
 * @property {boolean} includeUserDshRoot scan `<dshHome>/skills`
 * @property {boolean} includeProjectRoots scan project roots when a cwd is supplied
 * @property {string[]} customSkillDirs extra read-only roots
 * @property {{ id: string, label: string, path: string }[]} libraries installable packs
 * @property {number} maxSkillBytes instruction-file / request-body cap
 */

/**
 * Normalize the plugin row config, applying defaults and validating types.
 *
 * @param {unknown} input raw config from the Cordis row (may be undefined)
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] environment for defaults
 * @returns {SkillsManagerConfig}
 * @throws {ConfigError} when a field has the wrong type or an unusable value
 */
export function normalizeConfig(input = {}, env = process.env) {
  if (input === undefined || input === null) input = {}
  if (!isPlainObject(input)) throw new ConfigError('config must be a plain object')
  const source = /** @type {Record<string, unknown>} */ (input)

  const agentsHome = pathField(
    source.agentsHome,
    'agentsHome',
    envString(env, 'DSH_AGENTS_HOME') ?? join(homedir(), '.agents'),
  )
  const dshHome = pathField(
    source.dshHome,
    'dshHome',
    envString(env, 'DSH_HOME') ?? join(homedir(), '.dsh'),
  )
  const writableRoot = pathField(source.writableRoot, 'writableRoot', join(agentsHome, 'skills'))

  return {
    agentsHome,
    dshHome,
    writableRoot,
    includeUserDshRoot: booleanField(source.includeUserDshRoot, 'includeUserDshRoot', CONFIG_DEFAULTS.includeUserDshRoot),
    includeProjectRoots: booleanField(source.includeProjectRoots, 'includeProjectRoots', CONFIG_DEFAULTS.includeProjectRoots),
    customSkillDirs: directoryList(source.customSkillDirs, 'customSkillDirs'),
    libraries: libraryList(source.libraries),
    maxSkillBytes: byteCap(source.maxSkillBytes),
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} env @param {string} key @returns {string | undefined} */
function envString(env, key) {
  if (env === undefined || env === null) return undefined
  const value = /** @type {Record<string, unknown>} */ (env)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Expand a leading `~` and resolve to an absolute path.
 * @param {string} value
 * @returns {string}
 */
export function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/**
 * @param {unknown} value raw config value
 * @param {string} field dotted field name for diagnostics
 * @param {string} fallback absolute default
 * @returns {string}
 */
function pathField(value, field, fallback) {
  if (value === undefined) return resolve(expandHome(fallback))
  if (typeof value !== 'string') {
    throw new ConfigError(`config.${field} must be a string path`, field)
  }
  const trimmed = value.trim()
  if (trimmed === '') throw new ConfigError(`config.${field} must not be empty`, field)
  return resolve(expandHome(trimmed))
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {boolean} fallback
 * @returns {boolean}
 */
function booleanField(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new ConfigError(`config.${field} must be a boolean`, field)
  return value
}

/** @param {unknown} value @param {string} field @returns {number} */
function byteCap(value) {
  if (value === undefined) return CONFIG_DEFAULTS.maxSkillBytes
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError('config.maxSkillBytes must be a positive integer', 'maxSkillBytes')
  }
  if (value > MAX_MAX_SKILL_BYTES) {
    throw new ConfigError(`config.maxSkillBytes must not exceed ${MAX_MAX_SKILL_BYTES}`, 'maxSkillBytes')
  }
  return value
}

/**
 * @param {unknown} value raw `customSkillDirs`
 * @param {string} field
 * @returns {string[]}
 */
function directoryList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ConfigError(`config.${field} must be an array of strings`, field)
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new ConfigError(`config.${field}[${index}] must be a string path`, `${field}[${index}]`)
    }
    const trimmed = entry.trim()
    if (trimmed === '') {
      throw new ConfigError(`config.${field}[${index}] must not be empty`, `${field}[${index}]`)
    }
    return resolve(expandHome(trimmed))
  })
}

/**
 * Normalize installable library packs. `id` and `label` are optional: the id
 * falls back to the directory basename (unique, suffixed when needed) and the
 * label to the id.
 * @param {unknown} value raw `libraries`
 * @returns {{ id: string, label: string, path: string }[]}
 */
function libraryList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ConfigError('config.libraries must be an array', 'libraries')
  /** @type {{ id: string, label: string, path: string }[]} */
  const libraries = []
  const usedIds = new Set()
  value.forEach((entry, index) => {
    const at = `libraries[${index}]`
    if (!isPlainObject(entry)) throw new ConfigError(`config.${at} must be an object`, at)
    if (typeof entry.path !== 'string' || entry.path.trim() === '') {
      throw new ConfigError(`config.${at}.path must be a non-empty string`, `${at}.path`)
    }
    const path = pathField(entry.path, `${at}.path`, '')
    let id
    if (entry.id === undefined) {
      id = uniqueId(basename(path) || 'library', usedIds)
    } else {
      if (typeof entry.id !== 'string' || entry.id.trim() === '') {
        throw new ConfigError(`config.${at}.id must be a non-empty string`, `${at}.id`)
      }
      id = entry.id.trim()
      if (usedIds.has(id)) {
        throw new ConfigError(`config.${at}.id "${id}" is already used by another library`, `${at}.id`)
      }
    }
    usedIds.add(id)
    let label = id
    if (entry.label !== undefined) {
      if (typeof entry.label !== 'string' || entry.label.trim() === '') {
        throw new ConfigError(`config.${at}.label must be a non-empty string`, `${at}.label`)
      }
      label = entry.label.trim()
    }
    libraries.push({ id, label, path })
  })
  return libraries
}

/** @param {string} base @param {Set<string>} used @returns {string} */
function uniqueId(base, used) {
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}
