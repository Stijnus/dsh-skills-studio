/**
 * SKILL.md frontmatter parsing and serialization.
 *
 * The parser below — `parseFrontmatter`, `parseYamlSubset`, `frontmatterBoolean`,
 * `isKebabCase`, and the Claude Code field mapping helpers — is copied from
 * `dsh-claude-skills/src/frontmatter.js` in this workspace (MIT, same author),
 * where it ships as the companion skill provider's battle-tested parser. Keep
 * the copy in sync instead of re-inventing the YAML subset.
 *
 * Added here: `serializeFrontmatter` / `serializeSkillFile`, which emit the
 * write format CONTRACT.md fixes — bare kebab-case name, double-quoted JSON
 * strings for text fields, invocation booleans only when disabled, and no
 * empty `whenToUse` key.
 *
 * @module dsh-skills-studio/frontmatter
 */

/** Raised for malformed or unsupported frontmatter. Message names the line. */
export class FrontmatterError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

const KEY_RE = /^([A-Za-z0-9_.-]+):[ \t]?(.*)$/
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * DSH registry skill identity rule (`docs/subsystems/skills.md`).
 * @param {string} name
 * @returns {boolean}
 */
export function isKebabCase(name) {
  return KEBAB_RE.test(name)
}

/**
 * Split `---` frontmatter from the Markdown body.
 * @param {string} raw file contents
 * @returns {{ data: Record<string, unknown>, body: string } | undefined} undefined
 *   when the file has no complete frontmatter block (the shipped provider
 *   ignores such files rather than failing the whole catalog).
 */
export function parseFrontmatter(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const lines = text.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') return undefined
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---' || line === '...') { end = i; break }
  }
  if (end === -1) return undefined
  const data = parseYamlSubset(lines.slice(1, end).join('\n'))
  return { data, body: lines.slice(end + 1).join('\n') }
}

/**
 * Parse the YAML subset used by SKILL.md frontmatter.
 *
 * Supported: `key: scalar` (quoted or bare), booleans, numbers, null, inline
 * arrays `[a, b]`, literal/folded block scalars (`|`, `>`, with optional `-`),
 * one-or-more level nested mappings, comments, CRLF.
 * @param {string} source
 * @returns {Record<string, unknown>}
 * @throws {FrontmatterError} on anything outside the subset
 */
export function parseYamlSubset(source) {
  const lines = source.split(/\r?\n/)
  const cursor = { i: 0 }
  const value = parseMapping(lines, cursor, 0)
  skipIgnorable(lines, cursor)
  if (cursor.i < lines.length) {
    throw new FrontmatterError(`unexpected content at frontmatter line ${cursor.i + 1}`)
  }
  return value
}

/** @param {string[]} lines @param {{ i: number }} cursor @param {number} indent */
function parseMapping(lines, cursor, indent) {
  /** @type {Record<string, unknown>} */
  const out = {}
  while (true) {
    skipIgnorable(lines, cursor)
    if (cursor.i >= lines.length) break
    const line = lines[cursor.i]
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break
    if (lineIndent > indent) {
      throw new FrontmatterError(`unexpected indentation at frontmatter line ${cursor.i + 1}`)
    }
    const match = KEY_RE.exec(line.slice(indent))
    if (match === null) {
      throw new FrontmatterError(`unsupported YAML at frontmatter line ${cursor.i + 1}`)
    }
    const key = match[1]
    const rest = stripTrailingComment(match[2]).trim()
    cursor.i++

    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      out[key] = parseBlockScalar(lines, cursor, indent, rest.startsWith('>'))
      continue
    }
    if (rest === '') {
      const nestedIndent = peekIndent(lines, cursor)
      out[key] = nestedIndent !== undefined && nestedIndent > indent
        ? parseMapping(lines, cursor, nestedIndent)
        : null
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = parseInlineArray(rest)
      continue
    }
    out[key] = parseScalar(rest)
  }
  return out
}

/** @param {string[]} lines @param {{ i: number }} cursor @param {number} parentIndent @param {boolean} folded */
function parseBlockScalar(lines, cursor, parentIndent, folded) {
  /** @type {string[]} */
  const collected = []
  let blockIndent
  while (cursor.i < lines.length) {
    const line = lines[cursor.i]
    if (line.trim() === '') { collected.push(''); cursor.i++; continue }
    const lineIndent = indentOf(line)
    if (lineIndent <= parentIndent) break
    blockIndent ??= lineIndent
    collected.push(line.slice(Math.min(blockIndent, lineIndent)))
    cursor.i++
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  return folded ? collected.join(' ').trim() : collected.join('\n')
}

/** @param {string} text @param {number} indent */
function parseInlineArray(text) {
  const inner = text.slice(1, -1).trim()
  if (inner === '') return []
  return splitTopLevel(inner).map(part => {
    const value = parseScalar(part.trim())
    return typeof value === 'string' ? value : String(value ?? '')
  })
}

/** @param {string} text */
function splitTopLevel(text) {
  /** @type {string[]} */
  const parts = []
  let quote
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote !== undefined) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ',') { parts.push(text.slice(start, i)); start = i + 1 }
  }
  parts.push(text.slice(start))
  return parts
}

/** @param {string} text */
function parseScalar(text) {
  const value = text.trim()
  if (value === '') return null
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(["\\nt])/g, (_, ch) => (
      ch === 'n' ? '\n' : ch === 't' ? '\t' : ch
    ))
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

/** Strip a trailing `# comment` that is outside quotes. @param {string} text */
function stripTrailingComment(text) {
  let quote
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote !== undefined) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i)
  }
  return text
}

/** @param {string} line */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  const lead = match === null ? '' : match[0]
  if (lead.includes('\t')) {
    throw new FrontmatterError('tabs are not allowed for frontmatter indentation; use spaces')
  }
  return lead.length
}

/** @param {string} line */
function isIgnorable(line) {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

/** @param {string[]} lines @param {{ i: number }} cursor */
function skipIgnorable(lines, cursor) {
  while (cursor.i < lines.length && isIgnorable(lines[cursor.i])) cursor.i++
}

/** @param {string[]} lines @param {{ i: number }} cursor @returns {number | undefined} */
function peekIndent(lines, cursor) {
  const probe = { i: cursor.i }
  skipIgnorable(lines, probe)
  if (probe.i >= lines.length) return undefined
  return indentOf(lines[probe.i])
}

/**
 * Boolean frontmatter field with the registry's coercion rules
 * (`frontmatterBoolean` in `@deepseek-ai/dsh-skill-filesystem@0.2.1-rc.2`).
 * @param {Record<string, unknown>} data
 * @param {string} key
 * @returns {boolean | undefined}
 */
export function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new FrontmatterError(`frontmatter field "${key}" must be a boolean`)
}

/**
 * Fields consumed by the mapping; everything else becomes `metadata`.
 * @type {ReadonlySet<string>}
 */
const CONSUMED_KEYS = new Set([
  'name',
  'description',
  'whenToUse',
  'when-to-use',
  'when_to_use',
  'disable-model-invocation',
  'user-invocable',
  'metadata',
])

/**
 * Resolve the invocation policy, rejecting the camelCase legacy keys the
 * registry rejects so behaviour matches the shipped provider.
 * @param {Record<string, unknown>} data
 * @returns {{ modelInvocable: boolean, userInvocable: boolean }}
 */
function parseInvocationPolicy(data) {
  rejectLegacyKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyKey(data, 'userInvocable', 'user-invocable')
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/** @param {Record<string, unknown>} data @param {string} legacy @param {string} canonical */
function rejectLegacyKey(data, legacy, canonical) {
  if (Object.hasOwn(data, legacy)) {
    throw new FrontmatterError(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
}

/** @param {Record<string, unknown>} data @param {string} key */
function stringField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Map parsed frontmatter + body onto the shape `ctx.skills` expects.
 *
 * Deliberate Claude Code compatibility beyond the shipped DSH provider:
 * `name` may be omitted, in which case the directory (or flat file) name is
 * used — Claude Code derives it from the path, DSH's local provider requires it.
 * @param {object} input
 * @param {Record<string, unknown>} input.data
 * @param {string} input.body
 * @param {string} input.path absolute path of the instruction file
 * @param {string} input.fallbackName directory or file basename
 * @returns {{ ok: true, skill: ParsedSkill } | { ok: false, reason: string }}
 */
export function toParsedSkill({ data, body, path, fallbackName }) {
  const name = stringField(data, 'name') ?? fallbackName
  const description = stringField(data, 'description')
  if (description === undefined) return { ok: false, reason: 'frontmatter requires a non-empty description' }
  if (!isKebabCase(name)) {
    return { ok: false, reason: `invalid skill name "${name}" (expected kebab-case, e.g. "my-skill")` }
  }
  let invocation
  try {
    invocation = parseInvocationPolicy(data)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const whenToUse = stringField(data, 'whenToUse')
    ?? stringField(data, 'when-to-use')
    ?? stringField(data, 'when_to_use')
  /** @type {Record<string, unknown>} */
  const metadata = {}
  if (typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)) {
    Object.assign(metadata, data.metadata)
  }
  for (const [key, value] of Object.entries(data)) {
    if (CONSUMED_KEYS.has(key)) continue
    metadata[key] = value
  }
  return {
    ok: true,
    skill: {
      name,
      description,
      ...whenToUse !== undefined ? { whenToUse } : {},
      invocation,
      path,
      content: body.trim(),
      ...Object.keys(metadata).length > 0 ? { metadata } : {},
    },
  }
}

/**
 * @typedef {object} ParsedSkill
 * @property {string} name
 * @property {string} description
 * @property {string} [whenToUse]
 * @property {{ modelInvocable: boolean, userInvocable: boolean }} invocation
 * @property {string} path
 * @property {string} content
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * Quote a scalar as a YAML double-quoted string.
 *
 * `JSON.stringify` is the serializer: YAML 1.2 double-quoted scalars are a
 * superset of JSON strings, so the shipped provider's `yaml` parser reads these
 * exactly, and the subset parser above decodes the `"` `\` `\n` `\t` escapes it
 * emits.
 * @param {string} value
 * @returns {string}
 */
export function quoteYamlString(value) {
  return JSON.stringify(String(value))
}

/**
 * Serialize the frontmatter block, delimiters included, without a trailing
 * newline after the closing `---`.
 * @param {object} fields
 * @param {string} fields.name kebab-case skill name
 * @param {string} fields.description non-empty description
 * @param {string} [fields.whenToUse] emitted only when non-empty
 * @param {boolean} [fields.modelInvocable] `false` emits `disable-model-invocation: true`
 * @param {boolean} [fields.userInvocable] `false` emits `user-invocable: false`
 * @returns {string}
 */
export function serializeFrontmatter({ name, description, whenToUse, modelInvocable, userInvocable }) {
  const lines = ['---', `name: ${name}`, `description: ${quoteYamlString(description)}`]
  if (typeof whenToUse === 'string' && whenToUse.trim() !== '') {
    lines.push(`whenToUse: ${quoteYamlString(whenToUse)}`)
  }
  if (modelInvocable === false) lines.push('disable-model-invocation: true')
  if (userInvocable === false) lines.push('user-invocable: false')
  lines.push('---')
  return lines.join('\n')
}

/**
 * Serialize a complete SKILL.md instruction file in the CONTRACT write format:
 * UTF-8, `\n` endings, body trimmed of trailing whitespace, and an empty body
 * ending the file at the closing delimiter.
 * @param {object} fields `serializeFrontmatter` fields plus `body`
 * @param {string} [fields.body] markdown body
 * @returns {string}
 */
export function serializeSkillFile(fields) {
  const block = serializeFrontmatter(fields)
  const body = typeof fields.body === 'string' ? fields.body.replace(/\s+$/u, '') : ''
  return body === '' ? `${block}\n` : `${block}\n${body}\n`
}
