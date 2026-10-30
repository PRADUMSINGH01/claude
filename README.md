# Motion Studio

A multi-agent harness that turns a text prompt into a rendered video with
[HyperFrames](https://github.com/heygen-com/hyperframes) (HTML compositions rendered to MP4 by
seeking a paused GSAP timeline frame by frame), plus the HTTP API the web frontend talks to.

## Layout

| Path | What it is |
| --- | --- |
| `harness/` | The agent harness and the `motion` CLI (Node ≥ 22.13, pins `hyperframes` 0.8.211, calls every model through the OpenAI SDK). |
| `server/` | REST API (`index.mjs`): auth (password + Google OAuth), jobs, brand kits, assets. Runs `runJob` in-process. Its store is `server/data/db.json`, created at start and not committed. |
| `.agents/skills/` | The HyperFrames skills (`hyperframes`, `-cli`, `-registry`, `media-use`, …) installed from `heygen-com/hyperframes`, pinned in `skills-lock.json`. The agents read these as their docs. |
| `.claude/skills` | Symlink to `.agents/skills`, so Claude Code sessions in this repo load the same skills. |
| `docs/build-agent-plan.md` | Design of the token-lean build pipeline (`motion build`). |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Image with FFmpeg + HyperFrames' pinned Chrome; `harness`, `backend` and a TLS `caddy` service. |

## Pipelines

**`motion run` / the API — `harness/src/orchestrator.js`** (resumable stages in `jobs/<id>/harness/state.json`)

1. `init` — `hyperframes init` (code).
2. `planned` — **planner** agent → `SPEC.md`, `plan.json`, theme (registry blocks + one theme).
3. `installed` — `hyperframes add` for every block/component the plan names (code).
4. `built` — **builder** agent writes `index.html` and `compositions/*.html`.
5. `reviewed` — `check` + `snapshot` + measured layer checks → **critic** (vision) → **fixer**, `REVIEW_ROUNDS` times.
6. `rendered` / `done` — render (one fixer retry on failure), then verify the output.

**`motion plan` + `motion build` — `harness/src/plan.js`, `harness/src/build/`**

The cheaper split: plan in two short model calls (brief → code shortlist → plan → rating), then build
with code doing the mechanical work (project, theme tokens, fonts, block installs, root `index.html`)
and the model writing only hand-built scenes, one call each, verified per scene with
`check --composition`, repaired at most twice, else replaced by a code fallback. Hard token cap.

## How the agents use the HyperFrames docs

`harness/src/skills/access.js` gives each role a whitelist of skill files, a few preloaded sections
(e.g. the builder starts with `hyperframes/SKILL.md#contract`, `#keep-it-editable`,
`references/format.md#shape-of-a-project`) and mandatory sections it must read before writing.
Agents see only a map of file names and summaries and read the rest one section at a time within a
per-role character budget (`SKILL_READ_CHARS`, `*_SKILL_BUDGET`).

The contract the generated code must meet lives in `.agents/skills/hyperframes/SKILL.md`: every timed
element is a `.clip` with `data-start`/`data-duration`; each composition registers one paused timeline
in `window.__timelines[id]`; no wall-clock time, unseeded randomness, network or `repeat: -1`; scene
files wrap everything in `<template>` and style `#root`; asset paths are `assets/...`.

## Running

```bash
cp .env.example .env    # set PROVIDER and that provider's key
cd harness && npm ci
npm run selftest -- --quick          # no model calls, no CLI
npm run motion -- providers
npm run motion -- run "A 20 second launch film for ..." --theme coral
```

With Docker, see the comment at the top of `docker-compose.yml`.

When the skills in `.agents/skills` are updated, `.claude/skills` follows through the symlink.
