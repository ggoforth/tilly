## Context

v1 (the observatory) is built and verified against a real game: at every user decision point we have the full `gamedatas` (board, hands, resources, scores), the legal action set (`gamedatas.gamestate.possibleactions` / `gamedatas.engine`), and full card rules text. v2 consumes that to advise. The same architecture is reused: MAIN-world probe → isolated content script → service worker, plus a Shadow-DOM sidebar. No UI framework, TypeScript + esbuild, build-stamped versioning. Observe-only is a hard constraint carried forward.

## Goals / Non-Goals

**Goals:**

- On the user's turn, automatically produce a recommended move + concise rationale, streamed into the sidebar, fast enough for live (untimed, unranked) play.
- Let the user chat about the current position ("why not X?"), grounded in the same briefing.
- Keep the key and the LLM call off the page; the user supplies their own key.
- Be honest about quality: log recommended-vs-actual so advice can be evaluated empirically.

**Non-Goals:** as proposal — no automation/actions, no learn-loop, no log slimming, no model tiering.

## Decisions

**D1. Pure heuristic state distiller (snapshot → briefing).**
A dependency-free pure function maps a captured snapshot to a compact briefing. Chosen over sending trimmed raw `gamedatas` (bloated, expensive, brittle to schema drift, worse advice) because it bounds tokens (~1–3 KB), is debuggable, and — being pure — is unit-testable against real fixtures. Card rules text is included verbatim (already concise, essential for synergy reasoning). Structured so a future "include raw sub-object on demand" hybrid is an easy add.

**D2. LLM call in the service worker.**
The worker holds the key (from `chrome.storage.local`), makes the cross-origin `openrouter.ai` call free of BGA's page CSP, and keeps the key out of page/probe context. Flow: probe → content (distill) → worker (OpenRouter) → content (stream into sidebar). Alternative (call from content/page) rejected: leaks key into page-adjacent context and fights CSP.

**D3. User supplies their own OpenRouter key via an options page.**
The extension never ships a key and the assistant never enters one. The options page has a key field and a model picker (the user's "LLM of choice"). Single model only (tiering is YAGNI). Static strategy preamble uses OpenRouter prompt caching to cut latency/cost.

**D4. Auto-on-turn with debounce/cancel.**
Advice is requested when a gamestate event with `isMyTurn` and a non-trivial `possibleactions` occurs. If the position changes before the response returns, the in-flight request is cancelled and re-issued for the new position (no stale advice).

**D5. Chat shares the position briefing.**
Each turn has a chat thread seeded with the current briefing as system context. User messages append; the model answers grounded in the briefing. The thread resets when the position materially changes (new decision point), carrying the new briefing.

**D6. Recommended-vs-actual logging (additive, schemaVersion bump).**
When advice is produced, a `recommendation` event is appended to the existing session log; when the next notification reveals the move actually taken, it is linked. Existing event kinds are unchanged; `SCHEMA_VERSION` is bumped. This is the empirical quality seam and the future learn-loop input.

## Position Briefing Schema (the LLM contract)

```ts
interface PositionBriefing {
  schemaVersion: number;
  round: number;
  phase: string;                 // e.g. "work", "harvest", "draft"
  isMyTurn: boolean;
  legalActions: string[];        // from gamedatas.gamestate.possibleactions
  decisionPrompt?: string;       // gamestate description, if present
  me: PlayerView;
  opponents: PlayerView[];       // handles stripped -> "Opponent 1", ...
  actionBoard: ActionSpace[];    // space name, accumulated goods, taken-by
  availableMajorImprovements: CardView[]; // shared board — majors still buildable by anyone
  draftPool?: CardView[];        // cards still draftable, during the draft phase
}
interface PlayerView {
  resources: Record<string, number>;   // wood, clay, reed, stone, food, grain, veg
  animals: Record<string, number>;     // sheep, boar, cattle
  farm: { rooms: number; roomType: string; fields: number;
          pastures: number; stables: number; fencedSpaces: number;
          emptySpaces: number };
  family: { people: number; canGrow: boolean };
  hand?: CardView[];             // me only — your playable occupations + minor improvements
  played: CardView[];            // occupations / improvements already in play
  score?: number;
}
interface CardView {
  id: string; name: string;
  kind: string;                  // "occupation" | "minor" | "major"
  rulesText: string;             // verbatim card text
  cost?: string;                 // cost summary, e.g. "2 wood"
  prerequisite?: string;         // e.g. "2 Occupations", if any
}
interface ActionSpace { id: string; name: string; goods?: string; takenBy?: string; }
```

Card sources are explicit: `me.hand` is your playable occupations + minor improvements; `availableMajorImprovements` is the shared major-improvements board (buildable by anyone); `draftPool` is what remains draftable during the draft phase. The distiller is the only place that knows BGA's `gamedatas` shape; everything downstream depends only on `PositionBriefing`.

## Privacy / Security

- The user pastes their own OpenRouter key into the options page; the assistant never enters credentials. Key lives in `chrome.storage.local`, read only by the service worker, sent only to `https://openrouter.ai`.
- Board state is sent to the user's chosen LLM — inherent to the feature and opt-in by configuring a key. Opponent handles are replaced with "Opponent N" in the briefing before any send. No other PII exists in game state.
- Strictly observe-only: the advisor reads and recommends; it issues no input to the game.

## Graceful Degradation

- **No key / no model configured** → advisor disabled; sidebar shows "Set your OpenRouter key in options"; the observatory keeps capturing normally. Zero-config still runs (as v1).
- **OpenRouter error / timeout / rate-limit** → the sidebar shows the error for that turn; capture continues; the game is never blocked; nothing throws into the page.
- **Distiller cannot parse a snapshot** → log a health note, skip advice for that turn, keep capturing. Never crash.

## Risks / Trade-offs

- **LLM advice quality is not automatable** → mitigated by recommended-vs-actual logging (empirical, reviewable) + user judgment. Flagged, not hidden.
- **BGA `gamedatas` schema drift** → isolated entirely in the distiller; fixtures + unit tests catch breakage; downstream untouched.
- **Latency** → fast model + streaming + prompt caching; game is untimed so even slow models are acceptable.
- **Key handling** → never in page context, never logged, never exported (the session log must exclude the key).
- **Data to third party** → explicit, opt-in, opponent handles stripped.

## Proof Posture

- **No git repo / no CI exists** — stated explicitly; this change does not add CI (out of scope) but adds the local gate below and flags the gap.
- **Level 3 (types):** strict `tsc --noEmit` stays green; `PositionBriefing` and advice/chat messages are typed.
- **Level 4 (tests):** the distiller is pure → unit-tested with Node's built-in `node:test` (no new deps) against real snapshot fixtures extracted from `observed-games/`. Scenarios in the `state-distiller` spec map directly to these tests.
- **Local gate:** `npm run check` = typecheck + test + build; recommended before any commit.
- **Unverifiable-by-automation (flagged):** live OpenRouter/BGA integration and advice quality — covered by a manual end-to-end task and recommended-vs-actual logging, explicitly not claimed as CI-proven.

## Migration Plan

Additive. `SCHEMA_VERSION` bumps; old exported logs remain readable (new event kind simply absent). Install adds an options page and an `openrouter.ai` host permission. Rollback = revert to the v1 build; the observatory is unaffected. No server side.

## Open Questions

- Exact mapping of every `gamedatas` farm sub-structure (rooms/pastures/fences) — refined against fixtures during distiller implementation; the briefing schema is the stable contract regardless.
- Default model recommendation — chosen during implementation from current OpenRouter options; user-overridable.

---

## Phase 2 — Runtime redesign (live-tested, post-mortem-driven)

Phase 1 shipped a working advisor that the user could exercise live. Across many iterations on the live tab the dominant issues were: (1) BGA animation lag / spinning beachball on the page thread, (2) "stale" advice that recommended a move the user had already taken, (3) burst-event races where the advisor reacted to the first event of a burst and was then stuck. Two parallel architect reviews (Software Architect + Frontend) identified that **every previous fix reduced one cost or one event source but never removed the underlying class of work from BGA's render thread**, and that the trigger logic conflated "decision name" with "decision instance". Phase 2 is a targeted runtime redesign bounded to the advisor — v1 observatory + distiller + key-handling + UX shell remain.

**D8. Decision-driven settle (replaces continuous polling).**
The probe stops emitting briefings on a periodic timer or on every gamestate transition. The new emit trigger combines: (a) the **action-shape gate** (`isMyTurn && legalActions minus TRIVIAL_ACTIONS is non-empty`) — a property of the briefing, not a hand-curated name list, so new BGA phases are not silently excluded; (b) a **settle state machine** with a small idle window (~800 ms) AND a hard cap (~2.5 s) so a continuous burst still produces exactly one emit at the cap. The settle state machine is a pure module unit-tested against the captured-game corpus.
*Alternatives:* a fixed debounce alone (rejected: never-settling bursts starve advice); a name whitelist of decision gamestates (rejected: silently excludes phases on the next BGA rename — verified against `observed-games/*.json`).

**D9. New dedupe key (replaces brittle key).**
The dedupe key becomes `gamestate.name | gamestate.id | round | activePlayerId | sorted(legalActions)`. It drops `occupied-action-spaces` (could flip optimistically before the user confirms) and `family.people` (which is "household size", not "people placed this round" — the prior implementation conflated the two). Cleared on: (a) `activePlayerId` flips away from the local player, OR (b) an observed move-notification fires. Not tied to `pendingRec`, because in-flight advice that is cancelled mid-stream never produces a `pendingRec`. **Solo-mode load-bearing:** trigger (a) is a no-op in solo; trigger (b) is what guarantees the key resets between consecutive solo placements.

**D10. Two-slot advisor client (replaces single-flight).**
`AdvisorClient` exposes two independent in-flight slots: `advise` and `chat`. `advise()` only aborts a prior advise; `chat()` only aborts a prior chat. Chat sent mid-advice does **not** kill the streaming advice (which would silently delete advice the user is reading). Both kinds share the same Port but have distinct request lifecycles.

**D11. Three-phase UI for advice.**
The sidebar exposes a three-state phase per real decision instead of a binary `thinking`: `reading` (settle window active — "reading position…" indicator, optional burst-event count, no agent bubble yet), `thinking` (settle ended, briefing locked, agent bubble appears with immutable `seen:` stamp from that briefing), `streaming` (chunks fill the in-flight bubble). The `seen:` stamp is computed once at end of settle and never changes for that message — protecting the trust contract that "this is what the advisor actually looked at."

**D12. Probe runtime diet.**
The probe MUST NOT do continuous heavy work on BGA's thread. Specifically: no per-notification `gamedatas` clone (already true post-Phase-1); no periodic timer that distills; the only heavy operation is `distill()` at settle-emit time. Notifications still post per-event but are lightweight (name + args + channel + timestamp; no `gamedatas`) — preserving per-event timestamps that move-linkage and screenshot triggers depend on. Per the Software Architect's review we explicitly do **not** batch notifications speculatively; if the per-event volume becomes a measured problem, batching is a future change.

**D13. Inverse channel: `request-briefing` for chat.**
Content → probe direction is added via a distinct envelope tag (`AGRI_OBS_CONTENT_v1`). When the user sends a chat message, content asks the probe for a fresh briefing with a 500 ms timeout; on timeout the chat falls back to the most recent already-received briefing; if neither is available the chat surfaces "Advisor needs the game to load…" inline rather than calling the LLM. The chat input is disabled while the probe is not attached.

**D14. Diagnostic visibility.**
New `ProbeMessage` variants `briefing-error` (debounced per reason) and `metric` (`distill-ms`, `settle-duration-ms`, `notifs-per-settle`) make the hot path observable in the Events panel without re-introducing heavy traffic.

### Risks / trade-offs (Phase 2)

- **Settle window perceived latency.** ~800 ms idle is a deliberate trade vs. trust-in-state. The `reading position…` indicator covers this perceptually; without it the silent wait is worse than today's eager-but-stale advice.
- **Cap fires during a never-settling burst.** The cap emit is correct (advice on a slightly noisy frame is better than no advice), and the new dedupe key allows a later re-emit if it turns out two decisions were happening.
- **Per-notification post volume.** We accept the small per-event traffic cost rather than batch, on the architect's recommendation, until measurement shows it matters.
- **No CI gap remains.** Pure modules (gate, settler, dedupe-key) are unit-tested locally; runtime integration is manual E2E. Flagged honestly; the proof posture is unchanged from Phase 1.

### Proof posture (Phase 2)

Pure-logic anchors:
- `src/shared/decision-gate.ts` — unit-tested across every distinct `gamestate.name` in `observed-games/*.json` where `isMyTurn && non-trivial actions`, asserting the gate returns `true` (regression-protects against silent phase exclusion).
- `src/shared/dedupe-key.ts` — unit-tested: deterministic, stable mid-decision, distinct across real consecutive decisions (including a synthetic solo two-placement pair).
- `src/probe/settle.ts` — unit-tested: idle-window emit, burst-resets-cap emit, game-end mid-settle aborts emit.
- Existing 9 distiller tests stay green.
- `npm run check` (typecheck + tests + build) remains the local proof gate. Runtime integration (probe ↔ content ↔ worker ↔ LLM ↔ DOM) stays manual E2E by design.
