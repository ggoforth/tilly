## ADDED Requirements

### Requirement: Probe injection and lifecycle

The extension SHALL inject a MAIN-world script into Board Game Arena Agricola tables only, registered via `chrome.scripting.registerContentScripts` so it can read page globals despite the page CSP. It MUST poll for `window.gameui` with backoff because BGA loads asynchronously, MUST re-attach when the user navigates between tables in the single-page app, and MUST NOT run on non-Agricola or non-BGA pages.

#### Scenario: Probe attaches on an Agricola table
- **WHEN** the user opens a Board Game Arena Agricola table and `window.gameui` becomes available
- **THEN** the probe attaches, begins capturing, and the attached state is recorded as a health event

#### Scenario: Probe does not run off-game
- **WHEN** the user is on any page that is not a BGA Agricola table
- **THEN** the probe is not injected and no capture occurs

#### Scenario: Re-attach on in-app navigation
- **WHEN** the user navigates from one Agricola table to another without a full page load
- **THEN** the probe re-attaches to the new table and starts a new session log

### Requirement: Game state snapshot capture

The system SHALL capture a safe deep clone of `gameui.gamedatas` as an initial snapshot when the probe attaches and as a snapshot paired to every captured notification. Cloning MUST use `structuredClone` with a JSON-replacer fallback; a clone failure MUST be recorded as a health event and MUST NOT crash capture.

#### Scenario: Initial snapshot on attach
- **WHEN** the probe attaches and `gamedatas` is readable
- **THEN** an `initial` snapshot event containing the full cloned `gamedatas` is appended to the session log

#### Scenario: Snapshot paired to a notification
- **WHEN** a game notification is captured
- **THEN** a snapshot event is recorded and the notification event references it via `linkedSnapshotId`

#### Scenario: Clone failure is non-fatal
- **WHEN** cloning `gamedatas` throws
- **THEN** a health event describing the failure is logged and capture continues

### Requirement: Notification capture

The system SHALL hook BGA's notification bus using both the legacy (`dojo.subscribe`) and modern (`bga.notifications`) mechanisms, record which mechanism delivered each notification, and capture each notification's name, payload, originating gamestate id, and active player id.

#### Scenario: Notification recorded with channel
- **WHEN** a game notification fires
- **THEN** a notification event is appended with its name, full payload, `channel` of `dojo` or `bga`, and the active player at that time

### Requirement: Turn and gamestate detection

The system SHALL record every BGA gamestate transition, including the state name, active player, and the available actions/args when present, and SHALL flag the transition with `isMyTurn` true when the active player equals the captured local player id.

#### Scenario: Decision point flagged
- **WHEN** a gamestate transition occurs whose active player is the local user
- **THEN** a gamestate event is recorded with `isMyTurn: true` and any `possibleActions`/`args` payload

#### Scenario: Opponent turn recorded
- **WHEN** a gamestate transition occurs whose active player is another player
- **THEN** a gamestate event is recorded with `isMyTurn: false`

### Requirement: Optional screenshot capture

The system SHALL support optional screenshots via `chrome.tabs.captureVisibleTab`, disabled by default, captured only at key moments (the local user's turn, new round, harvest, game end) when enabled. Screenshots MUST be stored separately from events and referenced by a `screenshot-ref` event so the event stream stays lean.

#### Scenario: Screenshots off by default
- **WHEN** capture runs and the screenshot toggle has never been enabled
- **THEN** no screenshots are taken and no `screenshot-ref` events are produced

#### Scenario: Screenshot at a key moment when enabled
- **WHEN** the screenshot toggle is enabled and it becomes the local user's turn
- **THEN** a screenshot is stored and a `screenshot-ref` event with reason `my-turn` is appended

### Requirement: Session log schema and persistence

The system SHALL maintain a `SessionLog` containing table metadata (table id, game name, local player id, players, variant if detectable, start time), an ordered `events` array, health transitions, optional screenshots, and end-of-game data. It MUST persist the log to `chrome.storage.local`, request `unlimitedStorage`, flush periodically, and recover the in-progress log after a page reload. The backing store MUST be accessed behind a storage interface so it can be replaced without changing capture.

#### Scenario: Schema shape
- **WHEN** any event is captured
- **THEN** it conforms to one of the defined event kinds (`snapshot`, `notification`, `gamestate`, `health`, `screenshot-ref`) and carries an ordered capture timestamp

#### Scenario: Survives reload mid-game
- **WHEN** the page reloads during an active game after events were captured
- **THEN** the previously captured events are still present in the restored session log

### Requirement: JSON export

The system SHALL export the current session log as a single downloadable JSON file on user request, and SHALL support clearing the stored log.

#### Scenario: Export produces a JSON file
- **WHEN** the user triggers export
- **THEN** a JSON file containing the full `SessionLog` is downloaded

#### Scenario: Clear resets the log
- **WHEN** the user triggers clear
- **THEN** the stored session log is emptied and subsequent capture starts fresh

### Requirement: Graceful degradation with tri-state health

The system SHALL operate with zero configuration and expose a tri-state health status. `healthy` = probe attached, `gamedatas` readable, notification bus hooked (snapshot-per-notification capture). `degraded` = `gamedatas` readable but notifications unavailable (timer- and DOM-mutation-triggered snapshots). `unhealthy` = `gameui` unavailable (screenshot-on-heuristic plus best-effort DOM scrape). Every health transition MUST be logged and surfaced; the system MUST NOT fail silently and MUST still produce an exportable log in every state.

#### Scenario: Degraded fallback when notifications unavailable
- **WHEN** the probe attaches and `gamedatas` is readable but the notification bus cannot be hooked
- **THEN** health becomes `degraded`, a health event is logged, and snapshots are captured on a timer and on relevant DOM mutations

#### Scenario: Unhealthy fallback when gameui missing
- **WHEN** `window.gameui` does not become available
- **THEN** health becomes `unhealthy`, a health event is logged, and screenshot-plus-DOM best-effort capture still produces an exportable log

### Requirement: Observe-only operation

The extension SHALL only observe. It MUST NOT call any AI service or OpenRouter, MUST NOT make any network request with captured data, MUST NOT produce move recommendations, and MUST NOT click, play, or otherwise alter the game.

#### Scenario: No outbound network with game data
- **WHEN** any telemetry is captured during a game
- **THEN** no network request carrying game data is made and all data remains local

#### Scenario: No game mutation
- **WHEN** the extension is active during a game
- **THEN** it issues no clicks or inputs to the game and the game proceeds exactly as if the extension were absent
