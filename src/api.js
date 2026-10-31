/**
 * HTTP API for the Skills manager: JSON envelope, route dispatch, body cap,
 * optimistic-sha mutations, and the post-write registry visibility probe.
 *
 * Routes are mounted under the `/skills-studio` prefix registered by
 * `index.js`; the paths below are absolute so the handler can also be driven
 * directly in tests. The handler never throws: every failure becomes an
 * `{ ok:false, error:{ code, message } }` envelope.
 *
 * @module dsh-skills-studio/api
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

import {
  MutationError,
  buildSkillFile,
  createSkill,
  deleteSkill,
  installSkill,
  updateSkill,
} from './mutate.js'
import { resolveRoots } from './roots.js'
import {
  STATE_VERSION,
  loadLibraryEntry,
  scanLibraries,
  scanSkills,
  sortSkills,
} from './scan.js'
import {
  FORCE_BYPASSABLE_CODES,
  computeLibraryConflict,
  conflictEntry,
  detectConflicts,
  overlapWarningsForCandidate,
  validateDraft,
} from './validate.js'

/** URL prefix owned by this plugin (registered through `ctx.webServer`). */
export const API_PREFIX = '/skills-studio'

/** Request body cap; also the largest JSON body the handler will buffer. */
export const BODY_LIMIT_BYTES = 1024 * 1024

/** Default registry visibility deadline, per CONTRACT (2000 ms, polled every 50 ms). */
const DEFAULT_REGISTRY_TIMEOUT_MS = 2000
const DEFAULT_REGISTRY_POLL_MS = 50

/** Hard ceiling for `/api/skill` content reads; scan already skips bigger files. */
const SKILL_CONTENT_LIMIT = 16 * 1024 * 1024

/**
 * Reason reported when the host-scope registry view cannot see the providers
 * that serve the scanned roots (the filesystem provider runs in the agent
 * preset's scope in the desktop composition). Reporting `visible:false` from
 * such a view would be a false negative, so the probe reports `checked:false`.
 */
const UNOBSERVABLE_SCOPE_REASON = 'The host-scope registry view does not include the session-scoped skill providers that serve these roots; the filesystem provider watches the written root and will surface the change to agents on the next step.'

/**
 * Create the API surface for one plugin instance.
 * @param {object} options
 * @param {import('./config.js').SkillsManagerConfig} options.config normalized plugin config
 * @param {object} [options.ctx] host context (used only for optional `ctx.get('skills')`)
 * @param {number} [options.registryTimeoutMs] injectable probe deadline (tests shorten it)
 * @param {number} [options.registryPollMs] injectable probe poll interval
 * @returns {{ handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>, handle: (request: { method?: string, url?: string, body?: unknown }) => Promise<{ status: number, headers: Record<string, string>, payload: object }>, prefix: string }}
 */
export function createApi(options) {
  if (options === undefined || options.config === undefined) {
    throw new TypeError('createApi requires a normalized config')
  }
  const config = options.config
  const ctx = options.ctx
  const registryTimeoutMs = Math.max(0, Number(options.registryTimeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS))
  const registryPollMs = Math.max(1, Number(options.registryPollMs ?? DEFAULT_REGISTRY_POLL_MS))

  /**
   * Route table, built per instance so handlers close over this config/context.
   * @type {Map<string, { methods: string[], run: (request: { url: URL, body: unknown }) => Promise<{ status: number, headers?: Record<string, string>, payload: object }> }>}
   */
  const knownRoutes = new Map([
    [`${API_PREFIX}/api/state`, { methods: ['GET'], run: stateRoute }],
    [`${API_PREFIX}/api/skill`, { methods: ['GET'], run: skillRoute }],
    [`${API_PREFIX}/api/validate`, { methods: ['POST'], run: validateRoute }],
    [`${API_PREFIX}/api/save`, { methods: ['POST'], run: saveRoute }],
    [`${API_PREFIX}/api/delete`, { methods: ['POST'], run: deleteRoute }],
    [`${API_PREFIX}/api/install`, { methods: ['POST'], run: installRoute }],
    [`${API_PREFIX}/api/health`, { methods: ['GET'], run: healthRoute }],
  ])

  /** Serialized mutation chain: one in-flight file mutation per host process. */
  let mutationChain = Promise.resolve()

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serializeMutation(task) {
    const run = mutationChain.then(task, task)
    mutationChain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Read the optional skills registry. Cordis throws when a non-injected
   * service is read directly, so `ctx.get` is the primary path and everything
   * is wrapped: this must never fail a request.
   * @returns {{ list?: (options: object) => Promise<unknown> } | undefined}
   */
  function getSkillsService() {
    if (ctx !== undefined && ctx !== null && typeof ctx.get === 'function') {
      try {
        const service = ctx.get('skills')
        if (service !== undefined && service !== null) return service
      } catch {
        // fall through to the direct read
      }
    }
    try {
      const service = /** @type {{ skills?: unknown }} */ (ctx)?.skills
      if (service !== undefined && service !== null) return /** @type {{ list?: Function }} */ (service)
    } catch {
      // Cordis proxy rejects uninjected property reads; stay optional.
    }
    return undefined
  }

  /**
   * Names of the valid, installed skills in a scan. Used to prove the registry
   * view actually covers the roots this request scanned.
   * @param {import('./scan.js').SkillEntry[]} skills
   * @param {{ rootId: string, relPath: string }} [exclude] entry to leave out (delete)
   * @returns {Set<string>}
   */
  function scannedNameSet(skills, exclude) {
    const names = new Set()
    for (const skill of skills) {
      if (skill === null || typeof skill !== 'object' || skill.valid !== true) continue
      if (exclude !== undefined && skill.rootId === exclude.rootId && skill.relPath === exclude.relPath) continue
      names.add(skill.name)
    }
    return names
  }

  /**
   * Whether the registry listing this host context can observe actually serves
   * the local roots this plugin scans. A name overlap alone is not enough: a
   * plugin-provided skill can share a name with a file on disk (for example
   * `reverse-engineer-anything` exists both in a bundle provider and in the
   * user root) without the listing covering the filesystem providers that
   * serve those roots. Prefer the instruction-file `path` the listing exposes
   * and require it to live inside a scanned root; only when a provider
   * publishes no path do we fall back to a name overlap restricted to the
   * shipped `filesystem` provider. With no scanned skills there is nothing to
   * compare, so coverage stays unknown and is treated as covered.
   * @param {unknown[]} entries
   * @param {Set<string>} scannedNames
   * @param {{ path?: string }[]} [roots] scanned roots (absolute paths)
   * @returns {boolean}
   */
  function listingCoversLocalRoots(entries, scannedNames, roots = []) {
    if (scannedNames.size === 0) return true
    if (entries.length === 0) return false
    const rootPaths = roots
      .map(root => (root !== null && typeof root === 'object' ? root.path : undefined))
      .filter(path => typeof path === 'string' && path.length > 0)
    const insideRoot = (candidate) => rootPaths.some(rootPath => (
      candidate === rootPath || candidate.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep)
    ))
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const { name, provider, path } = /** @type {{ name?: unknown, provider?: unknown, path?: unknown }} */ (entry)
      if (typeof path === 'string' && path.length > 0) {
        if (insideRoot(path)) return true
        continue
      }
      if (provider === 'filesystem' && typeof name === 'string' && scannedNames.has(name)) return true
    }
    return false
  }

  /**
   * Project the live registry catalog defensively.
   * @param {string | undefined} cwd
   * @param {Set<string>} scannedNames
   * @param {{ path?: string }[]} [roots] scanned roots (absolute paths)
   * @returns {Promise<{ available: boolean, error: string | null, entries: { name: string, description: string, provider: string, path?: string }[], coversLocalRoots: boolean }>}
   */
  async function readCatalog(cwd, scannedNames, roots = []) {
    const service = getSkillsService()
    if (service === undefined || typeof service.list !== 'function') {
      return {
        available: false,
        error: 'The skills registry is not available in this host profile.',
        entries: [],
        coversLocalRoots: false,
      }
    }
    try {
      const listed = await service.list(cwd === undefined ? {} : { cwd })
      if (!Array.isArray(listed)) throw new Error('skills.list() did not return an array')
      const entries = []
      for (const entry of listed) {
        if (entry === null || typeof entry !== 'object') continue
        const { name, description, provider, path } = /** @type {Record<string, unknown>} */ (entry)
        if (typeof name !== 'string' || typeof description !== 'string' || typeof provider !== 'string') continue
        entries.push({ name, description, provider, ...typeof path === 'string' ? { path } : {} })
      }
      return {
        available: true,
        error: null,
        entries,
        coversLocalRoots: listingCoversLocalRoots(entries, scannedNames, roots),
      }
    } catch (error) {
      return { available: false, error: errorMessage(error), entries: [], coversLocalRoots: false }
    }
  }

  /**
   * Poll the registry until `name` appears (or disappears) or the deadline
   * passes. Unavailable services report `checked:false`; a slow refresh reports
   * `visible:false` instead of failing the mutation.
   * @param {object} input
   * @param {string} input.name skill name to look for
   * @param {boolean} input.expectVisible true after create/update/install, false after delete
   * @param {string | undefined} input.cwd
   * @param {Set<string>} input.scannedNames names of valid installed skills from the route's scan
   * @param {{ path?: string }[]} [input.roots] scanned roots (absolute paths)
   * @returns {Promise<object>}
   */
  async function probeRegistry({ name, expectVisible, cwd, scannedNames, roots = [] }) {
    const service = getSkillsService()
    if (service === undefined || typeof service.list !== 'function') {
      return {
        checked: false,
        reason: 'The skills registry is not available in this host profile; the catalog was not probed.',
        visible: false,
        provider: null,
        path: null,
        catalogCount: null,
        waitedMs: 0,
      }
    }
    const started = Date.now()
    const deadline = started + registryTimeoutMs
    const listOptions = cwd === undefined ? {} : { cwd }
    /** @type {unknown[]} */
    let entries = []
    /** @type {Error | undefined} */
    let listError
    while (true) {
      try {
        const listed = await service.list(listOptions)
        if (!Array.isArray(listed)) throw new Error('skills.list() did not return an array')
        entries = listed
        listError = undefined
      } catch (error) {
        listError = error instanceof Error ? error : new Error(String(error))
      }
      const match = entries.find(entry => (
        entry !== null && typeof entry === 'object' && /** @type {{ name?: unknown }} */ (entry).name === name
      ))
      const visible = match !== undefined
      if (listError === undefined && !listingCoversLocalRoots(entries, scannedNames, roots)) {
        // The catalog we can see does not include this installation at all:
        // the providers serving these roots are scoped elsewhere, so any
        // `visible:false` here would be a false negative. Report unobservable.
        return {
          checked: false,
          visible: false,
          provider: null,
          path: null,
          catalogCount: entries.length,
          waitedMs: Date.now() - started,
          reason: UNOBSERVABLE_SCOPE_REASON,
        }
      }
      if (listError === undefined && (expectVisible ? visible : !visible)) {
        return registryResult({ entries, match, visible, checked: true, waitedMs: Date.now() - started })
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(registryPollMs, remaining))
    }
    if (listError !== undefined) {
      return {
        checked: false,
        reason: `The skills registry probe failed: ${errorMessage(listError)}`,
        visible: false,
        provider: null,
        path: null,
        catalogCount: null,
        waitedMs: Date.now() - started,
      }
    }
    const match = entries.find(entry => (
      entry !== null && typeof entry === 'object' && /** @type {{ name?: unknown }} */ (entry).name === name
    ))
    return registryResult({
      entries,
      match,
      visible: match !== undefined,
      checked: true,
      waitedMs: Date.now() - started,
    })
  }

  /** @param {object} input */
  function registryResult({ entries, match, visible, checked, waitedMs }) {
    const record = match !== null && typeof match === 'object'
      ? /** @type {{ provider?: unknown, path?: unknown }} */ (match)
      : {}
    return {
      checked,
      visible,
      provider: typeof record.provider === 'string' ? record.provider : null,
      path: typeof record.path === 'string' ? record.path : null,
      catalogCount: entries.length,
      waitedMs,
    }
  }

  /**
   * Resolve the optional `cwd` selector from a query string and/or body.
   * @param {URL} url
   * @param {unknown} [body]
   * @returns {{ value: string | undefined, error?: string }}
   */
  function readCwd(url, body) {
    let raw = url.searchParams.get('cwd')
    if ((raw === null || raw === '') && body !== null && typeof body === 'object') {
      const fromBody = /** @type {{ cwd?: unknown }} */ (body).cwd
      if (typeof fromBody === 'string' && fromBody !== '') raw = fromBody
    }
    if (raw === null || raw === undefined || raw === '') return { value: undefined }
    if (!isAbsolute(raw)) return { value: undefined, error: 'cwd must be an absolute path.' }
    return { value: resolve(raw) }
  }

  // ------------------------------------------------------------------------
  // Route implementations
  // ------------------------------------------------------------------------

  /** @param {{ url: URL }} request */
  async function stateRoute({ url }) {
    const cwd = readCwd(url)
    if (cwd.error !== undefined) return failure(400, 'bad-request', cwd.error)
    const { roots, skills } = await scanSkills({ config, cwd: cwd.value })
    const libraries = await scanLibraries({ config, skills })
    const conflicts = detectConflicts(skills)
    const catalog = await readCatalog(cwd.value, scannedNameSet(skills), roots)
    const ordered = sortSkills(skills)
    return {
      status: 200,
      payload: {
        ok: true,
        version: STATE_VERSION,
        generatedAt: new Date().toISOString(),
        cwd: cwd.value ?? null,
        roots,
        skills: ordered,
        libraries,
        catalog,
        conflicts,
        stats: {
          skills: ordered.length,
          editable: ordered.filter(skill => skill.writable === true).length,
          libraries: libraries.length,
          catalog: catalog.entries.length,
          conflicts: conflicts.length,
        },
      },
    }
  }

  /** @param {{ url: URL }} request */
  async function skillRoute({ url }) {
    const rootId = url.searchParams.get('rootId')
    const relPath = url.searchParams.get('relPath')
    if (rootId === null || rootId === '' || relPath === null || relPath === '') {
      return failure(400, 'bad-request', 'rootId and relPath are required query parameters.')
    }
    const cwd = readCwd(url)
    if (cwd.error !== undefined) return failure(400, 'bad-request', cwd.error)
    const { roots, skills } = await scanSkills({ config, cwd: cwd.value })
    const root = roots.find(candidate => candidate.id === rootId)
    if (root === undefined) return failure(404, 'not-found', `Unknown root "${rootId}".`)
    const entry = skills.find(candidate => candidate.rootId === rootId && candidate.relPath === relPath)
    if (entry === undefined) return failure(404, 'not-found', 'No skill exists at this rootId and relPath.')
    if (entry.size > SKILL_CONTENT_LIMIT) {
      return failure(413, 'payload-too-large', 'This instruction file is too large to return as JSON.')
    }
    let content
    try {
      content = await readFile(entry.path, 'utf8')
    } catch {
      return failure(404, 'not-found', 'The instruction file disappeared from disk.')
    }
    return { status: 200, payload: { ok: true, root, skill: { ...entry, content } } }
  }

  /** @param {{ url: URL, body: unknown }} request */
  async function validateRoute({ url, body }) {
    if (!isPlainObject(body)) return failure(400, 'bad-request', 'A JSON object body is required.')
    if (body.action !== 'create' && body.action !== 'update') {
      return failure(400, 'bad-request', 'action must be "create" or "update".')
    }
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      return failure(400, 'bad-request', 'force must be a boolean.')
    }
    const cwd = readCwd(url, body)
    if (cwd.error !== undefined) return failure(400, 'bad-request', cwd.error)
    const { roots, skills } = await scanSkills({ config, cwd: cwd.value })
    const draft = await validateDraft({ config, roots, skills, body })
    // Validation is a query, not a mutation: a well-formed request always gets
    // HTTP 200 and the outcome lives in the body. Only malformed requests
    // (bad JSON, missing action, invalid cwd, oversized body) are HTTP errors.
    return { status: 200, payload: validateOutcome(draft) }
  }

  /** @param {{ url: URL, body: unknown }} request */
  async function saveRoute({ url, body }) {
    if (!isPlainObject(body)) return failure(400, 'bad-request', 'A JSON object body is required.')
    if (body.action !== 'create' && body.action !== 'update') {
      return failure(400, 'bad-request', 'action must be "create" or "update".')
    }
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      return failure(400, 'bad-request', 'force must be a boolean.')
    }
    const cwd = readCwd(url, body)
    if (cwd.error !== undefined) return failure(400, 'bad-request', cwd.error)
    const { roots, skills } = await scanSkills({ config, cwd: cwd.value })
    const draft = await validateDraft({ config, roots, skills, body })
    const decision = validationResult(draft, body.force === true)
    if (decision.status !== 200) return decision
    if (draft.root === undefined || draft.relPath === undefined) {
      return failure(500, 'internal', 'Validated draft is missing its target root or relPath.')
    }
    const markdown = buildSkillFile(draft)
    let written
    try {
      written = await serializeMutation(() => (
        draft.action === 'create'
          ? createSkill({ root: draft.root, relPath: /** @type {string} */ (draft.relPath), markdown })
          : updateSkill({
            root: draft.root,
            relPath: /** @type {string} */ (draft.relPath),
            markdown,
            expectedSha256: /** @type {string} */ (body.expectedSha256),
          })
      ))
    } catch (error) {
      return mutationFailure(error)
    }
    const fresh = await scanSkills({ config, cwd: cwd.value })
    const entry = fresh.skills.find(candidate => (
      candidate.rootId === draft.root?.id && candidate.relPath === written.relPath
    ))
    if (entry === undefined) {
      return failure(500, 'internal', 'The skill was written but could not be re-read from disk.')
    }
    const registry = await probeRegistry({
      name: entry.name,
      expectVisible: true,
      cwd: cwd.value,
      scannedNames: scannedNameSet(fresh.skills),
      roots: fresh.roots,
    })
    const warnings = [...draft.warnings, ...draft.conflicts.filter(conflict => conflict.severity === 'error')]
    return { status: 200, payload: { ok: true, skill: entry, registry, warnings } }
  }

  /** @param {{ url: URL, body: unknown }} request */
  async function deleteRoute({ url, body }) {
    if (!isPlainObject(body)) return failure(400, 'bad-request', 'A JSON object body is required.')
    const rootId = body.rootId
    const relPath = body.relPath
    const expectedSha256 = body.expectedSha256
    if (typeof rootId !== 'string' || rootId === '' || typeof relPath !== 'string' || relPath === '') {
      return failure(400, 'bad-request', 'rootId and relPath are required.')
    }
    const cwd = readCwd(url, body)
    if (cwd.error !== undefined) return failure(400, 'bad-request', cwd.error)
    const { roots, skills } = await scanSkills({ config, cwd: cwd.value })
    const root = roots.find(candidate => candidate.id === rootId)
    if (root === undefined) return failure(404, 'not-found', `Unknown root "${rootId}".`)
    if (!root.writable) return failure(422, 'root-not-writable', `Root "${root.label}" is read-only.`)
    const entry = skills.find(candidate => candidate.rootId === rootId && candidate.relPath === relPath)
    if (entry === undefined) {
      return failure(404, 'not-found', 'No scanned skill exists at this rootId and relPath.')
    }
    let removed
    try {
      removed = await serializeMutation(() => deleteSkill({
        root,
        relPath,
        expectedSha256: typeof expectedSha256 === 'string' ? expectedSha256 : '',
      }))
    } catch (error) {
      return mutationFailure(error)
    }
    const name = entry.name
    const registry = await probeRegistry({
      name,
      expectVisible: false,
      cwd: cwd.value,
      scannedNames: scannedNameSet(skills, { rootId: entry.rootId, relPath: entry.relPath }),
      roots,
    })
    return {
      status: 200,
      payload: {
        ok: true,
        removed: { rootId, relPath, name },
        registry,
      },
    }
  }

  /** @param {{ url: URL, body: unknown }} request */
  async function installRoute({ url, body }) {
    if (!isPlainObject(body)) return failure(400, 'bad-request', 'A JSON object body is required.')
    if (typeof body.libraryId !== 'string' || body.libraryId === '') {
      return failure(400, 'bad-request', 'libraryId is required.')
    }
    if (typeof body.relPath !== 'string' || body.relPath === '') {
      return failure(400, 'bad-request', 'relPath is required.')
    }
    for (const field of ['overwrite', 'force']) {
      if (body[field] !== undefined && typeof body[field] !== 'boolean') {
        return failure(400, 'bad-request', `${field} must be a boolean.`)
      }
    }
    if (body.expectedSha256 !== undefined && typeof body.expectedSha256 !== 'string') {
      return failure(400, 'bad-request', 'expectedSha256 must be a string.')
    }
    const cwd = readCwd(url, body)
    if (cwd.error !== undefined) return failure(400, 'bad-request', cwd.error)
    const library = config.libraries.find(candidate => candidate.id === body.libraryId)
    if (library === undefined) {
      return failure(404, 'library-not-found', `Unknown library "${body.libraryId}".`)
    }
    const loaded = await loadLibraryEntry({
      library,
      relPath: body.relPath,
      maxSkillBytes: config.maxSkillBytes,
    })
    if (!loaded.ok) {
      if (loaded.code === 'invalid-library-skill') {
        return {
          status: 422,
          payload: {
            ok: false,
            error: { code: loaded.code, message: loaded.message },
            errors: loaded.errors ?? [],
          },
        }
      }
      const status = loaded.code === 'not-found' ? 404
        : loaded.code === 'library-too-large' ? 413
          : 400
      return failure(status, loaded.code, loaded.message)
    }
    const source = loaded.entry
    const { roots, skills } = await scanSkills({ config, cwd: cwd.value })
    const root = roots.find(candidate => candidate.writable === true)
    if (root === undefined) return failure(500, 'internal', 'No writable root is configured.')

    const sameName = skills.filter(skill => skill.valid === true && skill.name === source.name)
    const installed = sameName.find(skill => skill.writable === true)
    const shadowing = sameName.filter(skill => skill.writable !== true)
    if (installed === undefined) {
      const identicalReadOnly = shadowing.find(skill => skill.sha256 === source.sha256)
      if (identicalReadOnly !== undefined) {
        return mutationFailure(new MutationError(
          'already-installed',
          `This library skill is already available read-only from ${identicalReadOnly.rootLabel}.`,
          { rootId: identicalReadOnly.rootId, relPath: identicalReadOnly.relPath },
        ))
      }
    }
    const overwrite = body.overwrite === true
    const force = body.force === true
    const expectedSha256 = typeof body.expectedSha256 === 'string' ? body.expectedSha256 : undefined
    /** @type {import('./validate.js').Conflict[]} */
    const warnings = [...(loaded.warnings ?? [])]

    if (installed !== undefined) {
      if (installed.sha256 === source.sha256) {
        return mutationFailure(new MutationError('already-installed', 'This library skill is already installed.'))
      }
      if (!overwrite) {
        return mutationFailure(new MutationError(
          'overwrite-required',
          'Replacing an installed skill requires overwrite: true and its expected sha256.',
        ))
      }
      if (expectedSha256 === undefined || expectedSha256 === '') {
        return mutationFailure(new MutationError('stale', 'expectedSha256 is required to update an installed skill.'))
      }
      if (expectedSha256 !== installed.sha256) {
        return mutationFailure(new MutationError('stale', 'The installed copy changed on disk since it was read; refresh and try again.'))
      }
    } else if (shadowing.length > 0) {
      const conflict = computeLibraryConflict(
        source.name,
        [...shadowing]
          .sort((left, right) => left.rank - right.rank)
          .map(conflictEntry),
      )
      if (!force) {
        return {
          status: 409,
          payload: {
            ok: false,
            error: { code: 'duplicate-name', message: conflict.message, details: { conflicts: [conflict] } },
            conflicts: [conflict],
          },
        }
      }
      warnings.push(conflict)
    }

    if (installed === undefined) {
      const alias = skills.find(skill => (
        skill.writable === true
        && skill.valid === true
        && skill.entryName === source.name
        && skill.name !== source.name
      ))
      if (alias !== undefined) {
        const conflict = /** @type {import('./validate.js').Conflict} */ ({
          code: 'alias-collision',
          severity: 'error',
          name: source.name,
          message: `A ${alias.kind} entry "${alias.relPath}" already claims this skill name in the writable root.`,
          entries: [conflictEntry(alias)],
        })
        if (!force) {
          return {
            status: 409,
            payload: {
              ok: false,
              error: { code: 'alias-collision', message: conflict.message, details: { conflicts: [conflict] } },
              conflicts: [conflict],
            },
          }
        }
        warnings.push(conflict)
      }
    }

    const others = skills.filter(skill => (
      skill.name !== source.name
      && (installed === undefined || !(skill.rootId === installed.rootId && skill.relPath === installed.relPath))
    ))
    warnings.push(...overlapWarningsForCandidate({
      name: source.name,
      description: source.description,
      entry: undefined,
      skills: others,
    }))

    let result
    try {
      result = await serializeMutation(() => installSkill({
        root,
        source: {
          kind: source.kind,
          name: source.name,
          content: source.content,
          ...source.bundleDir === undefined ? {} : { bundleDir: source.bundleDir },
        },
        installed,
        overwrite,
        expectedSha256,
      }))
    } catch (error) {
      return mutationFailure(error)
    }
    const fresh = await scanSkills({ config, cwd: cwd.value })
    const entry = fresh.skills.find(candidate => (
      candidate.rootId === root.id && candidate.relPath === result.relPath
    ))
    if (entry === undefined) {
      return failure(500, 'internal', 'The skill was installed but could not be re-read from disk.')
    }
    const registry = await probeRegistry({
      name: entry.name,
      expectVisible: true,
      cwd: cwd.value,
      scannedNames: scannedNameSet(fresh.skills),
      roots: fresh.roots,
    })
    return {
      status: 200,
      payload: {
        ok: true,
        skill: entry,
        library: { id: library.id, relPath: source.relPath },
        registry,
        warnings,
      },
    }
  }

  /** @param {{ url: URL }} request */
  async function healthRoute({ url }) {
    const cwd = readCwd(url)
    const roots = await resolveRoots(config, cwd.error === undefined ? cwd.value : undefined)
    return {
      status: 200,
      payload: {
        ok: true,
        name: 'dsh-skills-studio',
        version: STATE_VERSION,
        generatedAt: new Date().toISOString(),
        writableRoot: config.writableRoot,
        agentsHome: config.agentsHome,
        dshHome: config.dshHome,
        roots,
        libraries: config.libraries.map(library => ({
          id: library.id,
          label: library.label,
          path: library.path,
        })),
      },
    }
  }

  /**
   * The structural part of a validation outcome: where the draft would land.
   * @param {Awaited<ReturnType<typeof validateDraft>>} draft
   */
  function draftPayload(draft) {
    return {
      action: draft.action,
      root: draft.root === undefined ? null : {
        id: draft.root.id,
        label: draft.root.label,
        path: draft.root.path,
        scope: draft.root.scope,
        rank: draft.root.rank,
        writable: draft.root.writable,
        exists: draft.root.exists,
      },
      kind: draft.kind ?? null,
      relPath: draft.relPath ?? null,
      targetPath: draft.targetPath ?? null,
      name: draft.name,
      modelInvocable: draft.modelInvocable,
      userInvocable: draft.userInvocable,
      bodyBytes: Buffer.byteLength(draft.body, 'utf8'),
    }
  }

  /**
   * Shape a validation-only response: always HTTP 200 for a well-formed
   * request; `ok` tells the caller whether the draft could be saved without
   * forcing, while the arrays carry the detail.
   * @param {Awaited<ReturnType<typeof validateDraft>>} draft
   */
  function validateOutcome(draft) {
    const blocking = draft.conflicts.filter(conflict => conflict.severity === 'error')
    const clean = draft.errors.length === 0 && blocking.length === 0
    return {
      ok: clean,
      valid: clean,
      ...draftPayload(draft),
      errors: draft.errors,
      conflicts: blocking,
      warnings: draft.warnings,
    }
  }

  /**
   * Turn a validated draft into either the success decision or the failure
   * response for `/save`. Success is a 200 carrying the arrays the client
   * renders from.
   * @param {Awaited<ReturnType<typeof validateDraft>>} draft
   * @param {boolean} force
   */
  function validationResult(draft, force) {
    const blocking = draft.conflicts.filter(conflict => conflict.severity === 'error')
    if (draft.errors.length > 0) {
      return {
        status: 422,
        payload: {
          ok: false,
          error: {
            code: 'validation-failed',
            message: `${draft.errors.length} validation error${draft.errors.length === 1 ? '' : 's'}.`,
          },
          errors: draft.errors,
          conflicts: blocking,
          warnings: draft.warnings,
        },
      }
    }
    const nonBypassable = blocking.filter(conflict => !FORCE_BYPASSABLE_CODES.has(conflict.code))
    if ((blocking.length > 0 && !force) || nonBypassable.length > 0) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: {
            code: 'conflict',
            message: (blocking.length > 0 ? blocking : nonBypassable)[0]?.message ?? 'Saving would create a conflicting skill.',
          },
          errors: [],
          conflicts: blocking,
          warnings: draft.warnings,
        },
      }
    }
    return {
      status: 200,
      payload: {
        ok: true,
        valid: true,
        ...draftPayload(draft),
        errors: [],
        conflicts: blocking,
        warnings: draft.warnings,
      },
    }
  }

  // ------------------------------------------------------------------------
  // Dispatch and transport
  // ------------------------------------------------------------------------

  /**
   * Route one already-parsed request.
   * @param {{ method?: string, url?: string, body?: unknown }} request
   * @returns {Promise<{ status: number, headers: Record<string, string>, payload: object }>}
   */
  async function handle(request) {
    const method = String(request?.method ?? 'GET').toUpperCase()
    let url
    try {
      url = new URL(request?.url ?? '/', 'http://localhost')
    } catch {
      return failure(400, 'bad-request', 'Malformed request URL.')
    }
    const route = knownRoutes.get(url.pathname)
    if (route === undefined) {
      return failure(404, 'not-found', `Unknown endpoint "${url.pathname}".`)
    }
    if (!route.methods.includes(method)) {
      return {
        ...failure(405, 'method-not-allowed', `${method} is not allowed for ${url.pathname}.`),
        headers: { allow: route.methods.join(', ') },
      }
    }
    let body = request?.body
    if (method === 'POST') {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        try {
          body = JSON.parse(body.toString())
        } catch {
          return failure(400, 'bad-request', 'Request body must be valid JSON.')
        }
      }
    }
    try {
      const result = await /** @type {(request: { url: URL, body: unknown }) => Promise<{ status: number, headers?: Record<string, string>, payload: object }>} */ (route.run)({ url, body })
      return { ...result, headers: result.headers ?? {} }
    } catch (error) {
      if (error instanceof MutationError) return mutationFailure(error)
      return failure(500, 'internal', errorMessage(error))
    }
  }

  /**
   * Node HTTP handler. Owns the full response lifecycle and never rejects.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handler(req, res) {
    let result
    try {
      const method = String(req.method ?? 'GET').toUpperCase()
      let url
      try {
        url = new URL(String(req.url ?? '/'), 'http://localhost')
      } catch {
        result = failure(400, 'bad-request', 'Malformed request URL.')
      }
      if (result === undefined) {
        const route = knownRoutes.get(url.pathname)
        if (route === undefined) {
          result = failure(404, 'not-found', `Unknown endpoint "${url.pathname}".`)
        } else if (!route.methods.includes(method)) {
          result = {
            ...failure(405, 'method-not-allowed', `${method} is not allowed for ${url.pathname}.`),
            headers: { allow: route.methods.join(', ') },
          }
        } else if (method === 'POST') {
          const read = await readJsonBody(req, BODY_LIMIT_BYTES)
          if (read.ok) {
            result = await handle({ method, url: url.pathname + url.search, body: read.value })
          } else {
            result = read.result
          }
        } else {
          result = await handle({ method, url: url.pathname + url.search })
        }
      }
    } catch (error) {
      result = error instanceof MutationError
        ? mutationFailure(error)
        : failure(500, 'internal', errorMessage(error))
    }
    writeResponse(res, /** @type {{ status: number, headers?: Record<string, string>, payload: object }} */ (result))
  }

  return { handler, handle, prefix: API_PREFIX }
}

/**
 * Read and JSON-parse a request body with a hard byte cap.
 * @param {import('node:http').IncomingMessage | AsyncIterable<Buffer|string>} req
 * @param {number} limit
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, result: { status: number, headers: Record<string, string>, payload: object } }>}
 */
async function readJsonBody(req, limit) {
  const chunks = []
  let total = 0
  try {
    for await (const chunk of /** @type {AsyncIterable<Buffer|string>} */ (req)) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buffer.length
      if (total > limit) {
        return {
          ok: false,
          result: failure(413, 'body-too-large', `Request body exceeds the ${limit}-byte limit.`),
        }
      }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, result: failure(400, 'bad-request', 'Could not read the request body.') }
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') {
    return { ok: false, result: failure(400, 'bad-request', 'A JSON object body is required.') }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, result: failure(400, 'bad-request', 'Request body must be valid JSON.') }
  }
}

/**
 * Write one JSON response with the plugin's fixed headers.
 * @param {import('node:http').ServerResponse} res
 * @param {{ status: number, headers?: Record<string, string>, payload: object }} result
 */
function writeResponse(res, result) {
  const headers = {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...result.headers,
  }
  let body
  try {
    body = JSON.stringify(result.payload)
  } catch (error) {
    body = JSON.stringify({
      ok: false,
      error: { code: 'internal', message: `Could not serialize the response: ${errorMessage(error)}` },
    })
  }
  try {
    res.writeHead(result.status, headers)
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch {
      // The socket is already gone; nothing else to do.
    }
  }
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {{ status: number, headers: Record<string, string>, payload: { ok: false, error: { code: string, message: string } } }}
 */
function failure(status, code, message) {
  return { status, headers: {}, payload: { ok: false, error: { code, message } } }
}

/** @type {Record<string, number>} */
const MUTATION_STATUS = {
  'not-found': 404,
  'library-not-found': 404,
  stale: 409,
  'target-exists': 409,
  'already-installed': 409,
  'overwrite-required': 409,
  'duplicate-name': 409,
  'alias-collision': 409,
  'invalid-path': 400,
  'symlink-target': 400,
  'read-only': 422,
  'sha-required': 422,
  'invalid-library-skill': 422,
  'symlink-source': 422,
  'body-too-large': 413,
  'library-too-large': 413,
  'permission-denied': 500,
  'filesystem-unavailable': 500,
  internal: 500,
}

/**
 * @param {unknown} error
 * @returns {{ status: number, headers: Record<string, string>, payload: object }}
 */
function mutationFailure(error) {
  const known = error instanceof MutationError ? error : new MutationError('internal', errorMessage(error))
  const status = MUTATION_STATUS[known.code] ?? 500
  return {
    status,
    headers: {},
    payload: {
      ok: false,
      error: {
        code: known.code,
        message: known.message,
        ...known.details === undefined ? {} : { details: known.details },
      },
    },
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}
