#!/usr/bin/env node
// audit-roots.mjs — read-only audit of DSH skill roots against the shipped DSH 0.2.1 contract.
//
// Plain Node >= 18, no dependencies. Prints one JSON report on stdout. Never writes.
//
// Contract sources, all shipped inside DSH 0.2.1-rc.5 (inspect via .dsh-recon/asar.mjs):
//   dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/README.md
//     - discovery is ONE level deep: <root>/<name>/SKILL.md or <root>/<name>.md
//     - frontmatter requires name (kebab-case) and description; optional whenToUse,
//       metadata, disable-model-invocation, user-invocable
//     - roots and rank: project-dsh 100, project-agents 200, custom 300,
//       user-dsh 400, user-agents 500, bundled 600
//   dsh/node_modules/@deepseek-ai/dsh-skill/lib/index.js
//     - SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
//   dsh/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js
//     - catalog description = whitespace-collapsed, trimmed, capped at
//       catalogDescriptionMaxLength (default 500) as slice(0, max-3) + "..."
//   dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js
//     - parseFrontmatter: first line must be exactly "---", closing line "---",
//       YAML parsed with yaml@2.9.1; legacy invocation keys are rejected.
//
// This audit intentionally re-derives the facts instead of trusting ds-stack/tools/*.
//
// Usage:
//   node audit-roots.mjs [options]
//
// Options:
//   --agents-home DIR      shared agents root (default: $DSH_AGENTS_HOME or ~/.agents)
//   --dsh-home DIR         harness config root (default: $DSH_HOME or ~/.dsh)
//   --project DIR          project root to scan (repeatable; default: cwd)
//   --root DIR             extra skill root (repeatable; not part of the ranked contract)
//   --manifest PATH        deepseek-stack manifest (default: <agents-home>/.ds-stack-manifest.json)
//   --lock PATH            community skill lock (default: <agents-home>/.skill-lock.json)
//   --deepseek-stack DIR   pack source tree; derives --source-skills/--source-aliases
//   --source-skills DIR    source bundle dir for drift comparison
//   --source-aliases DIR   source flat alias dir for drift comparison
//   --catalog-max N        catalog description cap (default: 500)
//   --yaml-module PATH     path to a YAML parser module exporting parse() (e.g. shipped yaml)
//   --fail-on LEVEL        high|medium|none exit-code threshold (default: high)
//   --pretty               pretty-print JSON (default: compact)
//
// Exit codes: 0 = below threshold, 1 = findings at/above --fail-on, 2 = usage/setup error.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const VERSION = 1
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ALLOWED_KEYS = new Set(['name', 'description', 'whenToUse', 'metadata', 'disable-model-invocation', 'user-invocable'])
const LEGACY_KEYS = new Set(['disableModelInvocation', 'modelInvocable', 'userInvocable'])
const RANKS = [
  { id: 'project-dsh', source: 'project-dsh', rank: 100, rel: (p) => join(p, '.dsh', 'skills'), skipSystem: false },
  { id: 'project-agents', source: 'project-agents', rank: 200, rel: (p) => join(p, '.agents', 'skills'), skipSystem: false },
  { id: 'user-dsh', source: 'user-dsh', rank: 400, dsh: true, skipSystem: true },
  { id: 'user-agents', source: 'user-agents', rank: 500, agents: true, skipSystem: false },
]

function usage(message) {
  if (message) console.error(`audit-roots: ${message}`)
  console.error('usage: node audit-roots.mjs [--agents-home DIR] [--dsh-home DIR] [--project DIR]... [--root DIR]...')
  console.error('       [--manifest PATH] [--lock PATH] [--deepseek-stack DIR] [--source-skills DIR] [--source-aliases DIR]')
  console.error('       [--catalog-max N] [--yaml-module PATH] [--fail-on high|medium|none] [--pretty]')
  process.exit(2)
}

let args
try {
  args = parseArgs({
    options: {
      'agents-home': { type: 'string' },
      'dsh-home': { type: 'string' },
      project: { type: 'string', multiple: true },
      root: { type: 'string', multiple: true },
      manifest: { type: 'string' },
      lock: { type: 'string' },
      'deepseek-stack': { type: 'string' },
      'source-skills': { type: 'string' },
      'source-aliases': { type: 'string' },
      'catalog-max': { type: 'string' },
      'yaml-module': { type: 'string' },
      'fail-on': { type: 'string' },
      pretty: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  }).values
} catch (error) {
  usage(error.message)
}
if (args.help) usage()
if (args['yaml-module'] && !existsSync(args['yaml-module'])) usage(`no such yaml module: ${args['yaml-module']}`)

const agentsHome = resolve(args['agents-home'] ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
const dshHome = resolve(args['dsh-home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const projects = (args.project?.length ? args.project : [process.cwd()]).map((p) => resolve(p))
const catalogMax = Number(args['catalog-max'] ?? 500)
if (!Number.isInteger(catalogMax) || catalogMax < 3) usage('--catalog-max must be an integer >= 3')
const failOn = args['fail-on'] ?? 'high'
if (!['high', 'medium', 'none'].includes(failOn)) usage('--fail-on must be high, medium or none')

// ---------------------------------------------------------------------------
// YAML: use the same parser the shipped provider uses when a copy is supplied
// (yaml@2.9.1 inside app.asar); otherwise a conservative frontmatter subset.
// ---------------------------------------------------------------------------
let yamlParse = null
let yamlParserUsed = 'fallback'
if (args['yaml-module']) {
  try {
    const mod = await import(pathToFileURL(resolve(args['yaml-module'])).href)
    if (typeof mod.parse === 'function') {
      yamlParse = (text) => mod.parse(text)
      yamlParserUsed = `module:${args['yaml-module']}`
    }
  } catch (error) {
    console.error(`audit-roots: could not load yaml module: ${error.message}`)
  }
}
if (!yamlParse) {
  try {
    const mod = await import('yaml')
    yamlParse = (text) => mod.parse(text)
    yamlParserUsed = 'module:yaml'
  } catch {
    yamlParse = fallbackParseFrontmatter
    yamlParserUsed = 'fallback'
  }
}

function fallbackParseFrontmatter(head) {
  // Conservative subset: top-level keys, quoted/plain scalars, block scalars, nested blocks.
  const data = {}
  const lines = head.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) continue // nested line consumed by the previous top-level key
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (!m) throw new Error(`unparsable frontmatter line ${i + 1}: ${JSON.stringify(line)}`)
    const key = m[1]
    const raw = m[2].trim()
    if (raw === '' || raw === '|' || raw === '>' || raw === '|-' || raw === '>-' || raw === '|+' || raw === '>+') {
      const block = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        block.push(lines[++i].replace(/^\s+/, ''))
      }
      data[key] = raw.startsWith('|') ? block.join('\n') : block.join(' ').trim()
      continue
    }
    if ((raw.startsWith('"') && raw.endsWith('"') && raw.length > 1)) {
      data[key] = JSON.parse(raw)
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) {
      data[key] = raw.slice(1, -1).replace(/''/g, "'")
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
    } else if (raw === 'true') data[key] = true
    else if (raw === 'false') data[key] = false
    else data[key] = raw
  }
  return data
}

function parseSkillFrontmatter(text) {
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) return { found: false, error: 'file has no frontmatter (no newline)' }
  if (text.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return { found: false, error: 'file does not start with a "---" line' }
  let lineStart = firstLineEnd + 1
  let closing
  while (lineStart <= text.length) {
    const nextNewline = text.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? text.length : nextNewline
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closing = { start: lineStart, bodyStart: nextNewline < 0 ? text.length : nextNewline + 1 }
      break
    }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }
  if (!closing) return { found: false, error: 'unterminated frontmatter (no closing "---" line)' }
  let data
  try {
    data = yamlParse(text.slice(firstLineEnd + 1, closing.start))
  } catch (error) {
    return { found: false, error: `invalid YAML frontmatter: ${error.message.split('\n')[0]}` }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { found: false, error: 'frontmatter is not a mapping' }
  return { found: true, data, body: text.slice(closing.bodyStart) }
}

function skillNameValid(name) {
  return typeof name === 'string' && NAME_RE.test(name)
}

function parseInvocation(data) {
  for (const legacy of LEGACY_KEYS) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use the canonical kebab-case key`)
  }
  const parseBoolean = (key) => {
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
    throw new TypeError(`frontmatter field "${key}" must be a boolean`)
  }
  const disableModelInvocation = parseBoolean('disable-model-invocation')
  const userInvocable = parseBoolean('user-invocable')
  return { modelInvocable: disableModelInvocation !== true, userInvocable: userInvocable !== false }
}

function normalizeDescription(value) {
  return value.replaceAll(/\s+/g, ' ').trim()
}

function catalogDescription(value, max) {
  const normalized = normalizeDescription(value)
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ---------------------------------------------------------------------------
// Discovery mirroring the shipped provider.
// ---------------------------------------------------------------------------
function entryKind(fullPath) {
  let info
  try {
    info = statSync(fullPath) // follows symlinks, like the provider's nodeEntryKind
  } catch {
    return undefined
  }
  if (info.isDirectory()) return 'directory'
  if (info.isFile()) return 'file'
  return undefined
}

function scanRoot(root) {
  const result = {
    id: root.id,
    source: root.source,
    rank: root.rank ?? null,
    path: root.path,
    exists: existsSync(root.path),
    skipSystem: root.skipSystem === true,
    entries: [],
    ignored: [],
    counts: { entries: 0, bundles: 0, flat: 0, valid: 0, invalid: 0, modelInvocable: 0, userOnly: 0 },
  }
  if (!result.exists) return result
  let names
  try {
    names = readdirSync(root.path).sort((a, b) => a.localeCompare(b))
  } catch (error) {
    result.error = `unreadable root: ${error.message}`
    return result
  }
  for (const entry of names) {
    if (root.skipSystem && entry === '.system') continue
    const fullPath = join(root.path, entry)
    const kind = entryKind(fullPath)
    if (kind === undefined) {
      result.ignored.push({ entry, reason: 'not a regular file or directory (or broken symlink)' })
      continue
    }
    let filePath
    let entryKindName
    if (kind === 'directory') {
      filePath = join(fullPath, 'SKILL.md')
      entryKindName = 'bundle'
      if (!existsSync(filePath)) {
        result.entries.push({
          entry, kind: entryKindName, path: filePath, valid: false,
          errors: ['directory bundle has no SKILL.md (never discovered)'], warnings: [],
        })
        continue
      }
    } else {
      if (!entry.endsWith('.md')) {
        result.ignored.push({ entry, reason: 'top-level file does not end in .md (not discovered)' })
        continue
      }
      filePath = fullPath
      entryKindName = 'flat'
    }
    result.entries.push(auditEntry({ entry, kind: entryKindName, filePath, rootPath: root.path, catalogMax }))
  }
  for (const e of result.entries) {
    if (e.kind === 'bundle') result.counts.bundles++
    else if (e.kind === 'flat') result.counts.flat++
    if (e.valid) result.counts.valid++
    else result.counts.invalid++
    if (e.valid && e.invocation?.modelInvocable) result.counts.modelInvocable++
    if (e.valid && e.invocation && !e.invocation.modelInvocable) result.counts.userOnly++
  }
  result.counts.entries = result.entries.length
  return result
}

function auditEntry({ entry, kind, filePath, rootPath, catalogMax }) {
  const out = {
    entry, kind, path: filePath,
    name: null, nameMatchesEntry: null,
    descriptionChars: null, descriptionNormalizedChars: null, catalogDescriptionChars: null,
    catalogTruncated: null, descriptionMultiline: null,
    invocation: null, frontmatterKeys: [], unknownKeys: [], legacyKeys: [],
    bodyBytes: 0, bodyLines: 0, bodyEmpty: null, bodyStartsWithH1: null,
    sha256: null, bytes: null, valid: false, errors: [], warnings: [],
  }
  let buffer
  try {
    buffer = readFileSync(filePath)
  } catch (error) {
    out.errors.push(`unreadable: ${error.message}`)
    return out
  }
  out.bytes = buffer.length
  out.sha256 = sha256(buffer)
  let text
  try {
    text = buffer.toString('utf8')
  } catch (error) {
    out.errors.push(`not valid UTF-8: ${error.message}`)
    return out
  }
  const parsed = parseSkillFrontmatter(text)
  if (!parsed.found) {
    out.errors.push(parsed.error)
    out.valid = false
    return out
  }
  const data = parsed.data
  const body = parsed.body ?? ''
  out.frontmatterKeys = Object.keys(data).sort()
  out.unknownKeys = out.frontmatterKeys.filter((k) => !ALLOWED_KEYS.has(k))
  out.legacyKeys = out.frontmatterKeys.filter((k) => LEGACY_KEYS.has(k))
  out.bodyBytes = Buffer.byteLength(body, 'utf8')
  out.bodyLines = body ? body.split('\n').length : 0
  out.bodyEmpty = body.trim().length === 0
  out.bodyStartsWithH1 = body.trimStart().startsWith('# ')

  const name = typeof data.name === 'string' ? data.name : undefined
  const description = typeof data.description === 'string' ? data.description : undefined
  out.name = name ?? null
  if (name === undefined || name.length === 0) out.errors.push('missing name')
  else if (!skillNameValid(name)) out.errors.push(`name "${name}" is not kebab-case ${NAME_RE}`)
  if (name !== undefined) out.nameMatchesEntry = name === entryForBasename(entry, kind)

  let invocation
  try {
    invocation = parseInvocation(data)
    out.invocation = invocation
  } catch (error) {
    out.errors.push(error.message)
  }
  if (description === undefined || description.length === 0) {
    out.errors.push('missing description')
  } else {
    out.descriptionChars = description.length
    const normalized = normalizeDescription(description)
    out.descriptionNormalizedChars = normalized.length
    out.catalogTruncated = normalized.length > catalogMax
    out.catalogDescriptionChars = catalogDescription(description, catalogMax).length
    out.descriptionMultiline = /\n/.test(description)
  }
  if (out.nameMatchesEntry === false) {
    out.warnings.push(`frontmatter name "${name}" != entry basename "${entryForBasename(entry, kind)}" (DSH serves the frontmatter name; filename-keyed tooling disagrees)`)
  }
  for (const key of out.unknownKeys) out.warnings.push(`unknown frontmatter key "${key}" (ignored by DSH)`)
  if (parsed.data.whenToUse !== undefined) out.warnings.push('whenToUse is parsed but never rendered in the model catalog')
  if (out.descriptionMultiline) out.warnings.push('description is multi-line; the catalog renders one normalized line')
  if (out.bodyEmpty) out.warnings.push('empty body: loading this skill injects nothing')
  else if (!out.bodyStartsWithH1) out.warnings.push('body does not start with an H1 "# ..."')
  out.valid = out.errors.length === 0
  return out
}

function entryForBasename(entry, kind) {
  return kind === 'flat' ? basename(entry, '.md') : basename(entry)
}

// ---------------------------------------------------------------------------
// Aggregate checks.
// ---------------------------------------------------------------------------
function rootList() {
  const roots = []
  for (const project of projects) {
    for (const def of RANKS.slice(0, 2)) {
      roots.push({ ...def, id: `${def.id}:${project}`, path: def.rel(project) })
    }
  }
  for (const def of RANKS.slice(2)) {
    roots.push({
      ...def,
      id: def.id,
      path: def.dsh ? join(dshHome, 'skills') : join(agentsHome, 'skills'),
    })
  }
  for (const [i, extra] of (args.root ?? []).entries()) {
    roots.push({ id: `extra-${i + 1}`, source: 'custom', rank: null, path: resolve(extra), skipSystem: false })
  }
  return roots
}

function auditManifest(manifestPath, allByName) {
  const out = {
    path: manifestPath, exists: existsSync(manifestPath),
    version: null, source: null, upstreamCommit: null, target: null,
    sections: { skills: 0, aliases: 0 },
    onDiskMissing: [], diskNotInManifest: [], shaMismatch: [], descriptionCharsMismatch: [],
  }
  if (!out.exists) return out
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    out.error = `unparsable manifest: ${error.message}`
    return out
  }
  out.version = manifest.version ?? null
  out.source = manifest.source ?? null
  out.upstreamCommit = manifest.upstreamCommit ?? null
  out.target = manifest.target ?? null
  const skills = manifest.skills ?? {}
  const aliases = manifest.aliases ?? {}
  out.sections = { skills: Object.keys(skills).length, aliases: Object.keys(aliases).length }
  for (const [name, record] of Object.entries(skills)) {
    const entry = allByName.get(name)?.find((e) => e.kind === 'bundle')
    if (!entry) { out.onDiskMissing.push(name); continue }
    if (record.sha256 && entry.sha256 !== record.sha256) out.shaMismatch.push({ name, section: 'skills', manifest: record.sha256, disk: entry.sha256 })
    if (typeof record.descriptionChars === 'number' && entry.descriptionChars !== null && record.descriptionChars !== entry.descriptionChars) {
      out.descriptionCharsMismatch.push({ name, section: 'skills', manifest: record.descriptionChars, disk: entry.descriptionChars })
    }
  }
  for (const [name, record] of Object.entries(aliases)) {
    const entry = allByName.get(name)?.find((e) => e.kind === 'flat')
    if (!entry) { out.onDiskMissing.push(name); continue }
    if (record.sha256 && entry.sha256 !== record.sha256) out.shaMismatch.push({ name, section: 'aliases', manifest: record.sha256, disk: entry.sha256 })
  }
  const manifestNames = new Set([...Object.keys(skills), ...Object.keys(aliases)])
  for (const [name, entries] of allByName) {
    if (manifestNames.has(name)) continue
    if (entries.some((e) => e.kind === 'bundle' || e.kind === 'flat')) {
      out.diskNotInManifest.push(name)
    }
  }
  return out
}

function auditLock(lockPath, allByName) {
  const out = { path: lockPath, exists: existsSync(lockPath), version: null, entries: 0, onDiskMissing: [], diskNotInLock: [], lockScope: null, packEntriesNotInLock: null }
  if (!out.exists) return out
  let lock
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (error) {
    out.error = `unparsable lock: ${error.message}`
    return out
  }
  out.version = lock.version ?? null
  const names = Object.keys(lock.skills ?? {})
  out.entries = names.length
  out.onDiskMissing = names.filter((n) => !allByName.has(n))
  // The lock tracks community skills installed by the skills CLI; the deepseek-stack pack is
  // tracked by .ds-stack-manifest.json instead, so ds-* names are not expected here.
  out.lockScope = 'non-pack entries (ds-* are tracked by the deepseek-stack manifest)'
  out.packEntriesNotInLock = [...allByName.keys()].filter((n) => n.startsWith('ds-')).length
  out.diskNotInLock = [...allByName.keys()].filter((n) => !n.startsWith('ds-') && !names.includes(n))
  return out
}

function auditSource({ label, sourceDir, installedEntries, surface }) {
  const out = { label, sourceDir, exists: existsSync(sourceDir), checked: 0, match: 0, mismatch: [], missingInSource: [], extraInSource: [] }
  if (!out.exists) return out
  const installed = installedEntries.filter((e) => (surface === 'bundles' ? e.kind === 'bundle' : e.kind === 'flat'))
  const seen = new Set()
  for (const entry of installed) {
    const sourceName = surface === 'bundles' ? entry.entry : `${entry.entry}.md`.replace(/\.md\.md$/, '.md')
    const sourcePath = surface === 'bundles' ? join(sourceDir, entry.entry, 'SKILL.md') : join(sourceDir, sourceName)
    if (!existsSync(sourcePath)) { out.missingInSource.push(entry.entry); continue }
    out.checked++
    seen.add(sourceName)
    const sourceSha = sha256(readFileSync(sourcePath))
    if (sourceSha === entry.sha256) out.match++
    else out.mismatch.push({ entry: entry.entry, installed: entry.sha256, source: sourceSha })
  }
  if (surface === 'bundles') {
    for (const name of readdirSync(sourceDir).sort()) {
      if (!existsSync(join(sourceDir, name, 'SKILL.md'))) continue
      if (!installed.some((e) => e.entry === name)) out.extraInSource.push(name)
    }
  } else {
    for (const name of readdirSync(sourceDir).sort()) {
      if (!name.endsWith('.md')) continue
      if (!seen.has(name)) out.extraInSource.push(name)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const report = {
  tool: 'audit-roots.mjs',
  version: VERSION,
  generatedAt: new Date().toISOString(),
  readOnly: true,
  contract: 'DSH 0.2.1-rc.5 @deepseek-ai/dsh-skill-filesystem + @deepseek-ai/dsh-skill + @deepseek-ai/dsh-tool-skill',
  yamlParser: yamlParserUsed,
  inputs: {
    agentsHome, dshHome, projects,
    manifest: resolve(args.manifest ?? join(agentsHome, '.ds-stack-manifest.json')),
    lock: resolve(args.lock ?? join(agentsHome, '.skill-lock.json')),
    catalogMax,
  },
  roots: [],
  summary: {},
  manifest: null,
  lock: null,
  sourceDrift: [],
  findings: [],
}

for (const root of rootList()) report.roots.push(scanRoot(root))

const allEntries = report.roots.flatMap((root) => root.entries.map((entry) => ({ ...entry, root: root.id, rootRank: root.rank, rootSource: root.source })))
const allByName = new Map()
for (const entry of allEntries) {
  if (!entry.valid || !entry.name) continue
  if (!allByName.has(entry.name)) allByName.set(entry.name, [])
  allByName.get(entry.name).push(entry)
}

const totals = {
  rootsScanned: report.roots.length,
  rootsPresent: report.roots.filter((r) => r.exists).length,
  entries: allEntries.length,
  bundles: allEntries.filter((e) => e.kind === 'bundle').length,
  flat: allEntries.filter((e) => e.kind === 'flat').length,
  valid: allEntries.filter((e) => e.valid).length,
  invalid: allEntries.filter((e) => !e.valid).length,
  modelInvocable: allEntries.filter((e) => e.valid && e.invocation.modelInvocable).length,
  userOnly: allEntries.filter((e) => e.valid && !e.invocation.modelInvocable).length,
  ignored: report.roots.reduce((n, r) => n + r.ignored.length, 0),
}
const renderedCatalogEntries = allEntries.filter((e) => e.valid && e.invocation.modelInvocable)
totals.catalogNameChars = renderedCatalogEntries.reduce((n, e) => n + e.name.length, 0)
totals.catalogDescriptionChars = renderedCatalogEntries.reduce((n, e) => n + e.catalogDescriptionChars, 0)
totals.catalogCharEstimate = totals.catalogNameChars + totals.catalogDescriptionChars + renderedCatalogEntries.length * 6
totals.catalogTokenEstimate = Math.round(totals.catalogCharEstimate / 3.6)

const duplicates = [...allByName.entries()]
  .filter(([, entries]) => new Set(entries.map((e) => e.root)).size > 1)
  .map(([name, entries]) => ({ name, occurrences: entries.map((e) => ({ root: e.root, rank: e.rootRank, path: e.path })) }))
const sameRootDuplicates = [...allByName.entries()]
  .filter(([, entries]) => new Set(entries.map((e) => e.root)).size === 1 && entries.length > 1)
  .map(([name, entries]) => ({ name, root: entries[0].root, occurrences: entries.map((e) => ({ kind: e.kind, path: e.path })) }))
const aliasCollisions = []
for (const root of report.roots) {
  const flats = new Set(root.entries.filter((e) => e.kind === 'flat').map((e) => e.entry))
  for (const entry of root.entries) {
    if (entry.kind === 'bundle' && flats.has(entry.entry)) {
      aliasCollisions.push({ root: root.id, name: entry.entry, path: entry.path })
    }
  }
}
const nameMismatches = allEntries.filter((e) => e.valid && e.nameMatchesEntry === false)
  .map((e) => ({ root: e.root, entry: e.entry, kind: e.kind, name: e.name, path: e.path }))
const truncatedDescriptions = allEntries.filter((e) => e.valid && e.catalogTruncated)
  .map((e) => ({ root: e.root, name: e.name, descriptionChars: e.descriptionChars, normalizedChars: e.descriptionNormalizedChars, catalogChars: e.catalogDescriptionChars }))
const invalidEntries = allEntries.filter((e) => !e.valid)
  .map((e) => ({ root: e.root, entry: e.entry, kind: e.kind, path: e.path, errors: e.errors }))
const ignoredEntries = report.roots.flatMap((r) => r.ignored.map((i) => ({ root: r.id, ...i })))
const warningEntries = allEntries.filter((e) => e.warnings.length > 0)
  .map((e) => ({ root: e.root, name: e.name, entry: e.entry, kind: e.kind, warnings: e.warnings }))
const skillBytes = allEntries.filter((e) => typeof e.bytes === 'number').map((e) => e.bytes)
const sizeStats = skillBytes.length
  ? { files: skillBytes.length, totalBytes: skillBytes.reduce((a, b) => a + b, 0), minBytes: Math.min(...skillBytes), maxBytes: Math.max(...skillBytes) }
  : { files: 0, totalBytes: 0, minBytes: null, maxBytes: null }

report.summary = { totals, sizes: sizeStats, duplicates, sameRootDuplicates, aliasCollisions, nameMismatches, truncatedDescriptions, invalidEntries, ignoredEntries, warnings: warningEntries }
report.manifest = auditManifest(report.inputs.manifest, allByName)
report.lock = auditLock(report.inputs.lock, allByName)

const pack = args['deepseek-stack'] ? resolve(args['deepseek-stack']) : null
const sourceSkills = args['source-skills'] ? resolve(args['source-skills']) : pack ? join(pack, 'skills') : null
const sourceAliases = args['source-aliases'] ? resolve(args['source-aliases']) : pack ? join(pack, 'aliases') : null
const installedForDrift = allEntries.filter((e) => e.valid)
if (sourceSkills) {
  report.sourceDrift.push(auditSource({
    label: 'bundle-sources', sourceDir: sourceSkills,
    installedEntries: installedForDrift.filter((e) => e.kind === 'bundle' && e.name.startsWith('ds-')),
    surface: 'bundles',
  }))
}
if (sourceAliases) {
  report.sourceDrift.push(auditSource({
    label: 'alias-sources', sourceDir: sourceAliases,
    installedEntries: installedForDrift.filter((e) => e.kind === 'flat' && e.name.startsWith('ds-')),
    surface: 'flat',
  }))
}

// Findings, ordered by severity.
const findings = []
const add = (severity, code, message, evidence) => findings.push({ severity, code, message, ...(evidence ? { evidence } : {}) })
for (const item of invalidEntries) add('high', 'invalid-entry', `${item.root}: ${item.kind} "${item.entry}" is not a valid skill: ${item.errors.join('; ')}`, item.path)
for (const item of duplicates) add('high', 'duplicate-name', `skill name "${item.name}" appears in multiple roots; the lower-rank provider is shadowed`, item.occurrences)
for (const item of sameRootDuplicates) add('high', 'duplicate-name-in-root', `skill name "${item.name}" appears twice in root ${item.root}`, item.occurrences)
for (const item of aliasCollisions) add('high', 'alias-collision', `flat alias and directory bundle share the name "${item.name}" in ${item.root}`, item.path)
for (const item of truncatedDescriptions) add('medium', 'description-truncated', `${item.name}: description is ${item.descriptionChars} chars; the catalog renders ${item.catalogChars} (cap ${catalogMax}, tail dropped)`, item)
for (const item of nameMismatches) add('medium', 'name-basename-mismatch', `${item.root}: frontmatter name "${item.name}" differs from entry "${item.entry}"; DSH serves the frontmatter name, filename-keyed tooling and /gesture names disagree`, item.path)
if (report.manifest.onDiskMissing.length) add('high', 'manifest-missing-on-disk', `manifest lists skills that are not installed: ${report.manifest.onDiskMissing.join(', ')}`, report.manifest.path)
if (report.manifest.shaMismatch.length) add('high', 'manifest-sha-mismatch', `installed files differ from the manifest hashes: ${report.manifest.shaMismatch.map((m) => m.name).join(', ')}`, report.manifest.path)
if (report.manifest.descriptionCharsMismatch.length) add('medium', 'manifest-description-drift', `manifest descriptionChars differs from disk for: ${report.manifest.descriptionCharsMismatch.map((m) => m.name).join(', ')}`, report.manifest.path)
if (report.manifest.diskNotInManifest.length) add('low', 'unmanaged-skills', `installed entries not in the deepseek-stack manifest (expected only for community skills): ${report.manifest.diskNotInManifest.length}`, report.manifest.path)
if (report.lock.onDiskMissing.length) add('medium', 'lock-missing-on-disk', `skill lock lists missing entries: ${report.lock.onDiskMissing.join(', ')}`, report.lock.path)
if (report.lock.diskNotInLock.length) add('medium', 'lock-drift', `installed non-pack skills with no lock entry (untracked by the skills CLI): ${report.lock.diskNotInLock.join(', ')}`, report.lock.path)
for (const drift of report.sourceDrift) {
  for (const item of drift.mismatch) add('high', 'source-drift', `${item.entry}: installed sha256 ${item.installed.slice(0, 12)}… != pack source ${item.source.slice(0, 12)}…`, drift.sourceDir)
  for (const name of drift.missingInSource) add('medium', 'source-missing', `${name}: installed but has no counterpart in ${drift.sourceDir}`)
  for (const name of drift.extraInSource) add('low', 'source-extra', `${name}: present in ${drift.sourceDir} but not installed`)
}
for (const item of ignoredEntries) add('low', 'ignored-entry', `${item.root}: "${item.entry}" ignored — ${item.reason}`)
for (const root of report.roots) if (!root.exists) add('info', 'root-absent', `root ${root.id} does not exist (${root.path})`)
for (const item of allEntries.filter((e) => e.valid && e.warnings.length)) {
  // Warnings stay visible but do not change the validity verdict.
  if (item.legacyKeys?.length) add('high', 'legacy-key', `${item.name}: legacy invocation key present: ${item.legacyKeys.join(', ')}`, item.path)
}
report.findings = findings.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity) || a.code.localeCompare(b.code))
report.summary.counts = {
  high: findings.filter((f) => f.severity === 'high').length,
  medium: findings.filter((f) => f.severity === 'medium').length,
  low: findings.filter((f) => f.severity === 'low').length,
  info: findings.filter((f) => f.severity === 'info').length,
}

function severityOrder(severity) {
  return { high: 0, medium: 1, low: 2, info: 3 }[severity] ?? 4
}

process.stdout.write(`${JSON.stringify(report, null, args.pretty ? 2 : 0)}\n`)
const threshold = { high: 0, medium: 1, none: 99 }[failOn]
process.exit(report.summary.counts.high > 0 && threshold <= 0 ? 1 : threshold === 1 && (report.summary.counts.high > 0 || report.summary.counts.medium > 0) ? 1 : 0)
