## Why

We want to build a sidebar advisor that recommends optimal Agricola moves on Board Game Arena. The hardest unknown is how BGA actually represents Agricola's game state and turn flow — the advisor cannot be designed well without that ground truth, and guessing it would mean rework. Before writing any AI or strategy code, we need a read-only "observatory" that captures the real telemetry from live games. This de-risks the entire project and produces the exact corpus the future advisor (and the later learn-from-losses loop) will be built on.

## What Changes

- New repository scaffold: a Manifest V3 Chrome/Arc extension built with TypeScript + esbuild, loadable unpacked, active only on `boardgamearena.com` Agricola tables.
- A MAIN-world probe that reads `window.gameui.gamedatas` and subscribes to BGA's notification bus, relaying events to an isolated content script.
- Full telemetry capture: a `gamedatas` snapshot keyed to every notification, every notification (name, payload, gamestate, active player, timestamps), every gamestate transition (the "it's my turn / here are my options" signal), the user's hand/farm/resources, the action board, optional screenshots, session metadata, and end-of-game scoring.
- Session log persisted to `chrome.storage.local` (survives reload) with one-click JSON export.
- An in-page sidebar showing a live event feed, a tri-state health indicator, explicit probe attach/detach status, and capture controls (start/stop, screenshot toggle, export, clear).
- Graceful degradation with no configuration required: full capture when possible, automatic fallback to timer/DOM snapshots or screenshot-only, never failing silently mid-game.

## Non-goals

This change is observe-only. Explicitly **out of scope**:

- **No AI / no OpenRouter** — no model calls, no API keys, no inference of any kind.
- **No advice or recommendations** — the sidebar reports captured state only; it does not suggest moves.
- **No in-game actions or automation** — the extension never clicks, plays, or alters the game. It only observes (preserving the spirit of unranked play).
- **No learn-from-losses loop** — post-game analysis and strategy memory are a separate future change.

The advisor and learning loop are deliberately deferred to their own OpenSpec changes once this telemetry foundation is validated.

## Capabilities

### New Capabilities

- `bga-telemetry-capture`: Injecting the MAIN-world probe into BGA Agricola tables, reading `gamedatas`, hooking the notification bus, the captured session-log schema, persistence to `chrome.storage.local`, optional screenshots, and JSON export — including the graceful-degradation fallback capture paths.
- `observatory-sidebar`: The in-page sidebar UI — live event feed, tri-state health indicator, explicit probe attach/detach status, and capture controls (start/stop, screenshot toggle, export, clear).

### Modified Capabilities

None — this is a greenfield project; `openspec/specs/` is empty.

## Impact

- **New code**: repo scaffold (`package.json`, `tsconfig.json`, esbuild config, `manifest.json`, `src/` — service worker, MAIN-world probe, isolated content script, sidebar).
- **Dependencies**: dev-only — `typescript`, `esbuild`, `@types/chrome`. No runtime dependencies, no network calls.
- **Browser permissions**: `scripting` (register MAIN-world content script), `storage` + `unlimitedStorage` (session log), `activeTab`/`tabs` (`captureVisibleTab`), host permission for `boardgamearena.com`.
- **Existing systems**: none affected (greenfield).
- **Risk**: BGA's `gamedatas` shape and notification names are not yet confirmed — capturing them is precisely this change's purpose, and the fallback paths ensure a usable log even if the richest capture path fails.
