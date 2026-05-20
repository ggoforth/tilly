## Context

The advisor we ultimately want depends on knowing exactly how BGA represents Agricola's state and turn flow. That schema is currently unknown and would be expensive to guess wrong. This change builds a read-only observatory to capture the real telemetry from live games, validated against a real table on 2026-05-17. It is greenfield: empty repo, OpenSpec-managed, TypeScript + esbuild, Manifest V3, no runtime dependencies, no network calls.

## Goals / Non-Goals

**Goals:**

- Capture a complete, replayable record of an Agricola game: full state snapshots, the notification stream, every turn/decision point, the user's private state, and the action board.
- Make the captured schema concrete enough that the future advisor can be built from exported logs without re-instrumenting.
- Run with zero configuration and degrade gracefully so a game is never lost mid-session.
- Low setup risk and fast iteration (loadable unpacked the same day).

**Non-Goals:**

- No AI, OpenRouter, advice, in-game actions, automation, or learn-from-losses loop (see proposal Non-goals). Observe-only is a hard constraint.
- Not a polished UI; the sidebar exists to confirm capture is working and to export.
- Not multi-game (only Agricola tables for now).

## Decisions

**D1. MAIN-world probe via `chrome.scripting.registerContentScripts({world:'MAIN'})`.**
BGA's state lives on the page global `window.gameui` (`gameui.gamedatas`) and its notification bus. Content scripts run in an isolated world and cannot see these.
*Alternatives:* declarative `world:"MAIN"` in `manifest.json` (known Chrome bugs, unreliable); injecting a `<script src>` tag (blocked by BGA's page CSP). Registering a MAIN-world content script from the service worker via the scripting API avoids both. *Trade-off:* MAIN-world code shares the page's context (must namespace, must not collide with `gameui`).

**D2. JS-state capture is primary; screenshots are an optional supplement.**
`gameui.gamedatas` + notifications give structured, lossless state. Screenshot→vision is lossy on Agricola's dense board and expensive.
*Alternatives:* screenshot+vision as primary (rejected: unreliable for small numbers/card text every turn); intercepting BGA's socket/long-poll traffic (rejected: opaque, framework-version-fragile, harder than the JS layer it feeds). Screenshots are kept, off by default, only at key moments, for later ground-truth diffing.

**D3. TypeScript + esbuild, no UI framework.**
Types matter while reverse-engineering an unknown `gamedatas` shape; esbuild is a one-command build with negligible setup risk.
*Alternatives:* vanilla JS (no types while spelunking — rejected); Vite + CRXJS + React (setup-snag risk before the same-day deadline, overkill for a logger — deferred to the future advisor UI, which can adopt it without changing the capture layer).

**D4. Snapshot keyed to every notification, full deep clone.**
Each notification stores a paired full `gamedatas` snapshot (`linkedSnapshotId`) so the notification→state-change mapping is reconstructable offline — the single most valuable thing for designing the advisor.
*Alternatives:* timer-only snapshots (loses causal mapping); deltas only (unrecoverable if we mislabel during reverse-engineering). Storage is cheap relative to this value; delta-compression is a possible future optimization, not now.

**D5. Persistence in `chrome.storage.local` with `unlimitedStorage`, periodic flush.**
Survives page reloads/crashes mid-game. Export produces one JSON file; Clear resets.
*Alternatives:* in-memory only (loses the game on reload — unacceptable); IndexedDB (more robust for very large logs — noted as a future swap behind the same buffer interface if quota becomes a problem). The buffer is written behind a small storage interface so the backing store can change without touching capture.

**D6. Sidebar as a Shadow-DOM panel injected by the isolated content script.**
Persistent and visible during play (unlike a popup), style-isolated from BGA via Shadow DOM. The isolated content script owns the sidebar, the log buffer, persistence, and export; the MAIN-world probe only reads and relays via `window.postMessage`.

**D7. Detect and hook both notification frameworks.**
BGA has a legacy path (`dojo.subscribe('notif_x', ...)`) and a modern one (`bga.notifications`). The probe attempts both, and records which worked in the health log so we learn what Agricola on prod actually uses.

## Telemetry Schema (captured + exported)

Exported as a single JSON `SessionLog`. Concrete shape (TypeScript):

```ts
interface SessionLog {
  schemaVersion: number;                 // bump on shape changes
  capturedBy: { extensionVersion: string; userAgent: string };
  table: {
    tableId: string;
    gameName: string;                    // expect "agricola"
    me: string;                          // my BGA player id
    players: { id: string; name: string; color?: string; order?: number }[];
    variant?: string;                    // family/normal, decks, if detectable
    startedAt: string;                   // ISO
  };
  events: Event[];                       // strictly ordered by capture time
  healthTransitions: { t: string; status: Health; reason: string }[];
  screenshots?: { id: string; eventId: string; takenAt: string; dataUrl: string }[];
  final?: { scores?: unknown; raw?: unknown };  // end-of-game if reachable
}

type Health = 'healthy' | 'degraded' | 'unhealthy';

type Event =
  | { kind: 'snapshot'; id: string; t: string; serverT?: string;
      source: 'initial' | 'notification' | 'timer' | 'dom';
      gamestateId?: string | number; activePlayerId?: string;
      gamedatas: unknown; }                       // safe deep clone
  | { kind: 'notification'; id: string; t: string; serverT?: string;
      name: string; channel: 'dojo' | 'bga'; args: unknown;
      gamestateId?: string | number; activePlayerId?: string;
      linkedSnapshotId: string; }                 // pairs to a snapshot event
  | { kind: 'gamestate'; id: string; t: string;
      from?: string | number; to: string | number; name?: string;
      description?: string; activePlayerId?: string;
      isMyTurn: boolean;                          // activePlayerId === table.me
      possibleActions?: unknown; args?: unknown; }
  | { kind: 'health'; id: string; t: string; status: Health; reason: string }
  | { kind: 'screenshot-ref'; id: string; t: string; screenshotId: string;
      reason: 'my-turn' | 'round' | 'harvest' | 'game-end' };
```

Decision points the future advisor keys on = `gamestate` events with `isMyTurn: true`; each carries `possibleActions`/`args`, and the immediately preceding `snapshot` gives full board + the user's hand/farm/resources at that moment.

## Graceful Degradation

Tri-state health, surfaced explicitly in the sidebar; every transition is logged as a `health` event:

- **healthy** — probe attached, `gameui.gamedatas` readable, notification bus hooked. Capture = snapshot-per-notification + gamestate + notifications.
- **degraded** — probe attached, `gamedatas` readable, but notification hook unavailable/failed. Capture = snapshots on a timer interval and on relevant `MutationObserver` activity (no notification stream). Sidebar amber.
- **unhealthy** — `gameui` not found / `gamedatas` unreadable. Capture = screenshot-on-heuristic (turn/round detected from DOM) plus best-effort DOM scrape. Sidebar red with a clear message. Still produces an exportable log.

Probe lifecycle is explicit: it polls for `gameui` with backoff (BGA loads async), shows **attached / not attached** in the sidebar, and re-attaches on SPA navigation between tables. Zero configuration — no keys, no settings — it captures on install. Nothing fails silently: every fallback is a visible health transition and a logged event. `gamedatas` cloning uses `structuredClone` with a JSON-replacer fallback; a clone failure is recorded as a health event, never a crash.

## Risks / Trade-offs

- **BGA `gamedatas` shape unknown** → that is this change's purpose; `schemaVersion` + the fallback paths guarantee a usable, evolvable log even if the richest path fails.
- **MAIN-world registration timing / SPA navigation** → poll for `gameui` with backoff, re-register on navigation, surface probe status; never assume immediate availability.
- **Page CSP blocks script injection** → mitigated by D1 (scripting-API MAIN-world registration, not `<script>` tag).
- **`chrome.storage.local` quota** → request `unlimitedStorage`, periodic flush, Export+Clear; storage behind an interface so IndexedDB can replace it later without touching capture.
- **Deep snapshot size** → accept for v1 (value > cost); delta-compression is a noted future optimization.
- **Legacy vs modern notification framework differences** → hook both, record which worked (D7).
- **ToS sensitivity** → read-only, local-only, no automation, no network, nothing leaves the machine; observe-only is enforced by design, not just policy.

## Migration Plan

Install: `npm i && npm run build`, then load the unpacked `dist/` in Arc (`chrome://extensions`, Developer mode). Rollback: remove the unpacked extension — there is no server side, no persisted external state, and no game-side effect. The exported JSON is the only durable artifact and is local.

## Open Questions

- Exact `gamedatas` keys for hand/farm/resources/action board — resolved empirically by the first captured game.
- Whether Agricola on BGA prod uses the legacy or modern notification framework — detected and logged at runtime (D7).
- Typical storage size per game — measured during the first real capture; informs whether the IndexedDB swap (D5) is needed.
