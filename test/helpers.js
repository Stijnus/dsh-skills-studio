/**
 * Shared test helpers.
 *
 * Every test filesystem lives under `os.tmpdir()`; nothing here reads or writes
 * the real `~/.agents` / `~/.dsh`. The fake HTTP request/response pair drives
 * the real handler without opening a socket.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serializeSkillFile } from '../src/frontmatter.js'

/**
 * Create a temporary workspace removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
export async function tempWorkspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsm-test-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {})
  })
  return base
}

/**
 * Write one bundle skill `<dir>/<name>/SKILL.md`.
 * @param {string} dir root directory
 * @param {string} name directory / skill name
 * @param {object} [fields] frontmatter fields; defaults to a valid skill
 * @returns {Promise<string>} absolute SKILL.md path
 */
export async function writeBundleSkill(dir, name, fields = {}) {
  const bundleDir = join(dir, name)
  await mkdir(bundleDir, { recursive: true })
  return writeInstructionFile(join(bundleDir, 'SKILL.md'), {
    name,
    description: `Skill ${name} used by tests.`,
    ...fields,
  })
}

/**
 * Write one flat skill `<dir>/<name>.md`.
 * @param {string} dir root directory
 * @param {string} name file basename
 * @param {object} [fields]
 * @returns {Promise<string>} absolute file path
 */
export async function writeFlatSkill(dir, name, fields = {}) {
  await mkdir(dir, { recursive: true })
  return writeInstructionFile(join(dir, `${name}.md`), {
    name,
    description: `Skill ${name} used by tests.`,
    ...fields,
  })
}

/**
 * Write an instruction file with the plugin's serializer.
 * @param {string} path
 * @param {object} fields
 * @returns {Promise<string>}
 */
export async function writeInstructionFile(path, fields) {
  const text = serializeSkillFile({
    name: fields.name,
    description: fields.description,
    whenToUse: fields.whenToUse,
    modelInvocable: fields.modelInvocable,
    userInvocable: fields.userInvocable,
    body: fields.body ?? `# ${fields.name}\n`,
  })
  await writeFile(path, fields.raw ?? text, 'utf8')
  return path
}

/**
 * Raw file write helper for intentionally malformed fixtures.
 * @param {string} path
 * @param {string} content
 */
export async function writeRaw(path, content) {
  await writeFile(path, content, 'utf8')
}

/**
 * Build a minimal config object for a temp workspace.
 * @param {string} base
 * @param {object} [overrides]
 * @returns {Record<string, unknown>}
 */
export function tempConfig(base, overrides = {}) {
  return {
    agentsHome: join(base, 'agents'),
    dshHome: join(base, 'dsh'),
    ...overrides,
  }
}

/**
 * A request-shaped async iterable the Node handler can consume.
 * @param {object} input
 * @param {string} [input.method]
 * @param {string} [input.url]
 * @param {unknown} [input.body] JSON-serializable body; a string is sent verbatim
 * @param {Buffer[]} [input.chunks] reject/override raw chunks
 */
export function fakeRequest({ method = 'GET', url = '/', body, chunks } = {}) {
  const payload = chunks ?? (body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

/**
 * A response-shaped sink capturing status, headers, and body.
 */
export function fakeResponse() {
  /** @type {{ statusCode?: number, headers?: Record<string, string>, body?: string, destroyed: boolean }} */
  const captured = { destroyed: false }
  return {
    captured,
    writeHead(statusCode, headers) {
      captured.statusCode = statusCode
      captured.headers = headers
    },
    end(body) {
      captured.body = body
    },
    destroy() {
      captured.destroyed = true
    },
  }
}

/**
 * Parse a captured JSON response body.
 * @param {{ body?: string }} captured
 * @returns {any}
 */
export function jsonBody(captured) {
  return JSON.parse(String(captured.body))
}

/**
 * Minimal Cordis-shaped context exposing only `ctx.get`.
 * @param {Record<string, unknown>} services
 * @param {object} [extra]
 */
export function fakeCtx(services = {}, extra = {}) {
  return {
    get(name) {
      return services[name]
    },
    logger: { info() {}, warn() {}, error() {} },
    ...extra,
  }
}

/**
 * Fake `ctx.skills` registry: returns `catalog` once `afterCalls` calls have
 * happened, which lets a test drive the polling probe.
 * @param {object} input
 * @param {unknown[]} [input.catalog]
 * @param {number} [input.afterCalls] return the catalog only after this many list() calls
 * @param {boolean} [input.fail]
 */
export function fakeSkills({ catalog = [], afterCalls = 0, fail = false } = {}) {
  let calls = 0
  return {
    calls: () => calls,
    async list() {
      calls += 1
      if (fail) throw new Error('registry exploded')
      return calls > afterCalls ? catalog : []
    },
  }
}
