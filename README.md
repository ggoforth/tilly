# Agricola Observatory (BGA)

A locally-installed Chrome/Arc extension that **records** what happens in your
Agricola games on Board Game Arena — full game state, the notification stream,
every turn, your cards and farm — and lets you export it as JSON.

**Why it exists:** it's the recon step before an AI advisor. We don't yet know
exactly how BGA represents Agricola's state, and guessing wrong would mean
rework. This tool captures the real schema from live games so the advisor can be
built on facts. It is intentionally **observe-only**: no AI, no advice, no
clicking or automation — it never touches the game (so unranked play stays
clean). Full design: `openspec/changes/add-bga-agricola-observatory/`.

## Build

```bash
npm install
npm run build      # → dist/   (npm run watch to rebuild on change)
```

## Load in Arc (unpacked)

1. Open `arc://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select the `dist/` folder.
4. Open a Board Game Arena **Agricola** table and play normally.

A dark **Agricola Observatory** panel appears on the right of the table.

> **Important:** the probe is registered when the extension loads, so **reload
> the BGA game tab** after first installing (or after hitting **Reload** on the
> extension card following a `npm run build`). An already-open table won't have
> the probe until you reload it — the panel will show "probe: NOT attached".

## Using it during a game

- The panel shows a live event feed, a health pill, and probe status. **Your
  turn** is highlighted green in the feed.
- **Pause/Resume** — stop/start recording. **Export JSON** — download the full
  session log. **Clear** — wipe the stored log for this table.
- **Screenshots: off by default** (they bloat the log). Toggle on to also grab
  the screen at key moments (your turn, round, harvest, game end).
- The log auto-saves to local extension storage and survives a page reload, so a
  crash mid-game doesn't lose the night.

**Export when the game ends** (or whenever) and keep the JSON — that's the
corpus the advisor gets built from.

## Advisor (v2)

The panel is **docked beside the table and always open** (it reserves a gutter
so it never covers the board). It advises — it never plays for you.

1. Open the extension's **Options** page (right-click the extension → *Options*,
   or `arc://extensions` → *Details* → *Extension options*).
2. Paste **your own OpenRouter API key** and a model id, e.g.
   `anthropic/claude-sonnet-4.6` (default is `google/gemini-2.5-flash`). Save.
3. Play. On **your turn** it automatically reads the position and streams a
   recommended move + why into the panel. Ask follow-ups in the **chat** box
   ("why not X?") — answers are grounded in the current position.

Your key is stored locally, used only for `openrouter.ai`, never injected into
the game page, and never written to the exported log. No key → the advisor is
cleanly disabled and the observatory still captures normally. Every
recommendation and the move you actually made are logged for later evaluation.

## Health states (what the pill means)

| State | Meaning |
|---|---|
| **healthy** | Full capture: state snapshots + the notification stream. |
| **degraded** | Notifications couldn't be hooked; capturing state snapshots on a timer/DOM changes instead. Still useful. |
| **unhealthy** | `gameui` not found. Best-effort only. If you see this on an Agricola table, note it — it tells us a hook needs adjusting. |

It runs with zero configuration and never fails silently — every fallback is a
visible health change in the feed.

## Status

v1 (observatory) and v2 (advisor + chat) are implemented. The learn-from-losses
loop and observatory log-slimming are deliberately separate, later OpenSpec
changes (`openspec/changes/`).

## Install a released build

If you'd rather not build from source, releases ship a prebuilt zip:

1. Go to [Releases](https://github.com/ggoforth/tilly/releases) and download
   the latest `tilly-X.Y.Z.zip`.
2. Extract it anywhere.
3. Follow the **Load in Arc (unpacked)** steps above, pointing at the
   extracted folder instead of `dist/`.

## Cutting a release

Releases are tag-driven via `.github/workflows/release.yml`:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The workflow runs `npm run check` (typecheck + unit tests + build) against
the tagged commit, packages `dist/` as `tilly-0.2.0.zip`, and attaches it
to a fresh GitHub Release. CI sets `RELEASE_VERSION` so the manifest
version matches the git tag exactly — no `.N` dev-counter suffix on
released builds.

## Proof / verification

The shared gate — both locally and in CI — is **`npm run check`**: strict
typecheck + unit tests + build. The pure state distiller is unit-tested
against real captured snapshots in `test/fixtures/`. The release workflow
runs the same gate against every tagged commit before publishing, so a
green release is also a tested release.

LLM advice quality and live OpenRouter/BGA integration are **not**
automatable — they are verified manually in a real game, and every
recommendation is logged against the move actually taken so quality is
measurable over time. This gap is intentional and acknowledged, not
hidden.
