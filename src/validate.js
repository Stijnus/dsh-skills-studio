/**
 * Validation, conflict detection, and description-overlap warnings.
 *
 * Validation is split in two layers: pure field rules that never touch the
 * filesystem (`validateFields`), and `validateDraft`, which additionally
 * resolves the target root/path, checks optimistic-concurrency sha, and reports
 * the conflicts a save would create. `detectConflicts` is the same name/alias/
 * overlap analysis applied to the already-scanned installed set.
 *
 * @module dsh-skills-manager/validate
 */

import { lstat } from 'node:fs/promises'

import { isKebabCase } from './frontmatter.js'
import { isSafeRelPath, resolveInside } from './roots.js'

/** Longest accepted skill name. */
export const NAME_MAX_LENGTH = 64
/** Hard description limit; longer descriptions are a field error. */
export const DESCRIPTION_MAX_LENGTH = 1024
/** The agent catalog truncates rendered descriptions at this many characters. */
export const DESCRIPTION_TRUNCATED_LENGTH = 500
/** Hard `whenToUse` limit. */
export const WHEN_TO_USE_MAX_LENGTH = 512
/** Maximum number of description-overlap warnings returned. */
export const MAX_OVERLAP_WARNINGS = 5
/** Jaccard score at which two descriptions are considered competing routing triggers. */
export const OVERLAP_THRESHOLD = 0.5

/** Conflicts `force:true` may bypass. Field errors and stale checks never are. */
export const FORCE_BYPASSABLE_CODES = Object.freeze(new Set(['duplicate-name', 'alias-collision']))

/**
 * Words too common to indicate that two descriptions compete for the same task.
 * Same list the deepseek-stack `tools/conflicts.mjs` uses, so the panel and the
 * pack's own audit agree on what "overlap" means.
 */
const STOP_WORDS = new Set((
  'a an the and or but if then than that this these those to of in on at for with without '
  + 'from by as is are was were be been being it its their your you we i they he she not no do does did done '
  + 'use uses used using when while before after so such can could should would may might must will shall '
  + 'one two first next last any all each every other same own just only also very more most much many '
  + 'skill skills agent agents task tasks work works working help helps'
).split(/\s+/))

/**
 * @typedef {object} Conflict
 * @property {string} code `duplicate-name` | `alias-collision` | `overlap` | warning codes
 * @property {'error'|'warning'} severity
 * @property {string} name affected skill name (or the pair for overlap)
 * @property {string} message human-readable explanation
 * @property {{ rootId: string, rootLabel: string, relPath: string, path: string, rank: number }[]} entries
 * @property {string[]} [sharedWords]
 */

/**
 * @typedef {object} FieldError
 * @property {string} field
 * @property {string} code
 * @property {string} message
 */

/**
 * Lowercase alphanumeric words longer than two characters, minus stop words.
 * @param {string} text
 * @returns {Set<string>}
 */
export function descriptionTokens(text) {
  const words = new Set()
  for (const word of String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (word.length > 2 && !STOP_WORDS.has(word)) words.add(word)
  }
  return words
}

/**
 * Jaccard similarity of two token sets: intersection over union. Empty input on
 * either side scores 0.
 * @param {Set<string>} left
 * @param {Set<string>} right
 * @returns {number}
 */
export function jaccard(left, right) {
  const union = new Set([...left, ...right])
  if (union.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / union.size
}

/**
 * @param {string} text quoted inside the overlap message
 * @param {number} score
 * @param {string[]} sharedWords
 * @returns {string}
 */
function overlapMessage(text, score, sharedWords) {
  const words = sharedWords.length > 0 ? `shared words: ${sharedWords.join(', ')}` : 'shared wording'
  return `Descriptions overlap (Jaccard ${score.toFixed(2)}; ${words}); ${text}`
}

/**
 * Project a scanned skill entry onto the compact entry shape a Conflict carries.
 * @param {{ rootId: string, rootLabel: string, relPath: string, path: string, rank: number }} entry
 * @returns {{ rootId: string, rootLabel: string, relPath: string, path: string, rank: number }}
 */
export function conflictEntry(entry) {
  return {
    rootId: entry.rootId,
    rootLabel: entry.rootLabel,
    relPath: entry.relPath,
    path: entry.path,
    rank: entry.rank,
  }
}

/**
 * Build a `duplicate-name` conflict from two or more entries with one name.
 * @param {string} name
 * @param {Array<{ rootLabel: string, rank: number }>} entries
 * @param {import('./validate.js').Conflict['entries']} projected
 * @param {number} count
 * @returns {Conflict}
 */
function duplicateConflict(name, entries, projected, count) {
  const sorted = [...entries].sort((left, right) => left.rank - right.rank)
  const rootIds = new Set(sorted.map(entry => entry.rootId))
  if (rootIds.size === 1) {
    const label = sorted[0].rootLabel
    const message = count === 2
      ? `The name "${name}" is used twice in ${label}; only one can be served.`
      : `The name "${name}" is used ${count} times in ${label}; only one can be served.`
    return { code: 'duplicate-name', severity: 'error', name, message, entries: projected }
  }
  const winner = sorted[0]
  const message = count === 2
    ? `Same name in ${sorted[0].rootLabel} rank ${sorted[0].rank} and ${sorted[1].rootLabel} rank ${sorted[1].rank}; rank ${winner.rank} wins and shadows the other.`
    : `Same name in ${sorted.map(entry => `${entry.rootLabel} rank ${entry.rank}`).join(', ')}; rank ${winner.rank} wins and shadows the others.`
  return { code: 'duplicate-name', severity: 'error', name, message, entries: projected }
}

/**
 * All conflicts present in the installed scan: duplicate names, flat-vs-bundle
 * alias collisions, and up to five description-overlap warnings.
 * @param {import('./scan.js').SkillEntry[]} skills scanned entries across roots
 * @returns {Conflict[]}
 */
export function detectConflicts(skills) {
  const valid = (Array.isArray(skills) ? skills : []).filter(skill => skill.valid === true)
  /** @type {Conflict[]} */
  const errors = []

  /** @type {Map<string, import('./scan.js').SkillEntry[]>} */
  const byName = new Map()
  for (const skill of valid) {
    const group = byName.get(skill.name)
    if (group === undefined) byName.set(skill.name, [skill])
    else group.push(skill)
  }
  for (const [name, group] of byName) {
    if (group.length > 1) {
      const sorted = [...group].sort((left, right) => left.rank - right.rank || left.rootId.localeCompare(right.rootId))
      errors.push(duplicateConflict(name, sorted, sorted.map(conflictEntry), sorted.length))
    }
  }

  // Alias collisions are filesystem-level: an invalid `name.md` still occupies
  // the flat entry, so the pair is reported even when one side failed to parse.
  /** @type {Map<string, import('./scan.js').SkillEntry[]>} */
  const byRootEntry = new Map()
  const allSkills = Array.isArray(skills) ? skills : []
  for (const skill of allSkills) {
    const key = `${skill.rootId}\u0000${skill.entryName}`
    const group = byRootEntry.get(key)
    if (group === undefined) byRootEntry.set(key, [skill])
    else group.push(skill)
  }
  for (const group of byRootEntry.values()) {
    if (group.length < 2) continue
    const flat = group.find(skill => skill.kind === 'flat')
    const bundle = group.find(skill => skill.kind === 'bundle')
    if (flat === undefined || bundle === undefined) continue
    errors.push({
      code: 'alias-collision',
      severity: 'error',
      name: flat.name,
      message: `Flat file "${flat.relPath}" and bundle "${bundle.relPath}" in ${flat.rootLabel} both claim the same skill entry; remove one of them.`,
      entries: [flat, bundle].map(conflictEntry),
    })
  }
  errors.sort((left, right) => left.name.localeCompare(right.name) || left.code.localeCompare(right.code))

  return [...errors, ...overlapWarningsFor(valid)]
}

/**
 * Description-overlap warnings across a set of scanned entries.
 * @param {import('./scan.js').SkillEntry[]} skills
 * @returns {Conflict[]}
 */
export function overlapWarningsFor(skills) {
  const candidates = skills.filter(skill => typeof skill.description === 'string' && skill.description.trim() !== '')
  const tokens = new Map(candidates.map(skill => [skill, descriptionTokens(skill.description)]))
  /** @type {{ score: number, left: import('./scan.js').SkillEntry, right: import('./scan.js').SkillEntry, shared: string[] }[]} */
  const pairs = []
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]
      const right = candidates[j]
      const leftTokens = tokens.get(left)
      const rightTokens = tokens.get(right)
      if (leftTokens === undefined || rightTokens === undefined) continue
      const score = jaccard(leftTokens, rightTokens)
      if (score < OVERLAP_THRESHOLD) continue
      const shared = [...leftTokens].filter(token => rightTokens.has(token)).sort()
      pairs.push({ score, left, right, shared })
    }
  }
  pairs.sort((left, right) => (
    right.score - left.score
    || left.left.name.localeCompare(right.right.name)
    || left.right.name.localeCompare(right.right.name)
  ))
  return pairs.slice(0, MAX_OVERLAP_WARNINGS).map(pair => ({
    code: 'overlap',
    severity: 'warning',
    name: `${pair.left.name} / ${pair.right.name}`,
    message: overlapMessage(
      `"${pair.left.name}" and "${pair.right.name}" may compete for the same requests.`,
      pair.score,
      pair.shared,
    ),
    entries: [conflictEntry(pair.left), conflictEntry(pair.right)],
    sharedWords: pair.shared,
  }))
}

/**
 * Overlap warnings for one candidate (a draft or a library entry) against the
 * installed set. Warnings are capped like the state-wide list; the pair is the
 * unit of deduplication.
 * @param {object} input
 * @param {string} input.name candidate name
 * @param {string} input.description candidate description
 * @param {{ rootId: string, rootLabel: string, relPath: string, path: string, rank: number } | undefined} input.entry candidate entry, when its path is known
 * @param {import('./scan.js').SkillEntry[]} input.skills installed entries, candidate already excluded
 * @returns {Conflict[]}
 */
export function overlapWarningsForCandidate({ name, description, entry, skills }) {
  const candidateTokens = descriptionTokens(description)
  /** @type {{ score: number, other: import('./scan.js').SkillEntry, shared: string[] }[]} */
  const hits = []
  for (const other of skills) {
    if (other.valid !== true || typeof other.description !== 'string') continue
    const otherTokens = descriptionTokens(other.description)
    const score = jaccard(candidateTokens, otherTokens)
    if (score < OVERLAP_THRESHOLD) continue
    const shared = [...candidateTokens].filter(token => otherTokens.has(token)).sort()
    hits.push({ score, other, shared })
  }
  hits.sort((left, right) => right.score - left.score || left.other.name.localeCompare(right.other.name))
  return hits.slice(0, MAX_OVERLAP_WARNINGS).map(hit => ({
    code: 'overlap',
    severity: 'warning',
    name,
    message: overlapMessage(
      `"${name}" and "${hit.other.name}" may compete for the same requests.`,
      hit.score,
      hit.shared,
    ),
    entries: entry === undefined ? [conflictEntry(hit.other)] : [entry, conflictEntry(hit.other)],
    sharedWords: hit.shared,
  }))
}

/**
 * The conflict a library skill carries when its name is already provided by a
 * read-only root: installing it would be shadowed by the lower rank.
 * @param {string} name library skill name
 * @param {Conflict['entries']} entries already-projected existing entries
 * @returns {Conflict}
 */
export function computeLibraryConflict(name, entries) {
  const sorted = [...entries].sort((left, right) => left.rank - right.rank)
  const where = sorted.map(entry => `${entry.rootLabel} rank ${entry.rank}`).join(', ')
  return {
    code: 'duplicate-name',
    severity: 'error',
    name,
    message: `Same name is already provided by ${where}; an installed copy would be shadowed.`,
    entries: sorted,
  }
}

/**
 * The description-truncated warning (Lead-refined threshold: the agent catalog
 * truncates rendered descriptions at 500 characters, so a longer description is
 * legal but loses catalog text).
 * @param {string} name
 * @returns {Conflict}
 */
export function descriptionTruncatedWarning(name) {
  return {
    code: 'description-truncated',
    severity: 'warning',
    name,
    message: `Descriptions longer than ${DESCRIPTION_TRUNCATED_LENGTH} characters are truncated in the agent catalog.`,
    entries: [],
  }
}

/**
 * Pure field validation. Does not touch the filesystem, so both the live form
 * and the save path can share it.
 * @param {Record<string, unknown>} raw draft fields
 * @param {number} maxSkillBytes body cap
 * @returns {{ name: string, description: string, whenToUse: string | undefined, modelInvocable: boolean, userInvocable: boolean, body: string, errors: FieldError[], warnings: Conflict[] }}
 */
export function validateFields(raw, maxSkillBytes) {
  const source = raw === undefined || raw === null || typeof raw !== 'object' ? {} : raw
  /** @type {FieldError[]} */
  const errors = []
  /** @type {Conflict[]} */
  const warnings = []
  /** @type {string} */
  let name = ''
  /** @type {string} */
  let description = ''
  /** @type {string | undefined} */
  let whenToUse
  /** @type {string} */
  let body = ''
  let modelInvocable = true
  let userInvocable = true
  let nameUsable = true

  if (typeof source.name !== 'string' || source.name.trim() === '') {
    errors.push({ field: 'name', code: 'required', message: 'Name is required.' })
    nameUsable = false
  } else {
    name = source.name.trim()
    if (name.length > NAME_MAX_LENGTH) {
      errors.push({ field: 'name', code: 'too-long', message: `Name must be at most ${NAME_MAX_LENGTH} characters.` })
      nameUsable = false
    } else if (!isKebabCase(name)) {
      errors.push({
        field: 'name',
        code: 'invalid',
        message: 'Name must be kebab-case: lowercase letters, digits, and single hyphens.',
      })
      nameUsable = false
    }
  }

  if (typeof source.description !== 'string' || source.description.trim() === '') {
    errors.push({ field: 'description', code: 'required', message: 'Description is required.' })
  } else {
    description = source.description.trim()
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      errors.push({
        field: 'description',
        code: 'too-long',
        message: `Description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`,
      })
    } else if (description.length > DESCRIPTION_TRUNCATED_LENGTH) {
      warnings.push(descriptionTruncatedWarning(nameUsable ? name : ''))
    }
  }

  if (source.whenToUse !== undefined && source.whenToUse !== null && source.whenToUse !== '') {
    if (typeof source.whenToUse !== 'string') {
      errors.push({ field: 'whenToUse', code: 'invalid', message: 'When-to-use must be a string.' })
    } else {
      whenToUse = source.whenToUse.trim()
      if (whenToUse === '') whenToUse = undefined
      else if (whenToUse.length > WHEN_TO_USE_MAX_LENGTH) {
        errors.push({
          field: 'whenToUse',
          code: 'too-long',
          message: `When-to-use must be at most ${WHEN_TO_USE_MAX_LENGTH} characters.`,
        })
      }
    }
  }

  if (source.body !== undefined && source.body !== null) {
    if (typeof source.body !== 'string') {
      errors.push({ field: 'body', code: 'invalid', message: 'Body must be a string.' })
    } else {
      body = source.body
      const bytes = Buffer.byteLength(body, 'utf8')
      if (bytes > maxSkillBytes) {
        errors.push({
          field: 'body',
          code: 'too-large',
          message: `Body is ${bytes} bytes; the limit is ${maxSkillBytes} bytes.`,
        })
      }
    }
  }

  for (const field of ['modelInvocable', 'userInvocable']) {
    const value = source[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'boolean') {
      errors.push({ field, code: 'invalid', message: `${field} must be a boolean.` })
      continue
    }
    if (field === 'modelInvocable') modelInvocable = value
    else userInvocable = value
  }

  return { name, description, whenToUse, modelInvocable, userInvocable, body, errors, warnings }
}

/**
 * `lstat` existence: dangling symlinks count as occupied, so a create never
 * silently replaces one.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function pathOccupied(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

/**
 * Validate one create/update draft against the current filesystem and scanned
 * catalog. Never writes.
 *
 * @param {object} input
 * @param {import('./config.js').SkillsManagerConfig} input.config
 * @param {import('./roots.js').SkillRoot[]} input.roots resolved roots for this request
 * @param {import('./scan.js').SkillEntry[]} input.skills scanned entries for those roots
 * @param {Record<string, unknown>} input.body request body
 * @returns {Promise<{
 *   action: 'create'|'update',
 *   root: import('./roots.js').SkillRoot | undefined,
 *   kind: 'bundle'|'flat' | undefined,
 *   relPath: string | undefined,
 *   targetPath: string | undefined,
 *   entry: import('./scan.js').SkillEntry | undefined,
 *   name: string, description: string, whenToUse: string | undefined,
 *   modelInvocable: boolean, userInvocable: boolean, body: string,
 *   errors: FieldError[], conflicts: Conflict[], warnings: Conflict[],
 * }>}
 */
export async function validateDraft({ config, roots, skills, body }) {
  const source = body !== null && typeof body === 'object' ? body : {}
  const action = source.action === 'update' ? 'update' : 'create'
  const fields = validateFields(source, config.maxSkillBytes)
  const errors = [...fields.errors]
  const conflicts = []
  const warnings = [...fields.warnings]

  /** @type {import('./roots.js').SkillRoot | undefined} */
  let root
  if (typeof source.rootId !== 'string' || source.rootId.trim() === '') {
    errors.push({ field: 'rootId', code: 'required', message: 'A target root is required.' })
  } else {
    root = roots.find(candidate => candidate.id === source.rootId)
    if (root === undefined) {
      errors.push({ field: 'rootId', code: 'not-found', message: `Unknown root "${source.rootId}".` })
    } else if (!root.writable) {
      errors.push({ field: 'rootId', code: 'root-not-writable', message: `Root "${root.label}" is read-only.` })
    }
  }

  const nameUsable = !errors.some(error => error.field === 'name')
  /** @type {'bundle'|'flat'|undefined} */
  let kind
  /** @type {string | undefined} */
  let relPath
  /** @type {string | undefined} */
  let targetPath
  /** @type {import('./scan.js').SkillEntry | undefined} */
  let entry

  if (action === 'update') {
    if (typeof source.relPath !== 'string' || source.relPath === '') {
      errors.push({ field: 'relPath', code: 'required', message: 'relPath is required when updating.' })
    } else if (!isSafeRelPath(source.relPath)) {
      errors.push({ field: 'relPath', code: 'invalid-path', message: 'relPath must be a relative path inside the root.' })
    } else {
      if (root !== undefined) {
        entry = skills.find(candidate => candidate.rootId === root.id && candidate.relPath === source.relPath)
        if (entry === undefined) {
          errors.push({
            field: 'relPath',
            code: 'not-found',
            message: 'This skill no longer exists on disk; reload and try again.',
          })
        }
      }
      if (entry !== undefined) {
        kind = entry.kind
        relPath = entry.relPath
        targetPath = entry.path
        if (nameUsable && fields.name !== entry.name) {
          errors.push({
            field: 'name',
            code: 'name-immutable',
            message: `Renaming is not supported; this skill is "${entry.name}".`,
          })
        }
        if (typeof source.expectedSha256 !== 'string' || source.expectedSha256 === '') {
          errors.push({
            field: 'expectedSha256',
            code: 'required',
            message: 'expectedSha256 is required when updating.',
          })
        } else if (source.expectedSha256 !== entry.sha256) {
          errors.push({
            field: 'expectedSha256',
            code: 'stale',
            message: 'The file changed on disk since it was loaded; reload the skill and try again.',
          })
        }
      }
    }
  } else {
    const requestedKind = source.kind === undefined || source.kind === null ? 'bundle' : source.kind
    if (requestedKind !== 'bundle' && requestedKind !== 'flat') {
      errors.push({ field: 'kind', code: 'invalid', message: 'Kind must be "bundle" or "flat".' })
    } else {
      kind = requestedKind
    }
    if (root !== undefined && kind !== undefined && nameUsable) {
      relPath = kind === 'bundle' ? `${fields.name}/SKILL.md` : `${fields.name}.md`
      targetPath = resolveInside(root.path, relPath)
      const occupied = await pathOccupied(targetPath)
      const directoryOccupied = kind === 'bundle' ? await pathOccupied(resolveInside(root.path, fields.name)) : false
      if (occupied || directoryOccupied) {
        errors.push({
          field: 'relPath',
          code: 'target-exists',
          message: 'A file or directory already exists at this path; edit the existing skill instead.',
        })
      }
    }
  }

  if (root !== undefined && nameUsable) {
    const self = entry === undefined ? undefined : { rootId: entry.rootId, relPath: entry.relPath }
    const others = self === undefined
      ? skills
      : skills.filter(candidate => !(candidate.rootId === self.rootId && candidate.relPath === self.relPath))
    /** @type {{ rootId: string, rootLabel: string, relPath: string, path: string, rank: number } | undefined} */
    const candidateEntry = relPath !== undefined && targetPath !== undefined && kind !== undefined
      ? { rootId: root.id, rootLabel: root.label, relPath, path: targetPath, rank: root.rank }
      : undefined

    const sameName = others.filter(candidate => candidate.valid === true && candidate.name === fields.name)
    if (sameName.length > 0) {
      const entries = [...sameName, ...(candidateEntry === undefined ? [] : [{ ...candidateEntry, name: fields.name }])]
      const sorted = [...entries].sort((left, right) => left.rank - right.rank)
      const projected = sorted.map(conflictEntry)
      conflicts.push(duplicateConflict(fields.name, sorted, projected, sorted.length))
    }

    const entryName = entry === undefined ? fields.name : entry.entryName
    const currentKind = kind
    if (currentKind !== undefined) {
      const aliases = others.filter(candidate => (
        candidate.rootId === root.id
        && candidate.entryName === entryName
        && candidate.kind !== currentKind
      ))
      if (aliases.length > 0) {
        conflicts.push({
          code: 'alias-collision',
          severity: 'error',
          name: fields.name,
          message: `A ${aliases[0].kind === 'flat' ? 'flat file' : 'bundle directory'} "${aliases[0].relPath}" in ${root.label} already claims this skill name; remove it or choose another name.`,
          entries: [...(candidateEntry === undefined ? [] : [candidateEntry]), ...aliases.map(conflictEntry)],
        })
      }
    }

    if (fields.description !== '') {
      warnings.push(...overlapWarningsForCandidate({
        name: fields.name,
        description: fields.description,
        entry: candidateEntry,
        skills: others,
      }))
    }
  }

  return {
    action,
    root,
    kind,
    relPath,
    targetPath,
    entry,
    name: fields.name,
    description: fields.description,
    whenToUse: fields.whenToUse,
    modelInvocable: fields.modelInvocable,
    userInvocable: fields.userInvocable,
    body: fields.body,
    errors,
    conflicts,
    warnings,
  }
}
