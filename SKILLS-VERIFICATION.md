# Skills verification — dsh-skills-studio end-to-end (independent)

Verified 2026-10-31 on **DSH 0.2.1-rc.5** by the independent verifier. Final verified plugin hashes
(`index.js`, `src/*`, `client.js`, tests) are in
[plugin-file-hashes.txt](verify/raw/plugin-file-hashes.txt); the late integration fix
(`src/api.js` sha256 `5960f4dc…`, `client.js` sha256 `aa185d3e…`) was delta-verified after the first evidence
capture and **every affected check below was re-run on those hashes**. All runs used scratch
`DSH_HOME=/tmp/dsm-verify-home` and a **copy** of `~/.agents`; the real home and the user's desktop
profile/app were only read. Evidence: [verify/](verify/).

| # | Area | Verdict | Evidence |
|---|---|---|---|
| 1 | Static checks, tests, dependency + path-safety review | **PASS** | `raw/static-check.txt`, `raw/node-test.txt`, `raw/static-review.txt`, `raw/plugin-file-hashes.txt` |
| 2 | Host HTTP API on a real scratch DSH instance | **PASS 61/61** | `raw/e2e-api-final.json` |
| 3 | GUI E2E — Settings → Skills | **PASS 28/28** | `raw/e2e-ui-final.json`, `screenshots/*.png` |
| 4 | Desktop delivery (live app, HMR, no restart) | **PASS** | `raw/desktop-live-state.json`, `raw/desktop-live-summary.json`, `raw/desktop-app-start.txt`, `raw/desktop-profile-install.txt` |
| 5 | Installed-skills invariant + alias catalog semantics | **PASS** | `raw/real-agents-invariant.txt`, `raw/audit-roots-final.json`, `raw/catalog-alias-semantics.json` |
| 6 | Managed root / read-only libs / host-scope probe (desktop-shaped) | **PASS 8/8** | `raw/e2e-managed-root-final.json` |
| 7 | Late-fix delta: path-based coverage + "From plugins" when coverage is false | **PASS 6/6 UI + probe** | `raw/e2e-ui-hostscope-final.json`, `raw/e2e-desktop-probe-shape-fixed.json` (pre-fix bug: `raw/e2e-desktop-probe-shape.json`) |

## 1. Static (PASS)

- `node --check index.js client.js src/*.js` → all pass (`raw/static-check.txt`).
- `node --test` at the repository root → **tests 105, pass 105, fail 0, skipped 0** (`raw/node-test.txt`).
- `package.json` declares **no dependencies / devDependencies**; host code imports Node builtins only,
  no `child_process`/`exec`/`spawn`/network calls; `client.js` requires only `react` and makes one
  same-origin `fetch` (`raw/static-review.txt`).
- Mutations live only in `src/mutate.js`: root containment (`assertContainedPath`), symlink rejection via
  `lstat`, `O_EXCL` temp sibling + `rename` atomic write, serialized mutation chain. Tests use
  `os.tmpdir()` only (`test/helpers.js:tempWorkspace`); no real-home reference in `test/`.

## 2. Host API E2E in a real scratch DSH web instance (PASS 61/61)

Booted with the linked plugin and overlay (paths shown resolved):
`DSH_HOME=/tmp/dsm-verify-home DSH_AGENTS_HOME=/private/tmp/.../agents dsh --profile web --patch /private/tmp/dsm-verify-home/overlay-b.yml --port 59699 --no-open`.
Evidence `raw/e2e-api-final.json` (status codes + JSON keys, no secrets).

- `GET /state`: 50 scanned skills (49 copied user + 1 read-only fixture), **35 ds entries = 29 bundles + 6 flat**,
  0 invalid; roots/writable flags correct; libraries `installed` 29 + 6; `catalog.available:true`,
  `catalog.coversLocalRoots:true` (synthetic global provider publishes instruction-file paths *inside*
  the scanned root); `cache-control:no-store`.
- `GET /skill` bundle/flat content + sha match state; missing → 404; `../` traversal → 404.
- `POST /validate`: well-formed drafts → HTTP 200 `{ok:false, valid:false, errors|conflicts}` (documented
  post-freeze change from CONTRACT's 422/409 wording); malformed → 400.
- `POST /save` create/update persist real files with expected content; stale sha → 422, file unchanged;
  no `.tmp-*` leftovers; follow-up state lists the skill; update keeps name locked.
- **Agents can find it**: save response `registry: {checked:true, visible:true, provider:"verify-managed",
  catalogCount:51, waitedMs:60}` with a later `GET /state` including the new name; delete → file/dir gone,
  `visible:false`, repeat → 404.
- **Conflict before save**: duplicate-name save → **409** `conflicts:[duplicate-name]`, **no file written**.
- Libraries: remove copied `ds-unslop`/`ds-plan` → `available` → install restores; already-installed → 409;
  tampered copy → `update`, update requires `overwrite:true` + correct `expectedSha256` then restores.
- Safety: `..`/absolute/NUL/unknown-library/unknown-root/traversal delete rejected; >1 MiB body → 413;
  405/404 route+method errors; symlink escape refused with target intact; read-only fixture roots
  byte-identical before/after; real `~/.agents/skills` mtime unchanged.

## 3. GUI E2E in the scratch GUI (PASS 28/28)

Real browser automation: `playwright-cli`'s daemon cannot launch a browser in this sandbox (EPERM on its
cache; Chrome sandbox init fails), so the harness uses the **same installed playwright-core package** with
system Chrome (headless, `--no-sandbox`) — real page, real network, JSON reports, screenshots.
Harness: [`e2e-ui.cjs`](verify/e2e-ui.cjs); evidence `raw/e2e-ui-final.json`.

- Settings → **Skills** section present (`navEntry:true`, eyebrow "Agent skills"); stats
  `50 installed / 36 available / 0 conflicts`; groups "USER (.AGENTS) 49 skills" + read-only fixture group.
- **Installed with the 35 deepseek-stack entries** (29 bundles + 6 aliases), Edit/Delete on writable rows,
  Read-only tag on the read-only row — [ui-installed-light.png](verify/screenshots/ui-installed-light.png).
- **Available**: deepseek-stack 29 rows `installed`, aliases 6/6, "From plugins" lists the provider-only
  skill — [ui-available-light.png](verify/screenshots/ui-available-light.png).
- **Add through the form**: first field focused, "Looks good.", success line
  `"Saved · agents can see it now."`, row + file on disk, count 50→51 — [ui-add-form-light.png](verify/screenshots/ui-add-form-light.png),
  [ui-added-light.png](verify/screenshots/ui-added-light.png).
- **Edit** (name locked, description persisted), **delete** with inline confirm
  `Delete "<name>"? This removes the file(s).` → row/file gone — [ui-delete-confirm-light.png](verify/screenshots/ui-delete-confirm-light.png).
- **Duplicate name blocked before save**: editor shows `Blocking conflicts / Duplicate name …`, Save
  disabled, `/save` request count unchanged (2 before = 2 after) — [ui-duplicate-blocked-light.png](verify/screenshots/ui-duplicate-blocked-light.png).
- **Library install**: remove `ds-unslop` + Refresh → Install → file restored, status flips to installed.
- **Accessibility**: every editor input has a real `<label for>`; live region `role=status aria-live=polite`
  ("Refreshed."); editor conflicts `role=alert`; tabs `role=tablist/tab`, ArrowRight switches tabs.
- **Dark theme** renders with host tokens — [ui-installed-dark.png](verify/screenshots/ui-installed-dark.png).
- 0 console errors / 0 page errors over the whole run; no 5xx API responses.

**Defect regressions re-run**: the two defects I reported are fixed and re-verified on final code:
(a) catalog loop precedence — "From plugins" shows `plugin-only` (`ui/from-plugins` PASS);
(b) dead tabpanel after delete — tabs/panel remain usable (`ui/delete-keeps-tabpanel` PASS, `rowsAfterDelete:50`).

**Late-fix delta (PASS 6/6)** — host-scope topology (catalog cannot cover scanned roots):
`raw/e2e-ui-hostscope-final.json` + [ui-available-hostscope-light.png](verify/screenshots/ui-available-hostscope-light.png):
`coversLocalRoots:false`, 1 catalog row rendered (`plugin-only`), the host-scope explanation note is shown,
and the Available stat includes the plugin entry (35 library + 1 catalog-only = 36). Nothing is silently hidden.

## 4. Desktop delivery (PASS; app never restarted or modified)

Read-only evidence from the **live user app** (`GET http://127.0.0.1:50910/skills-studio/api/…`):
49 skills (35 ds entries, all valid), libraries 29+6 installed, 0 conflicts, catalog available with
**30 entries** from providers `rev-eng-skills` + `dsh-office`, and **`catalog.coversLocalRoots:false`**
after the Lead HMR-reloaded the late fix (`raw/desktop-live-state.json`, `raw/desktop-live-summary.json`).
Profile state: symlink `node_modules/dsh-skills-studio → <plugin dir>` + `- insert: id: skills-studio`
row with the two libraries in `~/.dsh/profiles/desktop/cordis.patch.yml`
(`raw/desktop-profile-install.txt`).
**HMR/no restart, independently proven**: `libproc proc_pidinfo` gives app start `2026-10-30T16:13:54`;
plugin files were installed `2026-10-31T13:02:44`; the live endpoints and the post-fix state answer
afterwards → loaded into a ~21 h-old process without a restart (`raw/desktop-app-start.txt`).

Install steps the Lead ran (verifier did not re-run them): (1) link the package into the desktop profile
(`dsh plugin --profile desktop add link:<plugin dir>` equivalent — currently only the symlink exists),
(2) add the top-level `- insert:` row `id: skills-studio, name: 'dsh-skills-studio'` + `config.libraries`
to `~/.dsh/profiles/desktop/cordis.patch.yml`, (3) no restart needed — DSH profile HMR reloads the
composition and serves the client bundle; live check is a read-only `GET /skills-studio/api/health`.

**The earlier probe caveat is fixed and verified**, not just patched:
- `listingCoversLocalRoots` is now path-based (`src/api.js:165-184`): an entry covers the roots only when
  its published instruction-file `path` is inside a scanned root; providers without a path fall back to a
  filesystem-provider name overlap.
- Desktop-shaped proof: a global provider whose only entry overlaps by name but publishes a path outside
  the roots → `coversLocalRoots:false` and save returns
  `{checked:false, visible:false, waitedMs:0, reason:"… session-scoped skill providers …"}`
  (`raw/e2e-desktop-probe-shape-fixed.json`; pre-fix this shape returned `checked:true, visible:false`
  after 2001 ms — `raw/e2e-desktop-probe-shape.json`). The UI now shows the neutral "Saved · the host
  cannot observe the session catalog from here…" message instead of "Saved, but agents cannot see it yet."
- Synthetic global provider that *does* serve the same root still returns `checked:true, visible:true` (§2).
- Remaining caveat (**LOW**): the live profile's `package.json` does not declare `dsh-skills-studio` as a
  dependency/bundle; the working install is the `node_modules` symlink + patch row. A later
  `dsh plugin --profile desktop …` / pnpm install could prune the symlink — declare the link dependency
  when convenient.

## 5. Installed-skills invariant + alias semantics (PASS, unchanged)

`raw/real-agents-invariant.txt`: `~/.agents/skills` still has **49 entries = 29 ds bundles + 6 ds flat aliases
+ 14 community bundles**; manifest and lock sha256 unchanged from the audit baseline; skills-dir mtime
unchanged (1793446272). Independent re-audit (`raw/audit-roots-final.json`, shipped `yaml@2.9.1` parser):
49 valid, 0 invalid, 0 duplicate names, 0 alias collisions, 0 name/basename mismatches, source drift 29/29 + 6/6.
Live model catalog from this desktop session (`raw/catalog-alias-semantics.json`, 71 entries): all 43
model-invocable user skills served; **0 of the 6 aliases appear** (`ds-audit ds-best ds-context ds-plan
ds-review ds-verify` are exactly the missing names). Aliases carry `disable-model-invocation: true` and are
user-invocable (`user-invocable` omitted), so they stay in the `/` menu with the shipped "user-only" marker
(`dsh-client-ui-skill/lib/client.js:430`) and are excluded from model catalogs/loaders
(`dsh-tool-skill/README.md:90,228`).

## 6. Honest limits

- Desktop behaviour was observed read-only (live GETs + file reads). I did **not** write a skill into the
  real `~/.agents`, and did not restart or drive the user's desktop GUI; the desktop save-probe outcome is
  established from the live `coversLocalRoots:false` state plus the reproduced Boot C/D shapes.
- A late integration fix landed after the first evidence capture; the report reflects a full re-run of
  static checks, API 61/61, UI 28/28, Boot C 8/8 and the new host-scope UI 6/6 on the final hashes.
- `playwright-cli` itself cannot launch in this sandbox; all UI evidence comes from playwright-core +
  system Chrome. Dark theme was forced with `emulateMedia` (the app's own theme setting was left untouched).
- CONTRACT deviations observed and accepted: `/validate` returns 200 + `{ok:false,…}` for well-formed invalid
  drafts (4xx only for malformed requests); the registry probe reports the 3-state result; library status
  treats byte-identical read-only copies as `installed`.
- Not exercised: concurrent mutations across processes, Windows/PowerShell paths, zh locale rendering,
  real desktop UI screenshots (user app not interacted with), and post-restart desktop durability.

## Reproduce (key commands)

```bash
# static
node --check index.js client.js src/*.js && node --test
# scratch instance (fresh DSH_HOME + copied agents home; overlay under /private/tmp/dsm-verify-home)
DSH_HOME=/tmp/dsm-verify-home DSH_AGENTS_HOME=/private/tmp/dsm-verify-home/agents \
  dsh --profile web --patch /private/tmp/dsm-verify-home/overlay-b.yml --port <free> --no-open
# API (61 assertions)
node verify/e2e-api.mjs --base http://127.0.0.1:<port> --agents /private/tmp/dsm-verify-home/agents \
  --writable /private/tmp/dsm-verify-home/agents/skills --readonly-root /private/tmp/dsm-verify-home/readonly-skills \
  --ds-skills ../ds-stack/skills --ds-aliases ../ds-stack/aliases \
  --out verify/raw/e2e-api-final.json --registry-expect positive
# UI (28 assertions + screenshots)
node verify/e2e-ui.cjs --url "http://127.0.0.1:<port>/?token=<token>" \
  --writable /private/tmp/dsm-verify-home/agents/skills --screenshots verify/screenshots \
  --out verify/raw/e2e-ui-final.json
# Boot C (overlay-c.yml): managed root / read-only libs / host-scope probe (8 assertions)
node verify/e2e-managed-root.mjs --base http://127.0.0.1:<port> \
  --writable /private/tmp/dsm-verify-home/managed-skills --readonly /private/tmp/dsm-verify-home/readonly-skills \
  --user-root /private/tmp/dsm-verify-home/agents/skills --out verify/raw/e2e-managed-root-final.json
# Boot C UI delta: catalog rows + host-scope note when coverage is false (6 assertions)
node verify/e2e-ui-hostscope.cjs --url "http://127.0.0.1:<port>/?token=<token>" \
  --screenshots verify/screenshots --out verify/raw/e2e-ui-hostscope-final.json
# installed-skills invariant + alias semantics
node verify/audit-roots.mjs --agents-home "$HOME/.agents" --dsh-home "$HOME/.dsh" --project "$PWD" \
  --deepseek-stack "$PWD/ds-stack" --pretty > verify/raw/audit-roots-final.json
python3 verify/extract-catalog.py "$HOME/.dsh/sessions/.../session.v4.jsonl.zstd" verify/raw/catalog-desktop-session.txt
# read-only desktop live check
curl -s "http://127.0.0.1:50910/skills-studio/api/state" > verify/raw/desktop-live-state.json
```

Evidence map: `verify/raw/` (all JSON/text above) · `verify/screenshots/` (9 PNGs: light, dark, add form,
saved, duplicate-blocked, delete-confirm, installed, available, host-scope Available) · harnesses:
[`e2e-api.mjs`](verify/e2e-api.mjs), [`e2e-ui.cjs`](verify/e2e-ui.cjs),
[`e2e-managed-root.mjs`](verify/e2e-managed-root.mjs),
[`e2e-ui-hostscope.cjs`](verify/e2e-ui-hostscope.cjs),
[`audit-roots.mjs`](verify/audit-roots.mjs), [`extract-catalog.py`](verify/extract-catalog.py).

## Lead addendum — live desktop GUI evidence (2026-10-31T13:06, later than §4)

The verifier observed the running desktop app only through its read-only HTTP API. The Lead also
captured the real app window after the HMR install, proving the Settings page itself renders:

- `verify/screenshots/desktop-live-skills.png` (sha256 `30363b37…`, kept on
  disk but **excluded from git** via `.gitignore` because it shows the user's
  other running sessions) — the user's running DSH 0.2.1-rc.5 window at 3840×2486 with **Settings →
  Skills** open: nav shows Account/General/Models/Built-in plugins/Agent presets/Cost/**Skills**;
  page shows **49 installed / 64 available / 0 conflicts**, the `USER (.AGENTS)` group with
  `accessibility`, `code-review`, `computer-use`, `ds-adopt`, `ds-audit`, … and per-row
  **Edit / Delete** (writable user root). The app process was not restarted (start 2026-10-30
  16:13:54; install 2026-10-31 13:02:44 per `raw/desktop-app-start.txt`).
- The Available counter shown in that frame (64) predates the late-fix client reload; after the
  reload the live desktop host serves 30 plugin catalog entries with `coversLocalRoots:false`
  (`raw/desktop-live-state.json`), and the same UI now renders those entries inside "From plugins"
  together with the host-scope note (verified in the scratch host-scope UI run,
  `raw/e2e-ui-hostscope-final.json` and `screenshots/ui-available-hostscope-light.png`).

Final plugin hashes at hand-off match `raw/plugin-file-hashes.txt`
(`src/api.js` `5960f4dc…`, `client.js` `aa185d3e…`); `node --test` 105/105 re-run by the Lead after
the late fix. No scratch instances or background jobs remained after verification.
