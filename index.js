/**
 * dsh-skills-studio — host plugin entry.
 *
 * Registers one `webServer` prefix route (`/skills-studio`) that backs the
 * Skills settings page: scan the local skill roots, validate drafts, write
 * `SKILL.md` files atomically under the configured writable root, and report
 * whether the live registry now serves the skill.
 *
 * `ctx.skills` is optional and read defensively through `ctx.get('skills')` at
 * request time, so the plugin also works in profiles without a skill registry
 * (the page then shows the catalog as unavailable instead of failing).
 *
 * @module dsh-skills-studio
 */

import { createApi, API_PREFIX } from './src/api.js'
import { normalizeConfig } from './src/config.js'

/** Cordis plugin name. */
export const name = 'skills-studio'

/** The web server is the one required service; anything else is read optionally. */
export const inject = ['webServer']

/**
 * Register the `/skills-studio` route. Config is validated here, at load time,
 * so a malformed plugin row fails loudly instead of at the first request.
 *
 * @param {object} ctx host context exposing `webServer` (required) plus
 *   optional `logger` and optional `skills` (read via `ctx.get`)
 * @param {unknown} [config] plugin row config from `cordis.patch.yml`
 * @returns {{ handler: Function, handle: Function, prefix: string }} the API instance (useful in tests)
 */
export function apply(ctx, config = {}) {
  const normalized = normalizeConfig(config)
  const api = createApi({ config: normalized, ctx })

  if (ctx === undefined || ctx === null || ctx.webServer === undefined || typeof ctx.webServer.register !== 'function') {
    throw new TypeError(
      'skills-studio: ctx.webServer is unavailable; mount @deepseek-ai/dsh-host-webserver in this profile.',
    )
  }

  const register = () => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: api.handler,
  })
  if (typeof ctx.effect === 'function') {
    // Route ownership lives with this plugin's fiber: disposing the plugin
    // removes the route through the returned disposer.
    ctx.effect(register, 'skills-studio: /skills-studio routes')
  } else {
    register()
  }

  try {
    ctx.logger?.info?.(
      `skills-studio: /skills-studio routes registered; writable root ${normalized.writableRoot}`,
    )
  } catch {
    // A throwing logger must not take the plugin down.
  }
  return api
}

/** Cordis accepts a default export object carrying `inject` + `apply`. */
export default { name, inject, apply }
