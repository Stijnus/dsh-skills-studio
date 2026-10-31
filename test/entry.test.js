/**
 * Plugin entry: Cordis shape, effect-scoped route registration, config errors.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import plugin, { apply, inject, name } from '../index.js'
import { API_PREFIX } from '../src/api.js'
import { ConfigError } from '../src/config.js'
import { fakeRequest, fakeResponse, jsonBody, tempConfig, tempWorkspace } from './helpers.js'

/**
 * Minimal Cordis-shaped host that records route and effect registrations.
 */
function fakeHost() {
  /** @type {object[]} */
  const routes = []
  /** @type {{ execute: Function, label: string }[]} */
  const effects = []
  /** @type {Function[]} */
  const disposers = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          route.disposed = true
        }
      },
    },
    effect(execute, label) {
      effects.push({ execute, label })
      disposers.push(execute())
    },
    logger: { info() {} },
    get() {
      return undefined
    },
  }
  return { ctx, routes, effects, disposers }
}

test('the plugin exports the Cordis name, inject list, and apply function', () => {
  assert.equal(name, 'skills-studio')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(typeof apply, 'function')
  assert.equal(plugin.name, name)
  assert.deepEqual(plugin.inject, inject)
  assert.equal(plugin.apply, apply)
})

test('apply registers one prefix route inside ctx.effect and returns its disposer', async (t) => {
  const base = await tempWorkspace(t)
  const { ctx, routes, effects, disposers } = fakeHost()
  const api = apply(ctx, tempConfig(base))
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, API_PREFIX)
  assert.equal(typeof routes[0].handler, 'function')
  assert.equal(effects.length, 1)
  assert.match(effects[0].label, /skills-studio/)
  assert.equal(disposers.length, 1)
  assert.equal(typeof disposers[0], 'function')
  disposers[0]()
  assert.equal(routes[0].disposed, true)
  assert.equal(typeof api.handle, 'function')
})

test('apply throws ConfigError for a malformed plugin row config', () => {
  const { ctx } = fakeHost()
  assert.throws(
    () => apply(ctx, { agentsHome: 42 }),
    error => error instanceof ConfigError && error.field === 'agentsHome',
  )
})

test('apply throws a clear error when the required web server service is missing', () => {
  assert.throws(
    () => apply({ logger: { info() {} } }, {}),
    error => error instanceof TypeError && /webServer/.test(error.message),
  )
})

test('apply does not require effect, logger, or the optional skills service', () => {
  /** @type {object[]} */
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
      },
    },
    get() {
      throw new Error('cannot get property "skills" without inject')
    },
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(routes.length, 1)
})

test('the registered handler serves the real state endpoint', async (t) => {
  const base = await tempWorkspace(t)
  const { ctx, routes } = fakeHost()
  apply(ctx, tempConfig(base))
  const res = fakeResponse()
  await routes[0].handler(fakeRequest({ method: 'GET', url: `${API_PREFIX}/api/state` }), res)
  const captured = /** @type {{ statusCode?: number, headers?: Record<string, string>, body?: string }} */ (res.captured)
  assert.equal(captured.statusCode, 200)
  assert.equal(captured.headers?.['cache-control'], 'no-store')
  const payload = jsonBody(captured)
  assert.equal(payload.ok, true)
  assert.equal(payload.version, 1)
})
