/**
 * Mutations: atomic create/update/delete/install with path and symlink
 * containment.
 *
 * Every write funnels through here. The contract is: only the configured
 * writable root, never through a symlink, never outside the root lexically or
 * physically, and content lands via a same-directory temp file + rename so a
 * crash leaves either the old or the new file. All functions throw a
 * `MutationError` with a stable `code` that the HTTP layer maps to a status.
 *
 * @module dsh-skills-studio/mutate
 */

import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

import { serializeSkillFile } from './frontmatter.js'
import { isSafeRelPath, resolveInside } from './roots.js'
import { sha256 } from './scan.js'

/** Raised when a mutation is refused or fails. `code` is a stable API error code. */
export class MutationError extends Error {
  /**
   * @param {string} code stable API error code
   * @param {string} message human-readable diagnostic
   * @param {Record<string, unknown>} [details] optional structured context
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'MutationError'
    this.code = code
    this.details = details
  }
}

/** Upper bound while copying a library bundle into the writable root. */
const MAX_BUNDLE_FILES = 512
/** Byte bound while copying a library bundle into the writable root. */
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024
/** Maximum directory nesting inside a bundle (resources only). */
const MAX_BUNDLE_DEPTH = 8

/** @typedef {object} BundleSource
 * @property {'bundle'|'flat'} kind
 * @property {string} name validated kebab-case name
 * @property {Buffer} content instruction-file bytes
 * @property {string} [bundleDir] absolute source bundle directory, for `bundle` sources
 */

/**
 * Build the exact bytes written for a draft.
 * @param {object} fields validated draft fields
 * @returns {string} markdown instruction file
 */
export function buildSkillFile(fields) {
  return serializeSkillFile({
    name: fields.name,
    description: fields.description,
    whenToUse: fields.whenToUse,
    modelInvocable: fields.modelInvocable,
    userInvocable: fields.userInvocable,
    body: fields.body,
  })
}

/**
 * Whether a filesystem error means "not there".
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbsent(error) {
  const code = /** @type {{ code?: string }} */ (error)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * @param {unknown} error
 * @param {string} context
 * @returns {MutationError}
 */
function wrapFsError(error, context) {
  if (error instanceof MutationError) return error
  const code = /** @type {{ code?: string }} */ (error)?.code
  if (code === 'EACCES' || code === 'EPERM') {
    return new MutationError('permission-denied', `${context}: permission denied`, { cause: String(error) })
  }
  if (code === 'ENOSPC' || code === 'EROFS') {
    return new MutationError('filesystem-unavailable', `${context}: ${code}`, { cause: String(error) })
  }
  return new MutationError('internal', `${context}: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * `lstat` that returns `undefined` for absent paths and rejects symlinks.
 * @param {string} path
 * @param {string} context
 * @returns {Promise<import('node:fs').Stats | undefined>}
 */
async function lstatExisting(path, context) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isAbsent(error)) return undefined
    throw wrapFsError(error, context)
  }
  if (info.isSymbolicLink()) {
    throw new MutationError('symlink-target', `Refusing to operate through a symbolic link: ${path}`)
  }
  return info
}

/**
 * Reject symlinks anywhere between the root and `targetPath`. Used before
 * writing resources into an existing bundle, where a pre-existing symlinked
 * subdirectory could otherwise redirect the copy outside the root.
 * @param {string} rootPath
 * @param {string} targetPath absolute path inside the root
 * @returns {Promise<void>}
 */
async function assertContainedPath(rootPath, targetPath) {
  const rel = relative(rootPath, targetPath)
  if (rel === '') return
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new MutationError('invalid-path', 'Refusing to write outside the writable root.')
  }
  let current = rootPath
  for (const segment of rel.split(sep)) {
    current = join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (isAbsent(error)) return
      throw wrapFsError(error, 'stat destination directory')
    }
    if (info.isSymbolicLink()) {
      throw new MutationError('symlink-target', `Refusing to write through a symbolic link: ${current}`)
    }
    if (!info.isDirectory()) {
      throw new MutationError('invalid-path', `A non-directory occupies the path: ${current}`)
    }
  }
}

/**
 * Ensure the configured writable root exists as a directory.
 * @param {import('./roots.js').SkillRoot} root
 * @returns {Promise<void>}
 */
async function ensureRootDir(root) {
  if (root.writable !== true) {
    throw new MutationError('read-only', `Root "${root.label}" is not writable.`)
  }
  try {
    await mkdir(root.path, { recursive: true })
  } catch (error) {
    throw wrapFsError(error, 'create root directory')
  }
  const info = await lstatExisting(root.path, 'stat root directory')
  if (info === undefined || !info.isDirectory()) {
    throw new MutationError('invalid-path', `Writable root is not a directory: ${root.path}`)
  }
}

/**
 * Create (or verify) every component of a directory chain under the root,
 * refusing symlinks so `mkdir -p` can never be tricked into writing outside.
 * @param {string} rootPath
 * @param {string[]} segments directory segments below the root
 * @returns {Promise<void>}
 */
async function ensureDirectoryChain(rootPath, segments) {
  let current = rootPath
  for (const segment of segments) {
    current = join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (!isAbsent(error)) throw wrapFsError(error, 'stat directory')
      try {
        await mkdir(current)
      } catch (mkdirError) {
        if (/** @type {{ code?: string }} */ (mkdirError)?.code !== 'EEXIST') {
          throw wrapFsError(mkdirError, 'create directory')
        }
      }
      try {
        info = await lstat(current)
      } catch (statError) {
        throw wrapFsError(statError, 'stat directory')
      }
    }
    if (info.isSymbolicLink()) {
      throw new MutationError('symlink-target', `Refusing to write through a symbolic link: ${current}`)
    }
    if (!info.isDirectory()) {
      throw new MutationError('invalid-path', `A non-directory occupies the path: ${current}`)
    }
  }
}

/**
 * Atomically write one file: temp sibling with `wx`, `rename` over the target,
 * mode 0644, temp removed on failure.
 * @param {string} targetPath
 * @param {string|Buffer} content
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(targetPath, content) {
  const tempPath = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tempPath, content, { mode: 0o644, flag: 'wx' })
    await rename(tempPath, targetPath)
    await chmod(targetPath, 0o644)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw wrapFsError(error, `write ${basename(targetPath)}`)
  }
}

/**
 * Split a safe relative instruction path into its directory segments and file.
 * @param {string} relPath
 * @returns {{ segments: string[], fileName: string }}
 */
function splitRelPath(relPath) {
  if (!isSafeRelPath(relPath)) {
    throw new MutationError('invalid-path', `Unsafe relative path: ${JSON.stringify(relPath)}`)
  }
  const parts = relPath.split('/')
  const fileName = /** @type {string} */ (parts.pop())
  return { segments: parts, fileName }
}

/**
 * Create a new skill file. `relPath` was computed and validated by
 * `validateDraft`; this side re-checks existence and containment.
 * @param {object} input
 * @param {import('./roots.js').SkillRoot} input.root writable root
 * @param {string} input.relPath `name/SKILL.md` or `name.md`
 * @param {string} input.markdown serialized instruction file
 * @returns {Promise<{ path: string, relPath: string }>}
 */
export async function createSkill({ root, relPath, markdown }) {
  const { segments } = splitRelPath(relPath)
  await ensureRootDir(root)
  const targetPath = resolveInside(root.path, relPath)
  if (await lstatExisting(targetPath, 'stat target') !== undefined) {
    throw new MutationError('target-exists', 'A skill already exists at this path; edit it instead.')
  }
  if (segments.length > 0) {
    const occupiedDir = await lstatExisting(resolveInside(root.path, segments.join('/')), 'stat bundle directory')
    if (occupiedDir !== undefined) {
      throw new MutationError('target-exists', 'A file or directory already occupies this skill path.')
    }
    await ensureDirectoryChain(root.path, segments)
  }
  await atomicWriteFile(targetPath, markdown)
  return { path: targetPath, relPath }
}

/**
 * Overwrite an existing skill file after verifying the optimistic sha.
 * @param {object} input
 * @param {import('./roots.js').SkillRoot} input.root writable root
 * @param {string} input.relPath path relative to the root
 * @param {string} input.markdown new serialized instruction file
 * @param {string} input.expectedSha256 sha the caller read
 * @returns {Promise<{ path: string, relPath: string }>}
 */
export async function updateSkill({ root, relPath, markdown, expectedSha256 }) {
  const { segments } = splitRelPath(relPath)
  await ensureRootDir(root)
  const targetPath = resolveInside(root.path, relPath)
  const info = await lstatExisting(targetPath, 'stat target')
  if (info === undefined) throw new MutationError('not-found', 'This skill no longer exists on disk.')
  if (!info.isFile()) throw new MutationError('not-found', 'This skill target is not a regular file.')
  if (typeof expectedSha256 !== 'string' || expectedSha256 === '') {
    throw new MutationError('stale', 'expectedSha256 is required to update a skill.')
  }
  let current
  try {
    current = await readFile(targetPath)
  } catch (error) {
    if (isAbsent(error)) throw new MutationError('not-found', 'This skill no longer exists on disk.')
    throw wrapFsError(error, 'read target')
  }
  if (sha256(current) !== expectedSha256) {
    throw new MutationError('stale', 'The file changed on disk since it was loaded; reload the skill and try again.', {
      expected: expectedSha256,
      actual: sha256(current),
    })
  }
  await ensureDirectoryChain(root.path, segments)
  await atomicWriteFile(targetPath, markdown)
  return { path: targetPath, relPath }
}

/**
 * Refuse to recursively delete a bundle that contains symlinks (which could
 * point outside) or special files.
 * @param {string} dir
 * @param {number} [depth]
 * @returns {Promise<void>}
 */
async function assertSafeBundleTree(dir, depth = 0) {
  if (depth > MAX_BUNDLE_DEPTH) {
    throw new MutationError('invalid-path', 'Bundle directory is nested too deeply to delete safely.')
  }
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw wrapFsError(error, 'read bundle directory')
  }
  for (const dirent of dirents) {
    const child = join(dir, dirent.name)
    let info
    try {
      info = await lstat(child)
    } catch (error) {
      throw wrapFsError(error, 'stat bundle entry')
    }
    if (info.isSymbolicLink()) {
      throw new MutationError('symlink-target', `Bundle contains a symbolic link (${dirent.name}); refusing to delete it.`)
    }
    if (info.isDirectory()) {
      await assertSafeBundleTree(child, depth + 1)
    } else if (!info.isFile()) {
      throw new MutationError('invalid-path', `Bundle contains a special file (${dirent.name}); refusing to delete it.`)
    }
  }
}

/**
 * Delete one skill entry after verifying the optimistic sha. A bundle removes
 * its own directory; a flat skill removes one file.
 * @param {object} input
 * @param {import('./roots.js').SkillRoot} input.root writable root
 * @param {string} input.relPath path relative to the root
 * @param {string} input.expectedSha256 sha the caller read
 * @returns {Promise<{ relPath: string, name: string }>}
 */
export async function deleteSkill({ root, relPath, expectedSha256 }) {
  const { segments, fileName } = splitRelPath(relPath)
  await ensureRootDir(root)
  const targetPath = resolveInside(root.path, relPath)
  const info = await lstatExisting(targetPath, 'stat target')
  if (info === undefined || !info.isFile()) {
    throw new MutationError('not-found', 'This skill no longer exists on disk.')
  }
  if (typeof expectedSha256 !== 'string' || expectedSha256 === '') {
    throw new MutationError('stale', 'expectedSha256 is required to delete a skill.')
  }
  let current
  try {
    current = await readFile(targetPath)
  } catch (error) {
    if (isAbsent(error)) throw new MutationError('not-found', 'This skill no longer exists on disk.')
    throw wrapFsError(error, 'read target')
  }
  if (sha256(current) !== expectedSha256) {
    throw new MutationError('stale', 'The file changed on disk since it was loaded; reload the skill and try again.', {
      expected: expectedSha256,
      actual: sha256(current),
    })
  }
  const isBundle = segments.length === 1 && fileName === 'SKILL.md'
  if (isBundle) {
    const bundleDir = dirname(targetPath)
    if (bundleDir === root.path) {
      throw new MutationError('invalid-path', 'Refusing to delete the writable root itself.')
    }
    const bundleInfo = await lstatExisting(bundleDir, 'stat bundle directory')
    if (bundleInfo === undefined || !bundleInfo.isDirectory()) {
      throw new MutationError('invalid-path', 'Bundle directory is missing or not a directory.')
    }
    await assertSafeBundleTree(bundleDir)
    try {
      await rm(bundleDir, { recursive: true, force: false })
    } catch (error) {
      throw wrapFsError(error, 'delete bundle directory')
    }
    return { relPath, name: segments[0] }
  }
  try {
    await unlink(targetPath)
  } catch (error) {
    if (isAbsent(error)) throw new MutationError('not-found', 'This skill no longer exists on disk.')
    throw wrapFsError(error, 'delete skill file')
  }
  return { relPath, name: fileName.endsWith('.md') ? basename(fileName, '.md') : basename(fileName) }
}

/**
 * Copy a library bundle's resource files into a destination directory, bounded
 * in file count and bytes. The top-level `SKILL.md` is handled by the caller so
 * the validated bytes are the ones written.
 * @param {string} sourceDir
 * @param {string} destinationDir
 * @returns {Promise<void>}
 */
async function copyBundleResources(sourceDir, destinationDir, rootPath) {
  const budget = { files: 0, bytes: 0 }
  await copyBundleLevel(sourceDir, destinationDir, rootPath, 0, budget)
}

/**
 * @param {string} sourceDir
 * @param {string} destinationDir
 * @param {string} rootPath writable root; every destination component is checked for symlinks
 * @param {number} depth
 * @param {{ files: number, bytes: number }} budget
 */
async function copyBundleLevel(sourceDir, destinationDir, rootPath, depth, budget) {
  if (depth >= MAX_BUNDLE_DEPTH) {
    throw new MutationError('library-too-large', 'Library bundle is nested too deeply.')
  }
  let dirents
  try {
    dirents = await readdir(sourceDir, { withFileTypes: true })
  } catch (error) {
    if (isAbsent(error)) return
    throw wrapFsError(error, 'read library bundle')
  }
  dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue
    if (depth === 0 && dirent.name === 'SKILL.md') continue
    const sourcePath = join(sourceDir, dirent.name)
    const destinationPath = join(destinationDir, dirent.name)
    let info
    try {
      info = await lstat(sourcePath)
    } catch (error) {
      throw wrapFsError(error, 'stat library entry')
    }
    if (info.isSymbolicLink()) {
      throw new MutationError('symlink-source', `Library bundle contains a symbolic link (${dirent.name}); refusing to copy it.`)
    }
    if (info.isDirectory()) {
      await assertContainedPath(rootPath, destinationPath)
      try {
        await mkdir(destinationPath, { recursive: true })
      } catch (error) {
        throw wrapFsError(error, 'create resource directory')
      }
      await copyBundleLevel(sourcePath, destinationPath, rootPath, depth + 1, budget)
      continue
    }
    if (!info.isFile()) {
      throw new MutationError('invalid-library-skill', `Library bundle contains a special file (${dirent.name}).`)
    }
    budget.files += 1
    if (budget.files > MAX_BUNDLE_FILES) {
      throw new MutationError('library-too-large', `Library bundle has more than ${MAX_BUNDLE_FILES} files.`)
    }
    budget.bytes += info.size
    if (budget.bytes > MAX_BUNDLE_BYTES) {
      throw new MutationError('library-too-large', `Library bundle exceeds ${MAX_BUNDLE_BYTES} bytes.`)
    }
    await assertContainedPath(rootPath, dirname(destinationPath))
    let content
    try {
      content = await readFile(sourcePath)
    } catch (error) {
      throw wrapFsError(error, 'read library resource')
    }
    await atomicWriteFile(destinationPath, content)
  }
}

/**
 * Install (or update) one library skill into the writable root.
 *
 * Status decisions (already installed / needs overwrite / stale) are made by
 * the caller against a fresh scan; this function only enforces the write
 * contract and copies bundle resources.
 *
 * @param {object} input
 * @param {import('./roots.js').SkillRoot} input.root writable root
 * @param {BundleSource} input.source validated library entry
 * @param {import('./scan.js').SkillEntry} [input.installed] current writable copy, when updating
 * @param {boolean} [input.overwrite] required to replace an installed copy
 * @param {string} [input.expectedSha256] sha of the installed copy the caller read
 * @returns {Promise<{ relPath: string, kind: 'bundle'|'flat', path: string }>}
 */
export async function installSkill({ root, source, installed, overwrite = false, expectedSha256 }) {
  await ensureRootDir(root)
  if (installed !== undefined) {
    if (overwrite !== true) {
      throw new MutationError('overwrite-required', 'Replacing an installed skill requires overwrite: true.')
    }
    if (typeof expectedSha256 !== 'string' || expectedSha256 === '') {
      throw new MutationError('stale', 'expectedSha256 is required to update an installed skill.')
    }
    if (expectedSha256 !== installed.sha256) {
      throw new MutationError('stale', 'The installed copy changed on disk since it was read; refresh and try again.')
    }
    const relPath = installed.relPath
    const { segments } = splitRelPath(relPath)
    await ensureDirectoryChain(root.path, segments)
    const targetPath = resolveInside(root.path, relPath)
    if (installed.kind === 'bundle') {
      const targetDir = dirname(targetPath)
      const info = await lstatExisting(targetDir, 'stat bundle directory')
      if (info === undefined || !info.isDirectory()) {
        throw new MutationError('invalid-path', 'Installed bundle directory is missing.')
      }
      if (source.kind === 'bundle' && source.bundleDir !== undefined) {
        await copyBundleResources(source.bundleDir, targetDir, root.path)
      }
      await atomicWriteFile(targetPath, source.content)
    } else {
      // A flat install cannot carry bundle resources; the instruction file is the skill.
      await atomicWriteFile(targetPath, source.content)
    }
    return { relPath, kind: installed.kind, path: targetPath }
  }

  if (source.kind === 'bundle') {
    const relPath = `${source.name}/SKILL.md`
    const targetDir = resolveInside(root.path, source.name)
    const targetPath = resolveInside(root.path, relPath)
    if (await lstatExisting(targetDir, 'stat bundle directory') !== undefined) {
      throw new MutationError('target-exists', 'A skill directory already occupies this name.')
    }
    const tempDir = join(root.path, `.${source.name}.tmp-${randomBytes(6).toString('hex')}`)
    try {
      try {
        await mkdir(tempDir)
      } catch (error) {
        throw wrapFsError(error, 'create temporary bundle directory')
      }
      if (source.bundleDir !== undefined) await copyBundleResources(source.bundleDir, tempDir, root.path)
      try {
        await writeFile(join(tempDir, 'SKILL.md'), source.content, { mode: 0o644, flag: 'wx' })
        await chmod(join(tempDir, 'SKILL.md'), 0o644)
      } catch (error) {
        throw wrapFsError(error, 'write temporary SKILL.md')
      }
      try {
        await rename(tempDir, targetDir)
      } catch (error) {
        throw wrapFsError(error, 'install bundle')
      }
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return { relPath, kind: 'bundle', path: targetPath }
  }

  const relPath = `${source.name}.md`
  const targetPath = resolveInside(root.path, relPath)
  if (await lstatExisting(targetPath, 'stat target') !== undefined) {
    throw new MutationError('target-exists', 'A skill file already occupies this name.')
  }
  await atomicWriteFile(targetPath, source.content)
  return { relPath, kind: 'flat', path: targetPath }
}
