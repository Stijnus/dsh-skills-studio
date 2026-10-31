# Skills audit — installed roots, deepseek-stack integrity, DSH registry truth
Audited 2026-10-31 on **DSH 0.2.1-rc.5** (desktop profile, GUI `127.0.0.1:50910`); read-only for `~/.agents/skills`.
Facts were re-derived by [`audit-roots.mjs`](verify/audit-roots.mjs) →
[audit-roots.json](verify/raw/audit-roots.json), parsing frontmatter with the same `yaml@2.9.1`
the shipped provider uses (subset fallback without `--yaml-module`).

## 1. Inventory (4 contract roots scanned)
| rank | root | exists | entries | bundles | flat | valid | invalid | model-invocable | gesture-only |
|---|---|---|---|---|---|---|---|---|---|
| 100 | `<project>/.dsh/skills` | no | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 200 | `<project>/.agents/skills` | no | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 400 | `~/.dsh/skills` | yes (empty) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 500 | `~/.agents/skills` | yes | **49** | 43 | 6 | **49** | **0** | 43 | 6 |

Project root = the workspace (`.../default-workspace`); the workspace root itself is **not** a scanned root (only
`<project>/.dsh/skills` / `<project>/.agents/skills`, both absent). `~/.agents/skills` = **29 `ds-*` bundles + 6
`ds-*` flat aliases** (deepseek-stack = 35) + **14 community bundles** (accessibility, code-review, computer-use,
find-skills, orca-cli, orchestration, playwright-best-practices, playwright-cli, reverse-engineer-anything, supabase,
supabase-postgres-best-practices, vercel-react-best-practices, vibe-to-ui, web-design-guidelines; 278,520 bytes).

| contract check | result |
|---|---|
| name present + kebab-case `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`; description non-empty | 49/49 |
| name == directory basename / flat filename | 49/49 (DSH serves the frontmatter name — `skill-filesystem/lib/index.js:684-700` — filename-keyed tooling assumes equality) |
| invocation booleans valid (strict YAML forms) | 49/49; 6 `disable-model-invocation: true`, 43 omitted (model+user); 0 `user-invocable: false`; 0 legacy keys; 0 `whenToUse` |
| unknown (ignored) keys; descriptions > cap 500; empty body; body without H1 | `license`×4, `allowed-tools`×1; 7 (see §5); 0; 1 (code-review, cosmetic) |
| size range; duplicates across roots; same-root duplicates; flat-vs-bundle alias collisions | 267 B … 55,055 B; 0; 0; 0 |

## 2. The pack's own tooling vs the independent re-derivation
```text
$ node ds-stack/tools/validate.mjs ~/.agents/skills          # exit 1
49 skills | 11 FAIL | 3 WARN | catalog 8815 chars (~2449 tokens per session) | 6 gesture-only (0 catalog cost)
$ node ds-stack/tools/validate.mjs ds-stack/skills --upstream ds-stack/upstream/deepseek-stack/skills \
    --aliases ds-stack/aliases --expect-aliases 6   # exit 0 · 35 skills | 0 FAIL | 0 WARN
$ node ds-stack/tools/conflicts.mjs --json                    # exit 0
counts {entries:49, ours:35, theirs:14}; nameCollisions []; aliasCollisions []; pairs 5
$ node audit-roots.mjs …   # exit 0 · high:0 medium:8 low:1 info:2 · 49 entries, valid 49, invalid 0,
                           # duplicates 0, alias collisions 0, name/basename mismatches 0
```

The 11 FAILs: **8 false positives** — validate.mjs' hand-rolled YAML parser rejects indented `metadata:` blocks
(accessibility, playwright-best-practices, reverse-engineer-anything, supabase, supabase-postgres-best-practices,
vercel-react-best-practices, vibe-to-ui, web-design-guidelines), while the provider parses them with `yaml@2.9.1`
(`skill-filesystem/lib/index.js:7,784`) and **all 8 appear in this session's live model catalog** (proof:
[catalog-model-71.txt](verify/raw/catalog-model-71.txt)); **3 genuine** over-cap descriptions
(computer-use 548, orca-cli 782, orchestration 813 > 500). WARNs: code-review (419 chars, no H1), find-skills
(303), playwright-cli (77, `allowed-tools`). Pack source validates clean, so this is tool scope, not a bad install.
Conflict overlap pairs (0.185 ds-design-audit~web-design-guidelines, 0.172 ~accessibility, 0.158
ds-audit~web-design-guidelines, 0.143 ds-audit~accessibility, 0.136 ds-review~web-design-guidelines) are
description-similarity warnings, not name conflicts.

## 3. Registry truth — what DSH actually serves, and why
- **Roots/priority**: ranks `project-dsh` 100 → `project-agents` 200 → custom 300 → `user-dsh` 400 →
  `user-agents` 500, bundled 600 (`dsh-skill-filesystem/README.md:49-55`); `agentsHome` defaults to `~/.agents`
  (`dsh-home-paths/README.md:49`). Only rank 500 exists here; the desktop patch configures no
  `agentsHome`/`customSkillDirs`/`bundledSkillDir`.
- **Layer**: the web profile disables the host `skill-filesystem`/`tool-skill` rows and each agent preset mounts
  its own (`dsh-web-app/cordis.patch.yml:510-523`, `presets/standard.patch.yml:38-41`), so local roots live in the
  *preset layer*; deployment plugins (`dsh-rev-eng`) live in the *global layer*. Within a layer duplicates resolve
  ascending rank → provider order → local order, first wins (`dsh-skill/lib/index.js:315-327,520`); across layers
  the nearest layer wins outright (`dsh-skill/README.md:85`, limitation `:141`).
- **Live catalog (from this session's persisted log)**: **71 entries** = 43/43 user-root model-invocable skills +
  22 `dsh-rev-eng` provider skills + 7 office plugin skills − 1 cross-provider duplicate. 0 of the 43 missing,
  0 of the 6 aliases leaked, rendered description lengths match the audit 43/43
  ([catalog-crosscheck.json](verify/raw/catalog-crosscheck.json)). Observed duplicate:
  `reverse-engineer-anything` is in `~/.agents` (403-char description) and in the `dsh-rev-eng` plugin (422 chars);
  the catalog renders the **user-root copy** — the preset layer beats the global plugin regardless of its rank 400.
- **Invocation & rendering**: `disable-model-invocation: true` hides a skill from the model catalog but not from
  human commands; the `/name` gesture is its only load path (`dsh-tool-skill/README.md:90,228`) and the `/` menu
  renders every user-invocable skill, prefixing "user-only ·" for model-hidden ones
  (`dsh-client-ui-skill/lib/client.js:430`). All 49 entries are user-invocable; the 6 aliases cost 0 catalog tokens.
  Descriptions are whitespace-collapsed, trimmed, capped at 500 as `slice(0,497)+"..."` (`dsh-tool-skill/lib/index.js:1089-1090`);
  the 7 over-cap skills render exactly 500 chars.
- **Visibility without restart**: existing roots are watched (Chokidar, depth 1); add/rename/delete/frontmatter edits
  invalidate the provider, so the next model step receives a replacement catalog; DSH `write`/`edit` invalidate
  synchronously; absent roots are probed; bundle-substructure edits are ignored
  (`dsh-skill-filesystem/README.md:82,114`). Bodies are re-read on every load. **Failure mode**: an invalid
  frontmatter/name/invocation value drops the skill with a warning, so the model cannot tell absent from broken
  (`README.md:86`, limitation `:148`).
- **Catalog rendering**: description whitespace-collapsed, trimmed, capped at 500 as `slice(0,497)+"..."`
  (`dsh-tool-skill/lib/index.js:1089-1090`); the 7 over-cap skills render exactly 500 chars.

## 4. deepseek-stack integrity (installed ↔ pack source ↔ manifest)
| check | result |
|---|---|
| 29 installed `ds-*/SKILL.md` sha256 vs `ds-stack/skills/*/SKILL.md` | 29/29 identical, **0 drift** |
| 6 installed `ds-*.md` sha256 vs `ds-stack/aliases/*.md` | 6/6 identical, **0 drift** |
| manifest (29 skills + 6 aliases) sha256 vs disk; descriptionChars; missing/extra | 29/29 + 6/6 match; 29/29 match; 0/0 |
| manifest identity | version 2, target `~/.agents/skills`, upstream `aicodeking/deepseek-stack@d4f1ebe72e83…` |
| 6 gesture aliases | all `disable-model-invocation: true`, all point at installed `ds-*` targets; excluded from model catalog, present in `/` menu |
| community skills vs `.skill-lock.json` | lock has 12 entries; **reverse-engineer-anything, vibe-to-ui untracked** |

## 5. Gaps / risks (0 hard conflicts, 0 invalid skills, 0 drift — nothing blocks agents today)
| sev | gap | evidence → action |
|---|---|---|
| MED | 7 community descriptions exceed the 500-char catalog cap; trigger text is truncated (computer-use loses `"control/click/read in a desktop app"…`; orca-cli/orchestration lose "Prefer this over raw `git worktree`…"; supabase\* lose error/RLS triggers; vibe-to-ui loses Git-sync trigger) | live catalog vs raw frontmatter → trim to ≤500 |
| MED | pack `validate.mjs` reports 8 valid community skills as FAIL on an installed root (its YAML parser, not DSH) | §2 → scope tool to `ds-stack/skills` or use real YAML |
| MED | `reverse-engineer-anything` served from the stale user-root copy, shadowing the plugin copy; plugin updates never reach agents while both exist | catalog description match (403 vs 422 chars), differing sha256 → delete user copy or accept pinning |
| LOW | single-root dependency: all 49 skills only in `~/.agents/skills`; `~/.dsh/skills` empty; no project roots; invalid files disappear silently | §1/§3 → keep a backup; malformed edits are invisible to the model |
| LOW | `.skill-lock.json` drift: 2 of 14 community skills untracked → `skills` CLI update/remove cannot manage them | §4 → re-register or ignore |
| INFO | `license`/`allowed-tools` ignored by DSH; code-review body has no H1; user-root catalog cost ≈ 11,298 chars ≈ 3,138 tokens/session (name+description+6, pack formula, aliases 0) | no functional effect |

## 6. Reproduce
```bash
# this repository checkout provides the audit scripts + evidence paths
PLUGIN="$PWD"
cd <workspace checkout used at the time>
(cd .dsh-recon && node asar.mjs extract 'dsh/node_modules/yaml' /tmp/dsm-audit/yaml-pkg)  # entry is 1 byte short:
printf '}' >> /tmp/dsm-audit/yaml-pkg/dsh/node_modules/yaml/package.json
node "$PLUGIN/verify/audit-roots.mjs" --agents-home "$HOME/.agents" --dsh-home "$HOME/.dsh" \
  --project "$PWD" --deepseek-stack "$PWD/ds-stack" --pretty \
  --yaml-module /tmp/dsm-audit/yaml-pkg/dsh/node_modules/yaml/dist/index.js \
  > "$PLUGIN/verify/raw/audit-roots.json"
node ds-stack/tools/validate.mjs ~/.agents/skills && node ds-stack/tools/conflicts.mjs --json
python3 "$PLUGIN/verify/extract-catalog.py" "$HOME/.dsh/sessions/<session>/session.v4.jsonl.zstd" \
  "$PLUGIN/verify/raw/catalog-model-71.txt"
```
Evidence: [`audit-roots.mjs`](verify/audit-roots.mjs) · [`extract-catalog.py`](verify/extract-catalog.py) ·
[`raw/`](verify/raw/): `audit-roots.json`, `validate-{installed,source}.txt`, `conflicts-{installed,source}.json`,
`catalog-model-71.txt`, `catalog-crosscheck.json`.
