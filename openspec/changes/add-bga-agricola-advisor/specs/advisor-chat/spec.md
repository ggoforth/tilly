## ADDED Requirements

### Requirement: Position-grounded chat with on-demand fresh briefing

The sidebar SHALL provide a chat where the user can ask free-form questions (e.g. "why not X?") about the current position. Each request MUST include a freshly-grounded `PositionBriefing`, obtained by sending a `request-briefing` message to the probe (see `probe-runtime`) with a 500 ms timeout; if the probe does not reply in time, the system MUST fall back to the most recent `briefing` already received. If neither is available, the system MUST surface "Advisor needs the game to load…" inline rather than send a request. All requests use the same service-worker OpenRouter boundary; the API key never crosses the page boundary; raw `gamedatas` is never sent.

#### Scenario: Question answered from freshly-distilled state
- **WHEN** the user asks a question during their turn and the probe is attached
- **THEN** content requests a fresh briefing from the probe and the LLM answer is grounded in that fresh briefing

#### Scenario: Fallback when probe slow
- **WHEN** the probe does not reply to `request-briefing` within 500 ms
- **THEN** the chat uses the most recent already-received briefing and proceeds

#### Scenario: Probe not attached yet
- **WHEN** the user types a chat message before the probe has attached
- **THEN** the chat surfaces "Advisor needs the game to load…" and does not call the LLM

### Requirement: Continuous transcript with per-message stamping

The chat surface SHALL be a single continuous, autoscrolling transcript: each turn's auto-advice posts as a new agent message; the user's questions and the agent's replies interleave in the same thread. Each agent message MUST carry a diagnostic `seen:` stamp derived from the briefing the model actually reasoned over, computed once at the moment the briefing is locked in (end of settle for advice, or after the on-demand briefing arrives for chat), and immutable thereafter for that message. The history sent to the LLM on chat requests MUST be capped (recent N turns) to bound token cost.

#### Scenario: Auto-advice flows into the same thread
- **WHEN** a new decision arrives and advice is produced
- **THEN** a new agent message is appended to the same transcript (no thread reset)

#### Scenario: Stamp reflects post-settle truth
- **WHEN** an agent advice message is created at end of settle
- **THEN** its `seen:` stamp encodes the briefing used, and does not change as later events arrive

### Requirement: Chat degradation and observe-only

Chat MUST be disabled with a clear message when no key is configured, MUST be disabled while the probe is not attached, MUST surface OpenRouter errors without blocking the game or crashing, and MUST remain observe-only (it never issues input to the game).

#### Scenario: Chat without a key
- **WHEN** no OpenRouter key is configured
- **THEN** the chat input is disabled with a message to set the key, and capture continues

#### Scenario: Chat while probe detached
- **WHEN** the probe is not attached to an Agricola table
- **THEN** the chat input is disabled and the placeholder reads "Reconnecting to game…"; sending is not attempted

#### Scenario: Chat error is non-blocking
- **WHEN** a chat request errors or times out
- **THEN** the error is shown in the chat, capture continues, and the game is unaffected
