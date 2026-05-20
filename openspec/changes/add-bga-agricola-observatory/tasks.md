## 1. Project scaffold

- [x] 1.1 Initialize repo: `package.json`, `tsconfig.json` (strict), `.gitignore`, conventional-commit setup
- [x] 1.2 Add dev deps: `typescript`, `esbuild`, `@types/chrome`; add `build` and `watch` npm scripts
- [x] 1.3 Create `src/` layout (`probe/`, `content/`, `worker/`, `sidebar/`, `shared/`) and an esbuild config that bundles each entrypoint to `dist/`
- [x] 1.4 Author `manifest.json` (MV3): permissions `scripting`, `storage`, `unlimitedStorage`, `activeTab`/`tabs`; host permission `*://*.boardgamearena.com/*`; service worker; isolated content script
- [ ] 1.5 Verify the empty extension loads unpacked in Arc with no console errors (load-unpacked smoke test) — *requires loading in Arc (tonight)*

## 2. Shared types and session-log buffer

- [x] 2.1 Define the `SessionLog` and `Event` discriminated-union types from design.md in `src/shared/`
- [x] 2.2 Define a storage interface and implement it over `chrome.storage.local` with periodic flush
- [x] 2.3 Implement session-log buffer: append events in order, restore in-progress log after reload
- [x] 2.4 Implement export (download full `SessionLog` JSON) and clear (reset stored log)

## 3. MAIN-world probe

- [x] 3.1 Register the MAIN-world script via `chrome.scripting.registerContentScripts` scoped to Agricola tables only
- [x] 3.2 Poll for `window.gameui` with backoff; emit explicit attached / not-attached status; re-attach on SPA navigation between tables
- [x] 3.3 Safe deep-clone of `gameui.gamedatas` (`structuredClone` + JSON-replacer fallback); clone failure → health event, no crash
- [x] 3.4 Hook both notification mechanisms (`dojo.subscribe` legacy and `bga.notifications` modern); record delivering `channel`
- [x] 3.5 Capture gamestate transitions incl. active player + `possibleActions`/args; compute `isMyTurn`
- [x] 3.6 Relay all probe output to the isolated content script via `window.postMessage` with an origin/namespace guard

## 4. Capture pipeline (isolated content script)

- [x] 4.1 Receive relayed messages; build `snapshot`, `notification`, `gamestate` events; pair each notification to a snapshot via `linkedSnapshotId`
- [x] 4.2 Capture initial snapshot on attach and table metadata (table id, players, local player id, variant if detectable)
- [x] 4.3 Persist events through the buffer; capture end-of-game data when reachable
- [x] 4.4 Assert observe-only: no network calls with game data, no input dispatched to the game (guard + code review checklist)

## 5. Screenshot capture (optional)

- [x] 5.1 Service-worker handler for `chrome.tabs.captureVisibleTab`; off by default behind a toggle
- [x] 5.2 Trigger only at key moments (my-turn, round, harvest, game-end); store screenshots separately and emit `screenshot-ref` events

## 6. Sidebar UI

- [x] 6.1 Mount a collapsible Shadow-DOM panel on Agricola tables without disturbing BGA layout/controls
- [x] 6.2 Live event feed (timestamp, kind, summary) with my-turn rows visibly emphasized
- [x] 6.3 Tri-state health indicator + explicit probe attached/not-attached indicator with human-readable reason
- [x] 6.4 Controls: start/stop capture, screenshot toggle, export JSON, clear
- [x] 6.5 Confirm the sidebar renders captured data only — no recommendations or AI content

## 7. Graceful degradation

- [x] 7.1 Implement the health state machine: `healthy` → `degraded` → `unhealthy`, every transition logged as a health event and surfaced in the sidebar
- [x] 7.2 `degraded` path: timer-interval + `MutationObserver`-triggered snapshots when notifications are unavailable
- [ ] 7.3 `unhealthy` path: screenshot-on-heuristic + best-effort DOM scrape when `gameui` is unavailable; still produces an exportable log — *KNOWN GAP: healthy/degraded implemented; unhealthy currently reports state but does not yet run an independent screenshot+DOM-scrape capture loop*
- [x] 7.4 Verify zero-config startup and that no failure path is silent

## 8. Verification

- [ ] 8.1 `npm run build` is clean (strict TS, no errors); extension loads unpacked in Arc with no console errors — *build+typecheck verified clean; Arc load pending (tonight)*
- [ ] 8.2 End-to-end: capture a real or replayed BGA Agricola game, then export the JSON — *tonight*
- [ ] 8.3 Validate the exported log reconstructs: full notification timeline, every `isMyTurn` decision point with its options, and the user's hand/farm/resources at each (snapshot pairing intact) — *tonight, from 8.2's export*
- [ ] 8.4 Confirm observe-only in practice: no outbound network with game data, game proceeds identically with the extension active — *tonight*
- [x] 8.5 `openspec validate add-bga-agricola-observatory --strict` passes
