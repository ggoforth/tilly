## 1. Proof infrastructure

- [x] 1.1 Add a `node:test` runner (no new deps); `test/` dir; `npm run test` and `npm run check` (typecheck + test + build) scripts
- [x] 1.2 Extract real snapshot fixtures from `observed-games/` into `test/fixtures/`: a user decision-point snapshot, a draft-phase snapshot, one with named opponents, and a malformed/partial one (small, committed)
- [x] 1.3 Document the no-git/no-CI gap in README and that `npm run check` is the local gate (advice quality + live integration are manually verified, not CI-proven)

## 2. Shared types

- [x] 2.1 Define `PositionBriefing` and its sub-types (PlayerView, CardView, ActionSpace) from design.md in `src/shared/`
- [x] 2.2 Add the `recommendation` event kind to the session-log union; bump `SCHEMA_VERSION`; confirm existing event kinds unchanged
- [x] 2.3 Define advice/chat request + streamed-response message types (content ↔ worker)

## 3. State distiller (pure) + tests

- [x] 3.1 Implement `src/advisor/distiller.ts`: pure `gamedatas` snapshot → `PositionBriefing` (resources, animals, farm, family, hand+played with rules text, opponents, action board, legalActions, available major improvements board, draft pool; card `cost`/`prerequisite` when present)
- [x] 3.2 Strip opponent handles → positional labels; ensure no handle leaks anywhere in the briefing
- [x] 3.3 Return a typed cannot-distill result on malformed input; never throw
- [x] 3.4 Unit tests (node:test) covering every `state-distiller` spec scenario against the real fixtures: purity/determinism, real decision-point snapshot, hand rules text, legal actions, available major improvements, draft pool (draft-phase fixture), opponent stripping, malformed non-fatal

## 4. Options page (user-supplied key)

- [x] 4.1 Options page UI: OpenRouter API key field + model picker; save to `chrome.storage.local`
- [x] 4.2 Manifest: register `options_page`; add `https://openrouter.ai/*` host permission
- [x] 4.3 Helper to read key/model config; treat absent key as "advisor disabled" (no throw)

## 5. Service-worker OpenRouter client

- [x] 5.1 `src/advisor/openrouter.ts` (worker): POST to OpenRouter chat completions with the user's key + model; stream tokens back to the content script
- [x] 5.2 Static strategy preamble with prompt caching; build the advice prompt from `PositionBriefing` only (never raw gamedatas)
- [x] 5.3 Abort/cancel support; error, timeout, and rate-limit handling that returns a structured error (never throws into the page)
- [x] 5.4 Guarantee the key is never posted to the page and never written to the session log/export

## 6. Content wiring (auto-on-turn + chat + logging)

- [x] 6.1 On an `isMyTurn` decision point: distill → request advice via worker → stream "top move + why" into the sidebar
- [x] 6.2 Debounce/cancel: if the position changes before the response completes, cancel and re-issue for the new position
- [x] 6.3 Append a `recommendation` event and link it to the move actually taken (next notification)
- [x] 6.4 Chat: per-decision-point thread seeded with the current briefing; refresh thread when the position materially changes

## 7. Sidebar advisor UI

- [x] 7.1 Advice panel: streamed recommended move + rationale, with loading/error states
- [x] 7.2 Chat panel: input + streamed answers; disabled with a clear message when no key configured
- [x] 7.3 Distinct states for advisor-disabled (no key) vs OpenRouter error vs working; observatory feed/health unaffected
- [x] 7.4 Confirm observe-only: the advisor/chat issue no clicks or inputs to the game

## 8. Verification

- [ ] 8.1 `npm run check` green: strict typecheck, all distiller unit tests pass, build succeeds; extension loads unpacked with no console errors
- [ ] 8.2 Manual end-to-end in a real BGA Agricola game with a key configured: advice streams on your turn, and chat answers a "why not X?" question from the current position
- [ ] 8.3 Confirm the API key is absent from the exported session log and from any page-context message; confirm opponent handles are stripped in what is sent
- [ ] 8.4 Confirm advisor failure paths are non-blocking (no key, forced error/timeout) and the game/observatory are unaffected
- [x] 8.5 `openspec validate add-bga-agricola-advisor --strict` passes; note explicitly that 8.2–8.4 are manual (no CI exists yet)

## 9. Phase 2 — pure modules for the runtime redesign

- [x] 9.1 `src/shared/decision-gate.ts`: pure module — `isMeaningfulDecision(briefing): boolean` (action-shape gate over `briefing.legalActions` minus `TRIVIAL_ACTIONS` plus `isMyTurn`). No name whitelist. Used by both probe and content.
- [x] 9.2 `src/shared/dedupe-key.ts`: pure `decisionKey(briefing): string` — `${gamestate.name}|${gamestate.id}|${round}|${activePlayerId}|${sorted(legalActions)}`; plus optional `decisionPrompt` hash to discriminate same-id repeated decision-prompts.
- [x] 9.3 `src/probe/settle.ts`: pure `Settler` state machine — `{idle, observing, settling, capped}`. Inputs: `onTransition`, `onActivity`, `tick(now)`. Output: `{shouldEmit, reason}`. Idle window default 800 ms, hard cap 2.5 s.
- [x] 9.4 Unit tests (node:test) for each module against fixtures from `observed-games/`: decision-gate parameterized across every distinct `gamestate.name` (assert: my-turn-with-non-trivial-actions → true); dedupe-key (deterministic, stable mid-decision, distinct across real consecutive decisions including solo); settler (single transition emits after idle; continuous burst emits exactly once at cap; game-end mid-settle aborts emit).

## 10. Phase 2 — probe runtime refactor

- [x] 10.1 Integrate `Settler` in the probe; remove the 3 s freshness timer (sole emit source is now settler).
- [x] 10.2 Trigger settle on the union of (a) gamestate-name transition AND (b) `(activePlayerId, possibleactions)` change to "now-my-turn-with-meaningful-actions" — covers state-id-stable transitions.
- [x] 10.3 Clear settler state and internal notif buffer on `detachIfNavigatedAway()` (SPA-nav / re-inject safety).
- [x] 10.4 Keep per-event notification posts lightweight (no batching) — preserves per-event timestamps used by `pendingRec` linkage and screenshot triggers.
- [x] 10.5 New `ProbeMessage` variant: `briefing-error` (debounced per reason). Emitted when distill returns `{ok:false}` so content can surface "advisor cannot read state yet."
- [x] 10.6 New `ProbeMessage` variant: `metric` (`name`, `value`). Probe emits `distill-ms`, `settle-duration-ms`, `notifs-per-settle` for diagnostics.
- [x] 10.7 Add content→probe inverse channel for `request-briefing`: separate envelope tag (`AGRI_OBS_CONTENT_v1`); probe replies with one fresh `briefing`. Used by chat for on-demand freshness.
- [x] 10.8 Heartbeat: 10 s (down from 5 s).

## 11. Phase 2 — content + advisor-client refactor

- [x] 11.1 Content consumes probe `briefing` only. Remove the 4 s safety-net `setInterval(evaluateAdvice, 4000)` and the content-side `evaluateAdvice(lastGamedatas, ...)` stale-data path entirely.
- [x] 11.2 Replace content's inline gate+key logic with imports of `decision-gate` + `dedupe-key`.
- [x] 11.3 Dedupe-key clear triggers: (a) `activePlayerId` flips away from me, (b) a notification name in a configurable `MOVE_NOTIFICATIONS` set (e.g. `placeFarmer`, `playerTookAction`, `addStables`, `addFences`, `sow`, `plow`, `buyCard`, `growFamily`, `harvestCrop`). NOT tied to `pendingRec` (which doesn't fire on cancelled advice).
- [x] 11.4 `src/content/advisor-client.ts`: two-slot in-flight, keyed by request kind (`advise` vs `chat`). `advise()` only cancels prior advise; `chat()` only cancels prior chat. Independent abort paths.
- [x] 11.5 Chat path: send `request-briefing` to probe with 500 ms timeout → use returned briefing OR fall back to `latestBriefing` → if both null, surface "Advisor needs the game to load…" inline. Disable chat input while probe is not attached.
- [x] 11.6 Stamp the agent-advice transcript message at *end-of-settle* (post-settle briefing), not at trigger. Stamp is immutable thereafter for that message. Chat replies also stamped from their grounding briefing.
- [x] 11.7 Supersede UX: when an in-flight advice is aborted with partial content, mark `kind: 'superseded'` and dim — do not silently remove a half-streamed message.
- [x] 11.8 Surface `briefing-error` events from the probe in the Events panel feed.

## 12. Phase 2 — sidebar three-phase UX

- [x] 12.1 `SidebarState`: replace `thinking: boolean` with `advisorPhase: 'idle' | 'reading' | 'thinking' | 'streaming' | 'error'`; add `burstEventCount?: number` for the "reading position… (N events)" affordance.
- [x] 12.2 Render the "reading position…" indicator during settle (own CSS class, faint pulse); "thinking…" only after settle ends and the request is in flight.
- [x] 12.3 Stick-to-bottom autoscroll: capture `wasAtBottom` (~40 px tolerance) before render; conditionally snap. Show a "New ↓" pill when sticky is off and new content arrived.
- [x] 12.4 Incremental transcript render: during streaming, mutate the in-flight message's `textContent` only; do not rebuild the full transcript fragment on every chunk.
- [x] 12.5 Add `'superseded'` to `TranscriptMsg.kind`; CSS `.msg.agent.superseded { opacity: .5; }`.
- [x] 12.6 Persistent "Set OpenRouter key" banner above the input when `advisorDisabled` AND transcript is non-empty (existing empty-state CTA stays).
- [x] 12.7 Chat input disabled (placeholder "Reconnecting to game…") while probe is detached.

## 13. Phase 2 — verification

- [x] 13.1 `npm run check` green: strict typecheck, all unit tests pass (existing 9 distiller + new gate + dedupe-key + settler), build succeeds.
- [x] 13.2 Decision-gate parameterized test asserts: for every distinct `gamestate.name` in `observed-games/*.json` where `isMyTurn && non-trivial actions`, the gate returns `true`. Regression-protects against silent exclusion of phases (the v1 whitelist bug).
- [ ] 13.3 Manual E2E in a real (solo and 2-player) BGA Agricola: advice fires once per real decision, current-state stamped, no beachball, supersede behaves on rapid decision changes, chat survives mid-advice send without cancelling the advice stream.
- [x] 13.4 Confirm zero per-notification `gamedatas` clones remain anywhere in the hot path (grep-verify) and that the only frequent main-thread work in the probe is `distill()` at settle-emit time.
- [x] 13.5 `openspec validate add-bga-agricola-advisor --strict` passes after the v2 spec deltas.

## 14. Phase 2 — placement-aware briefing (hotfix after v0.2.0.27)

- [x] 14.1 Add `PlayerView.placedFarmersThisRound: string[]` to the briefing schema (display names of action spaces this player has a farmer on).
- [x] 14.2 `distill()`: derive occupancy from `meeples[i].location` (any non-`board`/`reserve` location is an action-card id). Populate `actionBoard[].takenBy` from meeple occupancy — `cards.visible[].pId` is ALWAYS null in BGA Agricola and unusable.
- [x] 14.3 Use the same meeple-based count for `family.people` so the briefing's household size excludes `reserve` meeples (not yet built rooms) but includes farmers out on action spaces.
- [x] 14.4 Update advisor system prompt: do NOT suggest a space whose `takenBy` is set OR whose name is in `me.placedFarmersThisRound`; treat placedFarmersThisRound as the source of truth when `me.resources` lags BGA's end-of-round credit.
- [x] 14.5 Content stamp: append `placed[N]:Card1/Card2…` segment so the user can see at a glance whether the briefing reflects current placements.
- [x] 14.6 New fixture `test/fixtures/midwork.gamedatas.json` (R6 mid-work snapshot with three placed farmers) and three regression tests: pre-placement empty, me-placed surfaces, opponent-placed actionBoard.takenBy.

## 15. Phase 2 — placement tracker (hotfix after v0.2.0.32)

- [x] 15.1 New pure module `src/probe/placement-tracker.ts`: `PlacementTracker` class with `onPlaceFarmer / onReturnHome / seedFromMeeples / reset / view / placementsForPlayer`. Unit tests in `test/placement-tracker.test.ts` cover add, multi-player, returnHome clear, duplicate idempotency, empty-arg rejection, mid-round seed, seed-does-not-overwrite-live, reset.
- [x] 15.2 `distill()` accepts an optional `trackedPlacements: ReadonlyMap<cardId, {pId, cardName}>` 3rd arg. When supplied, it overrides the meeple-derived `actionBoard[].takenBy` and `me.placedFarmersThisRound`. When absent, falls back to meeple derivation (offline corpus tests).
- [x] 15.3 Distiller regression test pins the BGA-lag bug: with `decision` fixture (no meeples at action cards) and a tracker entry for `ActionReedBank → me`, the briefing MUST show `placedFarmersThisRound: ['Reed Bank']` and `actionBoard[ActionReedBank].takenBy === 'me'`.
- [x] 15.4 Probe instantiates one `PlacementTracker` per attach. `emitNotification` updates it from `placeFarmer` (adds) and `returnHome` (clears). `sendBriefing` passes `placements.view()` to `distill`.
- [x] 15.5 Probe seeds the tracker from existing meeples at attach time (covers mid-round page reload). Tracker is `reset()` on detach (both SPA-nav branches) so it never carries between tables.
- [x] 15.6 Root cause documented: `gamedatas.meeples[i].location` lags placeFarmer by SECONDS (33+ seconds observed in the captured corpus, across multiple gamestate transitions). Reading meeples for real-time placement detection is fundamentally wrong; the notification stream is the only synchronous source.

## 16. Phase 2 — effective resources (hotfix after v0.2.0.33)

- [x] 16.1 Verified live in console: `gd.players[me].resources` is a "transferred-to-reserve" cache, not effective inventory. Accumulator piles on cards the player sits on (e.g. 3 clay on ActionClayPit) are NOT in the cache but ARE counted in BGA's UI total (`#resource_<pid>_clay`).
- [x] 16.2 Added `effectiveResourcesFor(cache, placedCards, accumByCard)` to the distiller. Effective = cache + sum of goods meeples at each card location in the player's placed-cards list. Applied symmetrically to `me` and every opponent.
- [x] 16.3 Dropped `actionBoard[].goods` when `takenBy` is set — the pile is now in that player's `resources`, leaving it on the card would let the LLM double-count.
- [x] 16.4 Regression test pinned to the live-console scenario: gamedatas.clay=0 + 3 clay meeples on ActionClayPit + tracker says me is at ClayPit → briefing.me.resources.clay MUST be 3, briefing.actionBoard[ClayPit].goods MUST be undefined.
- [x] 16.5 System prompt updated: clarify that `me.resources` is the final effective count, do NOT cross-attribute resources to wrong action cards (Clay Pit yields clay, NOT wood/reed — the LLM was previously hallucinating "wood from Clay Pit").
- [x] 16.6 Trap recorded in memory: do NOT build a notification-driven ledger / reconciliation algorithm for resources (was over-engineered first attempt). Cache + on-card-piles is the correct, derivable model — no shadow state needed.

## 17. Phase 2 — DOM-canonical resources + freshness telemetry (v0.2.0.36)

- [x] 17.1 Verified live in console: both `gd.players[me].resources` (cache) and `gd.meeples` lag resource debits (Fireplace spend of 2 clay → cache still 3, meeples in reserve still 3, DOM shows 1). The DOM (`#resource_<pid>_<type>`) is the only synchronously-updated source.
- [x] 17.2 Probe scrapes `#resource_<pid>_<type>` for every known player in `scrapeLiveResources()` and passes the map as a 4th argument to `distill()`. When the live map has an entry for a player, the distiller treats it as canonical, ignoring the cache+pile derivation.
- [x] 17.3 Backwards-compatible fallback: when DOM scrape misses a player (panel not rendered), distiller falls back to cache+pile. Tests pass with and without `liveResources` supplied.
- [x] 17.4 Diagnostic: per-distill cache-vs-DOM drift event. Posts one `metric` (with `detail` string) per resource type whose cache value disagrees with the DOM. Silent when in sync. Future "stale cache" bugs visible immediately.
- [x] 17.5 Diagnostic: per-distill briefing-content summary. One compact line per distill showing R, myTurn, all resource counts, animals, placedFarmersThisRound, hand/played/spaces. Lets the user verify "what the LLM saw" without inspecting JSON.
- [x] 17.6 Diagnostic: `dom-scrape-miss` event when any player's panel didn't yield counters. Tells us when we're degraded to the cache+pile fallback.
- [x] 17.7 Advice stamp enriched: now includes all 7 resources plus animals plus placed summary. The at-a-glance freshness check covers every relevant resource type, not just food/wood/clay.
- [x] 17.8 `metric` ProbeMessage extended with optional `detail: string`. Content's `'metric'` handler prefers `detail` for the feed row text, falling back to `value.toFixed(1)` for legacy numeric metrics (distill-ms, settle-capped).
- [x] 17.9 Regression test pins the live scenario: cache.clay=3, no placements, but `liveResources` says clay=1 → briefing.me.resources.clay MUST be 1.
