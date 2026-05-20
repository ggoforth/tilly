## ADDED Requirements

### Requirement: User-supplied OpenRouter configuration

The extension SHALL provide an options page where the user enters their own OpenRouter API key and selects a model. The extension MUST NOT ship or hardcode a key. The key MUST be stored extension-local (`chrome.storage.local`), MUST only ever be sent to `https://openrouter.ai`, MUST NOT be placed in page/probe context, and MUST be excluded from the exported session log.

#### Scenario: Key entered by the user
- **WHEN** the user saves a key and model on the options page
- **THEN** they are persisted in extension storage and used for subsequent advice requests

#### Scenario: Key never leaves its boundary
- **WHEN** the session log is exported or any message is posted to the page
- **THEN** the API key does not appear in the export or in any page-context message

### Requirement: Service-worker LLM boundary

The OpenRouter request SHALL be made from the service worker, not from the page or MAIN-world probe. The content script SHALL send a distilled `PositionBriefing` (never raw `gamedatas`) to the worker, which calls OpenRouter and streams the response back.

#### Scenario: Distilled input only
- **WHEN** an advice request is made
- **THEN** the payload sent to OpenRouter is derived from the `PositionBriefing`, not raw `gamedatas`

### Requirement: Automatic advice on the user's turn

When a real decision arrives — defined by the action-shape gate in the `decision-gate` capability (`isMyTurn` AND `legalActions` minus `TRIVIAL_ACTIONS` is non-empty) — and the probe's settle window completes (see `probe-runtime`), the system SHALL automatically request advice and stream a single recommended move plus concise rationale into the sidebar. The request MUST be keyed by the dedupe key from `decision-gate` so that churn within a single decision does not re-fire. When a **genuinely new** decision arrives (different dedupe key), the prior **advise** request — and only the advise slot — MUST be aborted before issuing the new one; chat and advice MUST have independent in-flight slots.

#### Scenario: Advice appears on the user's turn
- **WHEN** a real decision arrives and the settle window completes with a key configured
- **THEN** exactly one recommended move with rationale is streamed into the sidebar

#### Scenario: Stale advice cancelled on new decision
- **WHEN** the dedupe key changes while an advise request is in flight
- **THEN** the in-flight advise is aborted and a new advise is issued for the new decision

#### Scenario: Chat does not preempt advice
- **WHEN** the user sends a chat message while an advise request is streaming
- **THEN** the advise stream continues unaffected; chat runs in its own in-flight slot

### Requirement: Recommended-vs-actual logging

The system SHALL append a recommendation event to the session log when advice is produced and link it to the move actually taken (from the next notification). Existing event kinds MUST be unchanged and `SCHEMA_VERSION` MUST be bumped. The dedupe key MUST be cleared on either of: (a) `activePlayerId` flips away from the local player, OR (b) an observed move notification fires — but NOT on `pendingRec` arrival, because in-flight advice that is cancelled mid-stream never produces a `pendingRec`.

#### Scenario: Recommendation recorded and linked
- **WHEN** advice is produced and the user then takes an action
- **THEN** the log contains a recommendation event linked to the actual action, and pre-existing event kinds are unchanged

#### Scenario: Solo placements re-fire after each move
- **WHEN** the user takes a placement in solo play (no opponent turn to flip `activePlayerId`) and a new decision of the same gamestate name arrives
- **THEN** the dedupe key is cleared by the observed move notification, and the new decision re-fires advice

### Requirement: Graceful degradation

With no key/model configured, the advisor MUST be disabled with a clear sidebar message while the observatory continues capturing. On OpenRouter error, timeout, or rate-limit, the failure MUST be surfaced in the sidebar for that turn, capture MUST continue, the game MUST never be blocked, and nothing may throw into the page. The advisor MUST remain strictly observe-only (it issues no input to the game).

#### Scenario: No key configured
- **WHEN** the user is on a table with no OpenRouter key set
- **THEN** the sidebar shows a "set your key" message and telemetry capture still works

#### Scenario: OpenRouter failure is non-blocking
- **WHEN** an advice request errors or times out
- **THEN** the sidebar shows the error, capture continues, and the game is unaffected

#### Scenario: Observe-only
- **WHEN** the advisor is active during a game
- **THEN** it issues no clicks or inputs to the game
