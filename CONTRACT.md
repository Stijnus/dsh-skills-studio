# dsh-skills-manager — build contract (v1)

A DSH bundle that adds a **Skills** page to Settings: install/edit skills on disk, see
what agents can actually load, and block conflicting saves before they happen.

Read this file before writing code. It is the single source of truth for module boundaries,
the HTTP contract, conflict rules, and the UI. If you disagree with it, message the Lead
instead of silently diverging.

## Product scope

Two surfaces in one section:

- **Installed** — every skill discovered in the local DSH skill roots, grouped by root.
  Entries in the writable root are editable/removable; entries in read-only roots are shown
  with a read-only badge.
- **Available** — (a) skills the live `ctx.skills` registry serves from plugin/bundle
  providers (read-only, "from plugins"), and (b) skills from configured **libraries**
  (skill-pack directories, e.g. the deepseek-stack checkout) which can be **installed** or
  **updated** into the writable root.

Add/Edit form writes real `SKILL.md` files, validates the candidate, detects conflicts, and
persists atomically. After a successful write the host asks `ctx.skills` whether the skill is
now in the agent catalog (live reload proof) and reports that to the UI.

No server-side model calls, no shell execution, no network.

## Package layout and ownership

```
dsh-skills-manager/
  package.json          Lead
  cordis.patch.yml      Lead
  icon.svg              Lead
  README.md             Lead
  CONTRACT.md           Lead
  index.js              api-dev      plugin entry + webServer registration
  src/config.js         api-dev      config normalization/defaults
  src/roots.js          api-dev      root resolution
  src/frontmatter.js    api-dev      copied parser + serializer (attribution header)
  src/scan.js           api-dev      root scan, hashes, library scan, status
  src/validate.js       api-dev      field validation, conflicts, overlap warnings
  src/mutate.js         api-dev      atomic write/update/delete/install, path safety
  src/api.js            api-dev      HTTP routing + JSON envelope + registry probe
  test/*.test.js        api-dev      node --test
  client.js             ui-dev       settings.section UI (ModuleLoader bundle)
  verify/               verifier     independent harness + evidence
```

Only edit files in your task's write scope. `client.js` is ui-dev's; `index.js`/`src/` are
api-dev's. The Lead owns the manifest files and integration.

## Runtime facts (verified in the running app, DSH 0.2.1-rc.5)

- Settings pages are client plugins registering into the `settings.section` slot.
- Client module format: `window.__ModuleLoader__.load({ id: '<package name>', factory(require) { … return module.exports } })`,
  module exports `{ name, inject, apply }`. React comes from `require('react')`.
- Client services: `ctx.get('slots')` (required-ish), `ctx.get('locale')` (optional),
  `ctx.get('sessions')` (optional). Reading a service not listed in `inject` throws, so use
  `ctx.get()` for everything optional and never `ctx.locale` directly.
- Host web routes: `ctx.webServer.register({ kind: 'prefix', path: '/skills-manager', handler(req, res) })`
  inside `ctx.effect(() => …)`.
- Host plugin entry: named `export const name`, `export const inject = ['webServer']`,
  `export function apply(ctx, config = {})`. Read optional services with `ctx.get('skills')`.
- The shipped filesystem skill provider roots/ranks: project `.dsh/skills` (100),
  project `.agents/skills` (200), custom dirs (300), `<dshHome>/skills` (400),
  `<agentsHome>/skills` (500). Bundle = `<root>/<name>/SKILL.md`; flat = `<root>/<name>.md`.
  Only top-level entries are discovered (no recursion).
- Frontmatter keys: `name` (required, kebab-case), `description` (required),
  `whenToUse`, `disable-model-invocation`, `user-invocable` (YAML booleans). Lower rank wins
  duplicate names. The filesystem provider watches roots and invalidates the registry, so a
  write reaches agents without a restart a moment later.
- Registry API: `ctx.skills.list({ cwd })` → summaries `{ name, description, provider, path? }`.
  Treat it as optional and defensive; never let it fail a request.

`src/frontmatter.js` is a copy of the battle-tested parser from the MIT-licensed
`dsh-claude-skills` project (`parseFrontmatter`, `parseYamlSubset`, `frontmatterBoolean`,
`isKebabCase`), with a source header. Add serialization helpers there.

## Config (plugin row `config`, all optional)

```js
{
  agentsHome: string,        // default $DSH_AGENTS_HOME || ~/.agents
  dshHome: string,           // default $DSH_HOME || ~/.dsh
  writableRoot: string,      // default <agentsHome>/skills
  includeUserDshRoot: true,  // scan <dshHome>/skills (read-only)
  includeProjectRoots: true, // only when a cwd is supplied to the API
  customSkillDirs: [],       // extra read-only roots, rank 300
  libraries: [               // "Available" installable packs
    // { id: 'deepseek-stack', label: 'deepseek-stack', path: '/abs/path/to/skills' }
  ],
  maxSkillBytes: 262144,     // instruction file / body cap
}
```

Normalization: reject a non-object config, non-string paths, non-boolean flags, and
non-array libraries with a thrown `ConfigError` naming the field. Trim paths; expand `~`.

Resolved roots (in rank order; stable ids):

| id | label | scope | rank | writable |
|---|---|---|---|---|
| `project-dsh` | Project (.dsh) | project | 100 | no |
| `project-agents` | Project (.agents) | project | 200 | no |
| `custom-<n>` | custom dir basename | custom | 300 | no |
| `managed` | My skills | managed/read-write | 450 | yes — only when the writable path differs from `<agentsHome>/skills` |
| `user-dsh` | User (.dsh) | user | 400 | no (skip if `includeUserDshRoot` false) |
| `user-agents` | User (.agents) | user | 500 | yes when it equals the writable root |

Emit only roots that exist OR the writable root (always emit the writable root, `exists:false`
when missing). Project roots need a `cwd`; without one, skip them.

`Root = { id, label, path, scope, rank, writable, exists }`.

## HTTP API

Prefix `/skills-manager`, JSON only, `cache-control: no-store`, body cap 1 MiB.
Success envelope `{ ok: true, ... }`. Failure:
`{ ok: false, error: { code, message, details? } }` with status 400/404/405/413/422/409/500.
Validation responses additionally carry `{ errors, conflicts, warnings }` (see below).

### GET `/skills-manager/api/state?cwd=<abs path>`

```json
{
  "ok": true,
  "version": 1,
  "generatedAt": "2026-…Z",
  "cwd": "/abs/path or null",
  "roots": [Root],
  "skills": [{
    "id": "<rootId>:<relPath>",
    "name": "ds-mode",
    "description": "…",
    "whenToUse": "…(optional)",
    "modelInvocable": true,
    "userInvocable": true,
    "kind": "bundle" | "flat",
    "rootId": "user-agents",
    "rootLabel": "User (.agents)",
    "scope": "user",
    "rank": 500,
    "path": "/abs/…/SKILL.md",
    "relPath": "ds-mode/SKILL.md",
    "entryName": "ds-mode",
    "writable": true,
    "sha256": "…",
    "size": 1234,
    "updatedAt": "2026-…Z",
    "valid": true,
    "errors": []
  }],
  "libraries": [{
    "id": "deepseek-stack",
    "label": "deepseek-stack",
    "path": "/abs/path",
    "exists": true,
    "kind": "skills",
    "skills": [{
      "name": "ds-plan-loop",
      "description": "…",
      "kind": "bundle" | "flat",
      "relPath": "ds-plan-loop/SKILL.md",
      "sha256": "…",
      "status": "installed" | "update" | "available" | "conflict",
      "installed": { "rootId": "user-agents", "relPath": "…", "sha256": "…" },  // optional
      "conflict": Conflict                                                       // optional
    }]
  }],
  "catalog": {
    "available": true,
    "error": null,
    "entries": [{ "name": "mac-design", "description": "…", "provider": "…", "path": "…" }]
  },
  "conflicts": [Conflict],
  "stats": { "skills": 0, "editable": 0, "libraries": 0, "catalog": 0, "conflicts": 0 }
}
```

Invalid skills appear in `skills` with `valid:false` and `errors:[…]`; they are never counted
as installed for library status, and they never abort the response.

### Conflict object

```json
{
  "code": "duplicate-name" | "alias-collision" | "overlap",
  "severity": "error" | "warning",
  "name": "ds-mode",
  "message": "Same name in User (.agents) rank 500 and Project (.agents) rank 200; rank 200 wins and shadows the other.",
  "entries": [{ "rootId": "user-agents", "rootLabel": "User (.agents)", "relPath": "ds-mode/SKILL.md", "path": "/abs/…", "rank": 500 }],
  "sharedWords": ["plan", "loop"]
}
```

Rules:
- `duplicate-name` (error): the same skill name appears in 2+ roots, or twice in one root.
- `alias-collision` (error): a flat `<name>.md` and a bundle `<name>/` in the same root.
- `overlap` (warning): description token overlap with another skill. Tokens: lowercase
  alphanumeric words length > 2 minus stop words. Jaccard ≥ 0.5 against another skill →
  warning carrying `sharedWords`. Deduplicate per pair; cap at 5 warnings.

### GET `/skills-manager/api/skill?rootId=<id>&relPath=<path>`

→ `{ ok: true, root: Root, skill: { …entry, content: "full file text" } }`.
404 `not-found` when `rootId`/`relPath` does not name a scanned entry.

### POST `/skills-manager/api/validate` and `POST /skills-manager/api/save`

Body (action `create`):

```json
{ "action": "create", "rootId": "user-agents", "kind": "bundle",
  "name": "my-skill", "description": "…", "whenToUse": "…",
  "modelInvocable": true, "userInvocable": true, "body": "markdown", "force": false }
```

Body (action `update`): same plus `"relPath": "my-skill/SKILL.md"` and
`"expectedSha256": "<sha of the current instruction file>"`; `name` must equal the current
name (`name-immutable` otherwise); `kind` is derived from the existing entry.

`validate` never writes. `save` re-runs the identical validation server-side and writes only
when there are no `errors` and no `severity:"error"` conflicts (unless `force:true`, which may
bypass **only** `duplicate-name`/`alias-collision` conflicts, never field errors, stale
checks, or path problems).

Response on validation failure: HTTP 422 (errors) / 409 (blocking conflicts):
`{ ok:false, errors, conflicts, warnings }`.

Response on success:

```json
{ "ok": true,
  "skill": { SkillEntry },
  "registry": { "checked": true, "visible": true, "provider": "filesystem",
                "path": "/abs/…", "catalogCount": 104, "waitedMs": 120 },
  "warnings": [Conflict] }
```

`registry.checked:false` when `ctx.skills` is unavailable; include `reason`.
Wait up to 2000 ms (poll every 50 ms) for `ctx.skills.list({cwd})` to contain the name after
create/update; report `visible:false` after the deadline instead of failing the request.

Validation rules (produce `errors: [{ field, code, message }]`):
- `name`: required, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤ 64 chars, not `.`/`..`.
- `description`: required, trimmed non-empty, ≤ 1024 chars; warning above 300 chars
  (`description-long`) because catalogs cap rendered text.
- `whenToUse`: optional, ≤ 512 chars.
- `body`: optional string, ≤ `maxSkillBytes` (utf8 bytes).
- `rootId`: must exist and be writable.
- create: computed relPath `<name>/SKILL.md` (bundle) or `<name>.md` (flat); if any entry or
  empty directory already occupies it → `target-exists` (update instead).
- update: entry must exist in that root, be writable, and sha == `expectedSha256`
  (`stale` otherwise, `not-found` when gone). Never silently overwrite external edits.
- candidate name equality with any **other** scanned entry → `duplicate-name` conflict (see
  below); if the path is the updated entry itself, ignore.

Write format (UTF-8, `\n` endings, mode 0644):

```markdown
---
name: <name>
description: <JSON-escaped double-quoted string>
whenToUse: <quoted>            # only when non-empty
disable-model-invocation: true # only when modelInvocable === false
user-invocable: false          # only when userInvocable === false
---
<body trimmed of trailing whitespace>
```

### POST `/skills-manager/api/delete`

`{ "rootId": "user-agents", "relPath": "my-skill/SKILL.md", "expectedSha256": "…" }`
→ `{ ok:true, removed: { rootId, relPath, name }, registry: { checked, visible:false, catalogCount, waitedMs } }`.
Requires a writable root, an existing scanned entry, and a matching sha (`stale`/`not-found`).
Deleting a bundle removes its own directory; refuse when the resolved path escapes the root,
is a symlink, or when the bundle directory contains something other than `SKILL.md` and
regular resource files under the bundle (still allowed: `references/`, `scripts/`, `assets/`,
any regular files/dirs inside that bundle — just never outside it).

### POST `/skills-manager/api/install`

`{ "libraryId": "deepseek-stack", "relPath": "ds-plan-loop/SKILL.md", "overwrite": false,
   "expectedSha256": "…", "force": false }`

- `available` → copy the library entry into the writable root (bundle dir or flat file).
- `update` → require `overwrite:true` and `expectedSha256` = sha of the installed instruction
  file; copy over it atomically.
- `conflict` (same name in a read-only root) → 409 `duplicate-name`; `force:true` may write
  anyway (the UI must state it will be shadowed).
- `installed` → 409 `already-installed`.
- Library entries must re-validate against the current filesystem state and the same field
  rules; never trust the state snapshot.
→ success `{ ok:true, skill: SkillEntry, library: { id, relPath }, registry: {…}, warnings }`.

### Path safety (all mutations)

- Resolve root path first; resolve target with `path.resolve`; require
  `target === root || target.startsWith(root + path.sep)`. Reject NUL, `..`, absolute
  relPath, and backslashes.
- `lstat` the containing directory and target; reject symlinks anywhere on the target path
  under the root (walk components with `lstat`).
- Create parent dirs with `mkdir({recursive:true})` only under the resolved root.
- Atomic write: temp file `<target>.tmp-<random>` in the same directory, `writeFile` with
  `'wx'`, `rename` over the target; remove the temp on failure. Never write outside the root.
- Concurrent writes: keep a per-process serialized promise chain for mutations.

## Client UI (settings.section)

- Register `settings.section` id `skills`, order `40`, label from local dictionary
  ("Skills"), locale namespace `settings.skills` when `ctx.get('locale')` exists.
- `inject = ['slots']`; everything else via `ctx.get()`. Never throw from `apply` or from a
  render when an optional service is missing.
- Fetch `GET /skills-manager/api/state` on mount, after every mutation, and on manual
  refresh. Same-origin `fetch(url, { credentials: 'same-origin' })`.
- Layout (translated from the active moodboard language into the DSH settings shell):
  a compact hero row (title from the shell already; use a one-line subtitle), a stat strip
  (installed / available / conflicts), one accent primary button "Add skill", a search
  input, then a segmented control **Installed | Available**. Cards use the host surfaces
  (`--dsw-alias-bg-layer-2`, `--dsw-alias-border-l2`, `--dsw-alias-label-*`,
  `--dsw-alias-interactive-bg-hover`, `--dsw-alias-state-error-primary`,
  `--dsw-alias-state-success-primary`, `--dsw-radius-md`, `--dsw-radius-panel`). Rounded
  cards, generous spacing, one accent for primary actions, tiny eyebrow labels for groups,
  pill buttons for row actions — mirroring the reference card/row rhythm, not its colors.
- Installed list: groups per root with a tiny eyebrow label + count; each row shows a small
  rounded monogram tile (first letter), name, description (2-line clamp), meta badges
  (bundle/flat, model/user invocation, root, rank), and right-aligned actions:
  Edit / Delete for writable entries, "Read-only" tag otherwise. Search filters name +
  description. Empty state: "No skills found in the scanned roots."
- Conflicts banner above the list when `conflicts` has entries: error tone for
  duplicate/alias, warning tone for overlap, listing affected names and why. This is the
  "agents cannot find / skills conflict" explanation surface.
- Available tab: one card per configured library with its skill rows and a status pill:
  Installed / Update / Install. Install calls the API; Update asks for confirmation
  ("This replaces the installed copy."), then installs with `overwrite`+expectedSha256.
  Below that, a read-only "From plugins" group lists `catalog.entries` that are not on disk
  (provider shown). Empty state when neither exists: explain how to configure a library path.
- Add/Edit editor: inline card replacing the list (keeps focus inside the section):
  name (disabled on edit), description textarea, when-to-use (optional), two invocation
  checkboxes (default checked), kind segmented (bundle/flat, create only), root select for
  create (writable roots), body textarea (monospace, min 10 rows), live validation as the
  draft changes (debounce 350 ms → `/validate`), inline field errors, blocking-conflict
  list, warnings list, and a "force save" checkbox that appears only when the blocking
  conflicts are duplicate-name/alias-collision. Save disabled while busy/loading/invalid;
  Cancel returns to the list. On success show a status line "Saved · agents can see it now"
  or a warning when `registry.visible === false`.
- Delete: inline confirm within the row ("Delete <name>? This removes the file(s)."),
  Delete + Cancel; error is shown inline.
- Status/announcements: `role="status"`/`aria-live="polite"` for saved/refreshed/errors;
  `role="alert"` for failed actions and conflict banner; every input labelled; focus the
  first field when the editor opens; Escape cancels the editor.
- All visible strings go through the client dictionaries (`en` and `zh`), including aria
  labels, empty states, status/error messages. No hardcoded English in JSX.
- Styles: one `<style>` element injected once from `apply` via `ctx.effect`, classes
  prefixed `dsm-`, no global element selectors outside `.dsm-root`; must look correct in
  light and dark theme, keyboard focus visible, no layout shift on hover.
- Do not import external packages. Do not call the host through `ctx.remote`; plain fetch.
- Client must degrade cleanly: if `/state` fails, show a retry card with the error message
  (never a blank section). If `props.t` is absent, use the local `en` dictionary.

## Tests (api-dev, `node --test`)

Cover at minimum:
- config normalization defaults + rejection cases;
- root resolution incl. writable-root override, project roots with/without cwd, missing roots;
- frontmatter parse/serialize round-trip incl. quotes, booleans, whenToUse, empty body;
- scan: bundle + flat, invalid frontmatter entries reported, sha/size, library status
  installed/update/available/conflict;
- validate: field errors, target-exists, stale update, name-immutable, duplicate-name
  conflict across roots, force bypass limited to conflicts, overlap warning;
- mutate: create/update/delete round-trip on tmp dirs; atomic write leaves no temp file;
  stale update rejected; path traversal (`../`, absolute relPath, symlink target) rejected;
  install copies bundle + flat, update requires overwrite+sha, already-installed refused;
- api: route dispatch with fake req/res (or handler called with mock), JSON envelope,
  method/route/body errors, state payload shape, registry probe with a fake `ctx.skills`
  that eventually returns the new name (visible within timeout) and one that never does
  (visible:false after the deadline — keep the timeout injectable so tests are fast).

Tests must not touch `~/.agents` or the real profile; everything under `os.tmpdir()`.

## Definition of done

- `node --test` green (no deps installed), `node --check index.js client.js`.
- No writes outside the configured writable root; no secrets/log spam.
- UI renders from the real host state in a scratch DSH web instance and in the installed
  desktop profile; add/edit/delete/install round-trip verified through the UI.
- Deepseek-stack skills (29 bundles + 6 alias files) appear under Installed with correct
  names/roots, and library rows show Installed; a conflict attempt is blocked before save.
- Agents can find a newly added skill: `registry.visible === true` and the catalog count
  grows; the verifier records the evidence.

## Post-build deltas (implemented and independently verified)

These refine the sections above; the shipped behavior is authoritative and matches
`SKILLS-VERIFICATION.md`.

- `POST /validate` returns **HTTP 200** with `{ ok:false, valid:false, errors, conflicts,
  warnings }` for a well-formed but invalid draft. 4xx stays reserved for malformed requests
  (bad JSON, missing/wrong action, invalid cwd, oversized body). `/save`, `/delete`,
  `/install` keep 422/409/404/413 semantics.
- The registry probe is three-state: `{checked:true, visible:true}`, `{checked:true,
  visible:false}` after the poll deadline in an observable view, and `{checked:false,
  reason}` when the host-scope `ctx.skills.list()` cannot see the per-session providers that
  serve the scanned roots (the real desktop composition). Coverage is decided by the
  instruction-file `path` each listing entry publishes: it must be inside a scanned root;
  providers that publish no path fall back to a `filesystem`-provider name overlap.
  `state.catalog.coversLocalRoots` exposes the same decision.
- Plugin-provided catalog entries in `state.catalog.entries` are always shown in the client's
  "From plugins" group, even when `coversLocalRoots` is false; in that case one explanatory
  note is appended instead of hiding the entries.
- The description warning fires above **500** characters (code `description-truncated`,
  matching the agent catalog's render cap), not 300.
- A byte-identical copy of a library skill in a read-only root counts as `installed` for that
  library entry; a differing copy reports `conflict` with the shadowing explanation.
- The extra writable root created when `writableRoot` differs from `<agentsHome>/skills` uses
  `scope: "managed"` and the label "My skills".
