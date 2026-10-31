/**
 * Filesystem scanning: installed roots, skill entries, and installable
 * libraries.
 *
 * Discovery is intentionally one level deep and mirrors the shipped filesystem
 * provider: `<root>/<name>/SKILL.md` (bundle) or `<root>/<name>.md` (flat). A
 * file that the agent catalog would reject (bad frontmatter, missing name or
 * description, invalid invocation booleans) is still reported — with
 * `valid:false` and an `errors` list — so the page can explain why an entry
 * exists on disk but does not reach agents.
 *
 * @module dsh-skills-manager/scan
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { frontmatterBoolean, isKebabCase, parseFrontmatter } from './frontmatter.js'
import { isSafeRelPath, pathIsDirectory, resolveInside, resolveRoots } from './roots.js'
import {
  DESCRIPTION_TRUNCATED_LENGTH,
  computeLibraryConflict,
  conflictEntry,
  detectConflicts,
  validateFields,
} from './validate.js'

/** Error codes that mean "that path is not there", never "discovery failed". */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR'])

/** Upper bound for reading one instruction file while scanning, regardless of config. */
const HARD_READ_LIMIT = 16 * 1024 * 1024

/** Metadata version echoed by `/api/state`. */
export const STATE_VERSION = 1

/**
 * @typedef {object} SkillEntry
 * @property {string} id `<rootId>:<relPath>`
 * @property {string} name frontmatter name, or the filesystem entry name when invalid
 * @property {string} description
 * @property {string} [whenToUse]
 * @property {boolean} modelInvocable
 * @property {boolean} userInvocable
 * @property {'bundle'|'flat'} kind
 * @property {string} rootId
 * @property {string} rootLabel
 * @property {'project'|'custom'|'user'|'managed'} scope
 * @property {number} rank
 * @property {string} path absolute instruction-file path
 * @property {string} relPath path relative to the root, using `/`
 * @property {string} entryName directory name or flat-file basename
 * @property {boolean} writable
 * @property {string} sha256 instruction-file content hash
 * @property {number} size byte size
 * @property {string} updatedAt ISO modification time
 * @property {boolean} valid
 * @property {{ field: string, code: string, message: string }[]} errors
 */

/**
 * @param {Buffer|string} data
 * @returns {string} lowercase hex sha256
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @param {string} path @returns {Promise<string>} sha256 of the file bytes */
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Scan every resolved root for one request.
 * @param {object} input
 * @param {import('./config.js').SkillsManagerConfig} input.config
 * @param {string | undefined} input.cwd absolute request working directory
 * @returns {Promise<{ roots: import('./roots.js').SkillRoot[], skills: SkillEntry[] }>}
 */
export async function scanSkills({ config, cwd }) {
  const roots = await resolveRoots(config, cwd)
  /** @type {SkillEntry[]} */
  const skills = []
  for (const root of roots) {
    if (!root.exists) continue
    skills.push(...await scanRoot(root, config))
  }
  return { roots, skills }
}

/**
 * Scan one root directory (non-recursive).
 * @param {import('./roots.js').SkillRoot} root
 * @param {import('./config.js').SkillsManagerConfig} config
 * @returns {Promise<SkillEntry[]>}
 */
export async function scanRoot(root, config) {
  let dirents
  try {
    dirents = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // An unreadable or vanished root contributes no entries; the rest of the
    // state response stays useful instead of failing.
    return []
  }
  dirents.sort((left, right) => codepointCompare(left.name, right.name))
  /** @type {SkillEntry[]} */
  const found = []
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue
    const entryPath = join(root.path, dirent.name)
    try {
      /** @type {'bundle'|'flat'|undefined} */
      let kind = await classifyEntry(dirent, entryPath)
      if (kind === undefined) continue
      const entryName = kind === 'bundle' ? dirent.name : basename(dirent.name, '.md')
      const filePath = kind === 'bundle' ? join(entryPath, 'SKILL.md') : entryPath
      const entry = await readEntry({ root, entryName, kind, filePath, config })
      if (entry !== undefined) found.push(entry)
    } catch {
      // One unreadable or racing entry must not hide the whole root.
      continue
    }
  }
  return found
}

/** @param {Error & { code?: string }} error @returns {boolean} */
function isAbsent(error) {
  return typeof error?.code === 'string' && ABSENT_CODES.has(error.code)
}

/** @param {string} left @param {string} right @returns {number} */
function codepointCompare(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Classify a directory entry, following symlinks to a directory or `.md` file.
 * @param {import('node:fs').Dirent} dirent
 * @param {string} entryPath
 * @returns {Promise<'bundle'|'flat'|undefined>}
 */
async function classifyEntry(dirent, entryPath) {
  if (dirent.isDirectory()) {
    return await isRegularFile(join(entryPath, 'SKILL.md')) ? 'bundle' : undefined
  }
  if (dirent.isFile()) return dirent.name.endsWith('.md') ? 'flat' : undefined
  if (!dirent.isSymbolicLink()) return undefined
  let target
  try {
    target = await stat(entryPath)
  } catch {
    return undefined // dangling symlink: not a skill
  }
  if (target.isDirectory()) {
    return await isRegularFile(join(entryPath, 'SKILL.md')) ? 'bundle' : undefined
  }
  if (target.isFile() && dirent.name.endsWith('.md')) return 'flat'
  return undefined
}

/** @param {string} path @returns {Promise<boolean>} */
async function isRegularFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Read and parse one instruction file into a scan entry.
 * @param {object} input
 * @param {import('./roots.js').SkillRoot} input.root
 * @param {string} input.entryName
 * @param {'bundle'|'flat'} input.kind
 * @param {string} input.filePath
 * @param {import('./config.js').SkillsManagerConfig} input.config
 * @returns {Promise<SkillEntry | undefined>}
 */
async function readEntry({ root, entryName, kind, filePath, config }) {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error) {
    if (isAbsent(error)) return undefined
    throw error
  }
  if (!fileStat.isFile()) return undefined

  const relPath = kind === 'bundle' ? `${entryName}/SKILL.md` : `${entryName}.md`
  const readLimit = Math.min(Math.max(config.maxSkillBytes * 4, 1024 * 1024), HARD_READ_LIMIT)
  /** @type {Buffer | undefined} */
  let buffer
  let contentSha
  if (fileStat.size > readLimit) {
    contentSha = await hashFile(filePath)
  } else {
    try {
      buffer = await readFile(filePath)
    } catch (error) {
      if (isAbsent(error)) return undefined
      throw error
    }
    contentSha = sha256(buffer)
  }

  const analyzed = buffer === undefined
    ? tooLargeAnalysis(fileStat.size)
    : analyzeFrontmatter(buffer.toString('utf8'), entryName)

  return {
    id: `${root.id}:${relPath}`,
    name: analyzed.name,
    description: analyzed.description,
    ...analyzed.whenToUse === undefined ? {} : { whenToUse: analyzed.whenToUse },
    modelInvocable: analyzed.modelInvocable,
    userInvocable: analyzed.userInvocable,
    kind,
    rootId: root.id,
    rootLabel: root.label,
    scope: root.scope,
    rank: root.rank,
    path: filePath,
    relPath,
    entryName,
    writable: root.writable,
    sha256: contentSha,
    size: buffer === undefined ? fileStat.size : buffer.length,
    updatedAt: fileStat.mtime.toISOString(),
    valid: analyzed.valid,
    errors: analyzed.errors,
  }
}

/** @param {number} size @returns {{ name: string, description: string, whenToUse?: string, modelInvocable: boolean, userInvocable: boolean, errors: { field: string, code: string, message: string }[], valid: false }} */
function tooLargeAnalysis(size) {
  return {
    name: '',
    description: '',
    body: '',
    modelInvocable: true,
    userInvocable: true,
    errors: [{
      field: 'file',
      code: 'file-too-large',
      message: `Instruction file is ${size} bytes, above the scan limit.`,
    }],
    valid: false,
  }
}

/**
 * Parse frontmatter and apply the same structural rules the shipped filesystem
 * provider applies before a skill reaches agents. Returns a display name even
 * for invalid entries so the page can still list them.
 * @param {string} raw file text
 * @param {string} entryName filesystem-derived name
 * @returns {{ name: string, description: string, whenToUse?: string, modelInvocable: boolean, userInvocable: boolean, errors: { field: string, code: string, message: string }[], valid: boolean }}
 */
function analyzeFrontmatter(raw, entryName) {
  /** @type {{ field: string, code: string, message: string }[]} */
  const errors = []
  /** @type {Record<string, unknown>} */
  let data = {}
  /** @type {string} */
  let body = ''
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  try {
    const parsed = parseFrontmatter(raw)
    if (parsed === undefined) {
      errors.push({
        field: 'frontmatter',
        code: 'missing-frontmatter',
        message: 'The file does not start with a complete `---` YAML frontmatter block.',
      })
    } else {
      data = parsed.data
      body = parsed.body
    }
  } catch (error) {
    errors.push({
      field: 'frontmatter',
      code: 'invalid-frontmatter',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  let name = entryName
  /** @type {string} */
  let description = ''
  /** @type {string | undefined} */
  let whenToUse
  let modelInvocable = true
  let userInvocable = true

  if (errors.length === 0) {
    const rawName = data.name
    if (typeof rawName !== 'string' || rawName.trim() === '') {
      errors.push({ field: 'name', code: 'required', message: 'Frontmatter requires a non-empty name.' })
    } else if (!isKebabCase(rawName)) {
      errors.push({
        field: 'name',
        code: 'invalid',
        message: `Skill name "${rawName}" is not kebab-case.`,
      })
    } else {
      name = rawName
    }
    const rawDescription = data.description
    if (typeof rawDescription !== 'string' || rawDescription.trim() === '') {
      errors.push({ field: 'description', code: 'required', message: 'Frontmatter requires a non-empty description.' })
    } else {
      description = rawDescription.trim()
    }
    try {
      rejectLegacyInvocationKeys(data)
      const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
      const rawUserInvocable = frontmatterBoolean(data, 'user-invocable')
      modelInvocable = disableModelInvocation !== true
      userInvocable = rawUserInvocable !== false
    } catch (error) {
      errors.push({
        field: 'invocation',
        code: 'invalid',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    if (typeof data.whenToUse === 'string' && data.whenToUse.trim() !== '') whenToUse = data.whenToUse.trim()
  }

  if (errors.length > 0 && description.length > DESCRIPTION_TRUNCATED_LENGTH) {
    // The fixed SkillEntry shape has no `warnings` field; when the entry is
    // already invalid, surface the catalog-truncation hint through `errors`
    // (Lead-refined: a warning flag for long installed entries, shape intact).
    errors.push({
      field: 'description',
      code: 'description-truncated',
      message: `Descriptions longer than ${DESCRIPTION_TRUNCATED_LENGTH} characters are truncated in the agent catalog.`,
    })
  }

  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    modelInvocable,
    userInvocable,
    body,
    errors,
    valid: errors.length === 0,
  }
}

/**
 * The shipped provider rejects camelCase invocation keys instead of reading
 * them; mirror that so `valid` matches what agents actually load.
 * @param {Record<string, unknown>} data
 */
function rejectLegacyInvocationKeys(data) {
  const pairs = [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ]
  for (const [legacy, canonical] of pairs) {
    if (Object.hasOwn(data, legacy)) {
      throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
    }
  }
}

/**
 * Sort scanned skills deterministically: rank (what agents see first), then
 * name, then relative path.
 * @param {SkillEntry[]} skills
 * @returns {SkillEntry[]}
 */
export function sortSkills(skills) {
  return [...skills].sort((left, right) => (
    left.rank - right.rank
    || left.name.localeCompare(right.name)
    || left.relPath.localeCompare(right.relPath)
  ))
}

/**
 * Load and validate one library entry from disk for an install. The state
 * snapshot is never trusted: this re-reads the file, re-applies the same field
 * rules, and re-confines the path under the library root.
 *
 * @param {object} input
 * @param {{ id: string, label: string, path: string }} input.library configured library
 * @param {string} input.relPath library-relative instruction path from `/api/state`
 * @param {number} input.maxSkillBytes body cap
 * @returns {Promise<
 *   { ok: true, entry: { name: string, description: string, whenToUse?: string, modelInvocable: boolean, userInvocable: boolean, kind: 'bundle'|'flat', relPath: string, sha256: string, content: Buffer, bundleDir?: string, path: string } }
 *   | { ok: false, code: 'not-found'|'invalid-path'|'invalid-library-skill'|'library-too-large', message: string, errors?: { field: string, code: string, message: string }[] }
 * >}
 */
export async function loadLibraryEntry({ library, relPath, maxSkillBytes }) {
  if (!isSafeRelPath(relPath)) {
    return { ok: false, code: 'invalid-path', message: 'Library relPath must be a relative path inside the library.' }
  }
  const parts = relPath.split('/')
  /** @type {'bundle'|'flat'|undefined} */
  let kind
  if (parts.length === 2 && parts[1] === 'SKILL.md') kind = 'bundle'
  else if (parts.length === 1 && parts[0].endsWith('.md')) kind = 'flat'
  if (kind === undefined) {
    return { ok: false, code: 'not-found', message: 'No library entry exists at this relPath.' }
  }
  let absolutePath
  try {
    absolutePath = resolveInside(library.path, relPath)
  } catch {
    return { ok: false, code: 'invalid-path', message: 'Library relPath escapes the library root.' }
  }
  let fileStat
  try {
    fileStat = await stat(absolutePath)
  } catch {
    return { ok: false, code: 'not-found', message: 'The library entry no longer exists on disk.' }
  }
  if (!fileStat.isFile()) {
    return { ok: false, code: 'not-found', message: 'The library entry is not a regular file.' }
  }
  const readLimit = Math.min(Math.max(maxSkillBytes * 4, 1024 * 1024), HARD_READ_LIMIT)
  if (fileStat.size > readLimit) {
    return {
      ok: false,
      code: 'library-too-large',
      message: `Library instruction file is ${fileStat.size} bytes, above the ${readLimit}-byte install limit.`,
    }
  }
  let buffer
  try {
    buffer = await readFile(absolutePath)
  } catch {
    return { ok: false, code: 'not-found', message: 'The library entry could not be read.' }
  }
  const entryName = kind === 'bundle' ? parts[0] : basename(parts[0], '.md')
  const parsed = analyzeFrontmatter(buffer.toString('utf8'), entryName)
  if (!parsed.valid) {
    return {
      ok: false,
      code: 'invalid-library-skill',
      message: `Library skill "${entryName}" does not pass the DSH skill contract.`,
      errors: parsed.errors,
    }
  }
  const validation = validateFields({
    name: parsed.name,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    modelInvocable: parsed.modelInvocable,
    userInvocable: parsed.userInvocable,
    body: parsed.body,
  }, maxSkillBytes)
  if (validation.errors.length > 0) {
    return {
      ok: false,
      code: 'invalid-library-skill',
      message: `Library skill "${parsed.name}" does not pass the manager field rules.`,
      errors: validation.errors,
    }
  }
  return {
    ok: true,
    warnings: validation.warnings,
    entry: {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
      kind,
      relPath,
      sha256: sha256(buffer),
      content: buffer,
      ...kind === 'bundle' ? { bundleDir: resolveInside(library.path, parts[0]) } : {},
      path: absolutePath,
    },
  }
}

/**
 * Scan every configured library and compute each entry's install status
 * against the installed set.
 * @param {object} input
 * @param {import('./config.js').SkillsManagerConfig} input.config
 * @param {SkillEntry[]} input.skills installed entries across roots
 * @returns {Promise<import('./scan.js').Library[]>}
 */
export async function scanLibraries({ config, skills }) {
  /** @type {Library[]} */
  const libraries = []
  for (const library of config.libraries) {
    const exists = await pathIsDirectory(library.path)
    /** @type {(LibrarySkill & { relPath: string })[]} */
    const entries = []
    if (exists) {
      const pseudoRoot = /** @type {import('./roots.js').SkillRoot} */ ({
        id: library.id,
        label: library.label,
        path: library.path,
        scope: 'custom',
        rank: 0,
        writable: false,
        exists: true,
      })
      for (const entry of await scanRoot(pseudoRoot, config)) {
        if (!entry.valid) continue
        const status = computeLibraryStatus(entry, skills)
        entries.push({
          name: entry.name,
          description: entry.description,
          kind: entry.kind,
          relPath: entry.relPath,
          sha256: entry.sha256,
          ...status.installed === undefined ? {} : { installed: status.installed },
          ...status.conflict === undefined ? {} : { conflict: status.conflict },
          status: status.status,
        })
      }
      entries.sort((left, right) => codepointCompare(left.name, right.name) || codepointCompare(left.relPath, right.relPath))
    }
    libraries.push({
      id: library.id,
      label: library.label,
      path: library.path,
      exists,
      kind: 'skills',
      skills: entries,
    })
  }
  return libraries
}

/**
 * @typedef {object} Library
 * @property {string} id
 * @property {string} label
 * @property {string} path
 * @property {boolean} exists
 * @property {'skills'} kind
 * @property {LibrarySkill[]} skills
 */

/**
 * @typedef {object} LibrarySkill
 * @property {string} name
 * @property {string} description
 * @property {'bundle'|'flat'} kind
 * @property {string} relPath
 * @property {string} sha256
 * @property {'installed'|'update'|'available'|'conflict'} status
 * @property {{ rootId: string, relPath: string, sha256: string }} [installed]
 * @property {import('./validate.js').Conflict} [conflict]
 */

/**
 * Decide whether a library skill is installed, outdated, free, or shadowed.
 * Only `valid` installed entries count; an invalid on-disk copy never makes a
 * library row look installed.
 * @param {{ name: string, sha256: string }} librarySkill
 * @param {SkillEntry[]} skills
 * @returns {{ status: 'installed'|'update'|'available'|'conflict', installed?: { rootId: string, relPath: string, sha256: string }, conflict?: import('./validate.js').Conflict }}
 */
export function computeLibraryStatus(librarySkill, skills) {
  const sameName = skills.filter(skill => skill.valid === true && skill.name === librarySkill.name)
  const writableCopy = sameName.find(skill => skill.writable === true)
  if (writableCopy !== undefined) {
    const record = { rootId: writableCopy.rootId, relPath: writableCopy.relPath, sha256: writableCopy.sha256 }
    return writableCopy.sha256 === librarySkill.sha256
      ? { status: 'installed', installed: record }
      : { status: 'update', installed: record }
  }
  const shadowing = [...sameName]
    .filter(skill => skill.writable !== true)
    .sort((left, right) => left.rank - right.rank || left.rootId.localeCompare(right.rootId))
  if (shadowing.length > 0) {
    // A byte-identical copy already in a read-only root means agents can load
    // exactly this library entry; there is nothing to install. Only differing
    // content is a shadowing conflict (installing would be shadowed).
    const identical = shadowing.find(skill => skill.sha256 === librarySkill.sha256)
    if (identical !== undefined) {
      return {
        status: 'installed',
        installed: { rootId: identical.rootId, relPath: identical.relPath, sha256: identical.sha256 },
      }
    }
    return {
      status: 'conflict',
      conflict: computeLibraryConflict(librarySkill.name, shadowing.map(conflictEntry)),
    }
  }
  return { status: 'available' }
}

/**
 * The state-wide conflict list for a scan.
 * @param {SkillEntry[]} skills
 * @returns {import('./validate.js').Conflict[]}
 */
export function scanConflicts(skills) {
  return detectConflicts(skills)
}
