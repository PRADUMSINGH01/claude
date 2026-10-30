# Build agent plan (main pillar)

## What went wrong in the old builder (from the logs)

1. **The model did mechanical work:** creating the project, writing `index.html`, mounting blocks and theming, and it got it wrong (root on `<body>`, opaque grounds over the aurora, demo content left in).
2. **Open-ended tool loops:** 30–70 turns, each re-sending the whole history, so 0.4–2.7M tokens per film.
3. **Reading huge block files** (300–1,600 lines) in chunks, over and over, to find a colour.
4. **Fixing by trial and error:** failed edits, fake media files, and no notion of *which scene* owned an error.

## Principle: code builds the frame, the model writes only what needs writing

```
approved plan.json
   │
   ├─ 1. ASSEMBLE (code, 0 tokens)
   │     project · theme → :root vars + font files · install blocks/components
   │     index.html: hosts, timing, layers/z-order, data-variable-values, transparent grounds
   │     audio from plan (sfx resolved by code) · block scenes are DONE here
   │
   ├─ 2. WRITE SCENES (model, 1 call per scene, in parallel)
   │     only hand-built and component scenes
   │     input = scene packet → output = one complete scene file
   │
   ├─ 3. VERIFY PER SCENE (code first)
   │     lint + contract checks + `check --composition <id>`
   │     fail → repair call with ONLY that scene's findings + its file (max 2)
   │     still failing → code fallback scene (simple reveal) so the film always renders
   │
   ├─ 4. VERIFY THE FILM (code, measured)
   │     full check · background visible · no blank frames · text inside safe zone
   │     colours/fonts on theme · duration · every finding mapped to its owning scene
   │     → targeted repair of that scene only
   │
   ├─ 5. LOOK (optional, 1 vision call)
   │     contact sheet + plan → "scene X: change Y" → scene repair
   │
   └─ 6. RENDER + VERIFY (code)
```

## The scene packet: what the model sees for one scene, and nothing else

| Part | Content | ≈ size |
|---|---|---|
| Task | the plan's scene entry (id, time, copy, build, motion, variables) | 0.5k |
| Canvas | width, height, fps, the scene's duration and start, its layer | 0.1k |
| Theme | exact colour tokens and font families (CSS variable names) | 0.2k |
| Components | each one's comment block and markup/style/script, trimmed of demo content | 1–3k |
| Contract | `SKILL.md#contract` + `format.md#shape-of-a-project` (+ `motion-craft` only if the scene animates by hand) | 2–4k |
| Skeleton | a filled-in scene template (`<template>`, `#root`, timeline registered under the right id) | 0.5k |

**Output:** `{"file": "compositions/<id>.html", "html": "…"}`, a whole file with no edits and no tools.
Scene files are small (50–200 lines), so rewriting the whole file is cheaper and safer than patching.

## Why this should work

- **The bugs we hit become impossible by construction.** The root shape, layers, transparent grounds, theme variables and block variables are written by code from the plan.
- **No context growth:** every call is independent. A repair carries only the failing scene, never the history.
- **Every error has an owner:** `check --composition <id>` and the measured checks map each finding to a scene, so only that scene is fixed.
- **It always ends with a video:** a scene the model can't get right falls back to a simple code-written reveal, and is flagged in the report.

## Budget (3–5 scene film)

| Step | Calls | Tokens |
|---|---|---|
| Assemble, verify, render | 0 | 0 |
| Scene writing | 1–4 | ~5–8k each |
| Repairs | 0–3 | ~3–5k each |
| Look (optional) | 0–1 | ~8k |
| **Total** | **2–8** | **~20–60k**, plus a hard cap per job |

Old builder for comparison: 0.85–1.9M tokens per film.

## How we test it, step by step (cheap first)

1. **Assembler only, 0 tokens:** build the Lumen and P3 plans with code alone. Block scenes should already play; hand-built scenes are placeholders. Pass when `hyperframes check` is clean and the snapshots look right.
2. **Scene writer, one scene:** write GLM-P3's `per-word-rise` quote scene. Measure: passed check on the first try? tokens? looks right?
3. **One full build** of GLM-P3, then a real review with video, tokens and a score, like the plan reviews.

## Decisions for you

1. **Scene-writer model:** GLM planned better but is about 5× slower and uses more output tokens; Azure is fast. Suggestion: try both on test step 2 and compare.
2. **The "Look" step:** on by default (about 8k tokens per film, catches visual issues), or off.
3. **Fallback scenes:** always render with a flagged simple fallback, or stop and report.
