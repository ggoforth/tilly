## Why

The v1 observatory proved we can capture, at every one of the user's decision points, the full board, the legal action set, and complete card rules text. That is exactly the input an LLM needs to recommend strong Agricola moves. v2 turns that captured signal into a real-time advisor: on the user's turn it streams a recommended move with a concise rationale into the sidebar, and the user can ask follow-up questions about the position. This is the core of the original vision — becoming superhuman by always having well-reasoned advice — while staying strictly observe-only.

## What Changes

- A pure **state distiller**: converts a `gamedatas` snapshot into a compact (~1–3 KB, not ~1 MB) "position briefing" — the user's farm/resources/food, hand with each card's verbatim rules text, opponent summary, the action board with accumulated goods, round/phase, and the legal `possibleactions`.
- A **service-worker OpenRouter client**: makes the LLM call off the page (cross-origin, holds the key), with prompt caching for the static strategy preamble.
- An **options page** where the user pastes their own OpenRouter API key and picks a model; key stored extension-local, used only for `openrouter.ai`.
- **Auto-on-turn advice**: on each of the user's decision points, distill → call LLM → stream "top move + why" into the sidebar. Cancels/re-issues if the position changes before the answer returns.
- **Interactive chat**: the user can ask "why not X?"; answers are grounded in the current position briefing. Thread refreshes when the position materially changes.
- **Recommended-vs-actual logging**: extend the observatory session log (bump `schemaVersion`) to record each recommendation and the move actually taken — the empirical quality seam and the input for a future learn-from-losses change.
- **Graceful degradation**: no key → advisor cleanly disabled with a clear message, observatory still runs; OpenRouter error/timeout → surfaced in the sidebar, capture continues, game never blocked.
- **Proof infrastructure**: a minimal `node:test` runner (no new deps) with state-distiller unit tests against real snapshot fixtures from `observed-games/`, plus a `npm run check` (typecheck + test + build) local gate.

## Non-goals

- **No in-game actions or automation.** The advisor recommends; it never clicks, plays, or alters the game. Same hard observe-only constraint as v1 (preserves the user's unranked-only ethic; BGA Terms forbid bot play).
- **No learn-from-losses loop.** v2 only *logs* recommended-vs-actual; mining it to improve strategy is a separate later change.
- **No observatory log slimming.** The ~205 MB/game problem is real but is its own separate change; v2 does not change capture volume.
- **No model auto-tiering.** A single user-selected model only; fast/deep tiering is deferred.

## Capabilities

### New Capabilities

- `state-distiller`: pure transformation of a captured `gamedatas` snapshot into a compact, LLM-ready position briefing (board, hand + card rules text, opponent summary, legal actions, round/phase), with opponent handles stripped for privacy. Pure and unit-tested.
- `llm-advisor`: the service-worker OpenRouter client, the options page (user-supplied key + model picker), auto-on-turn triggering with debounce/cancel, "top move + why" streamed to the sidebar, recommended-vs-actual logging, and graceful degradation.
- `advisor-chat`: interactive position-grounded chat in the sidebar, a single continuous transcript with per-message `seen:` stamps; chat requests use an on-demand fresh briefing via the probe with a timeout fallback.
- `decision-gate`: pure modules for the action-shape advice gate and the dedupe key — shared between probe and content; unit-tested across the captured-game corpus.
- `probe-runtime`: the MAIN-world probe's runtime posture — settle state machine, no continuous heavy work on BGA's render thread, on-demand fresh briefing for chat, and diagnostic `briefing-error` / `metric` messages.

### Modified Capabilities

- `observatory-sidebar`: the panel changes from a closable overlay to a **docked, always-open side panel** that reserves a gutter so it never obscures the board/controls (it now also hosts advisor + chat). `bga-telemetry-capture` is unchanged; the new recommendation log entries are additive behind a `schemaVersion` bump.

## Impact

- **New code**: `src/advisor/distiller.ts` (pure), `src/advisor/openrouter.ts` (service worker), `src/options/` (options page), advisor UI in the sidebar, recommendation events in the shared log types.
- **New dev infra**: `node:test` tests + fixtures extracted from `observed-games/`; `npm run test` and `npm run check` scripts.
- **Manifest**: add an options page; add `https://openrouter.ai/*` host permission for the service-worker fetch; storage already present.
- **Dependencies**: none new at runtime; no new dev deps (Node built-in test runner).
- **Privacy/security**: the user supplies their own key (the assistant never enters credentials). Board state is sent to the user's chosen LLM — inherent and opt-in by configuring; opponent handles are stripped first.
- **Proof gap (explicit)**: no git repo / no CI exists. The distiller is unit-tested and typecheck is enforced locally; LLM advice quality and live OpenRouter/BGA integration are **not** automatable — mitigated by recommended-vs-actual logging and a manual end-to-end check, flagged rather than hidden.
