## ADDED Requirements

### Requirement: Decision-driven settle window

The MAIN-world probe SHALL emit a briefing only when (a) the gate (see `decision-gate`) confirms a genuine decision is available AND (b) probe events have been silent for an **idle window** (default ~800 ms) OR a **hard cap** has elapsed since the decision arrived (default ~2.5 s — whichever fires first). The probe MUST NOT emit a briefing on every gamestate transition, MUST NOT emit on a periodic freshness timer, and MUST distill `gameui.gamedatas` **in place** (no clone) at emit time.

#### Scenario: Settle emits once after idle
- **WHEN** the user's turn arrives at a real decision and no probe event occurs for the full idle window
- **THEN** the probe distills in place and emits exactly one `briefing` message

#### Scenario: Burst resets settle but cap fires
- **WHEN** probe events arrive continuously (resetting the idle window) past the hard cap
- **THEN** the probe emits exactly one `briefing` at the cap, marked with reason `cap`

#### Scenario: Non-decision transition does not start settle
- **WHEN** the gamestate transitions to a state where the gate returns `false` (e.g. confirmTurn, genericNextPlayer, opponent turn)
- **THEN** no settle starts and no `briefing` is emitted

### Requirement: Probe runtime diet

The probe MUST NOT perform expensive work on BGA's render thread on a continuous schedule. Specifically: no per-notification `structuredClone` of `gamedatas`; no periodic timer that distills or clones `gamedatas`; the only heavy operation is `distill()` at settle emit. Notification posts to the content script SHALL remain lightweight (name + args + channel + timestamp; no `gamedatas`).

#### Scenario: No periodic heavy work
- **WHEN** the game is in progress and it is not the user's decision
- **THEN** the probe issues no `distill` calls and no `cloneGd` calls on its periodic boot poll (only cheap `gameui.gamedatas.gamestate` property reads)

#### Scenario: Per-notification post stays lightweight
- **WHEN** any BGA notification fires
- **THEN** the probe posts a notification message without a paired `gamedatas` clone

### Requirement: Settle state is reset on probe detach / SPA navigation

When the probe detects it has navigated away from an Agricola table (`detachIfNavigatedAway`), it MUST clear the in-progress settler state and any internal notification buffer so that a subsequent attach starts from a clean state.

#### Scenario: SPA-nav mid-settle
- **WHEN** the user navigates to a different table while a settle window is open
- **THEN** the settler is reset and no `briefing` is emitted for the previous table

### Requirement: On-demand fresh briefing for chat

The probe SHALL accept an inverse `request-briefing` message from the content script (over a distinct envelope tag) and reply with one freshly-distilled `briefing` reflecting the current `gameui.gamedatas` at that instant. If `gameui.gamedatas` is unreadable, the probe MUST reply with a `briefing-error` and MUST NOT throw.

#### Scenario: Chat triggers fresh briefing
- **WHEN** the content script sends a `request-briefing` message
- **THEN** the probe distills in place and posts one `briefing` (or `briefing-error` if unreadable)

### Requirement: Diagnostic visibility

The probe SHALL emit:
- a `briefing-error` message (debounced per reason) when `distill()` returns `{ok: false}`, so the content script can surface "advisor cannot read state yet" to the user; and
- `metric` messages (`name`, `value`) for `distill-ms`, `settle-duration-ms`, `notifs-per-settle`, so timing of the hot path is observable in the Events panel.

#### Scenario: Distill failure surfaces
- **WHEN** distill returns `{ok:false}` during a settle emit
- **THEN** a `briefing-error` is posted (debounced) and no `briefing` is posted for that emit
