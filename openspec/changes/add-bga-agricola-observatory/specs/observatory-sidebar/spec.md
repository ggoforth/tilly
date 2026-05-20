## ADDED Requirements

### Requirement: Sidebar injection

The extension SHALL inject a sidebar panel into BGA Agricola tables using a Shadow DOM so its styles are isolated from the page. The sidebar MUST NOT obscure or interfere with game controls and MUST be collapsible.

#### Scenario: Sidebar appears on an Agricola table
- **WHEN** the user opens a BGA Agricola table
- **THEN** the observatory sidebar is mounted in an isolated Shadow DOM without altering BGA's own layout or controls

#### Scenario: Sidebar is collapsible
- **WHEN** the user collapses the sidebar
- **THEN** the panel hides without stopping telemetry capture

### Requirement: Live event feed

The sidebar SHALL display a live, scrolling feed of captured events showing at minimum the timestamp, event kind, and a short summary (e.g. notification name or gamestate name), updating as events are captured.

#### Scenario: Feed updates on capture
- **WHEN** a notification or gamestate event is captured
- **THEN** a corresponding row appears in the sidebar feed in capture order

#### Scenario: Turn highlighted
- **WHEN** a gamestate event with `isMyTurn: true` is captured
- **THEN** the feed visibly emphasizes that it is the local user's turn

### Requirement: Health and probe status display

The sidebar SHALL continuously display the current tri-state health (`healthy`/`degraded`/`unhealthy`) and an explicit probe attached/not-attached indicator, so the user can confirm capture is working during a game.

#### Scenario: Health is always visible
- **WHEN** the health status changes
- **THEN** the sidebar updates its health indicator to the new state with a human-readable reason

#### Scenario: Probe detachment is visible
- **WHEN** the probe is not attached
- **THEN** the sidebar clearly shows a not-attached state rather than appearing idle

### Requirement: Capture controls

The sidebar SHALL provide controls to start/stop capture, toggle screenshots, export the session log as JSON, and clear the stored log.

#### Scenario: Export from the sidebar
- **WHEN** the user clicks the export control
- **THEN** the full session log is downloaded as a JSON file

#### Scenario: Screenshot toggle reflected in capture
- **WHEN** the user enables the screenshot toggle
- **THEN** subsequent key-moment screenshots are captured and referenced in the feed

### Requirement: Sidebar shows data only, never advice

The sidebar SHALL present captured telemetry only. It MUST NOT display move recommendations, strategy suggestions, or any AI-generated content in this change.

#### Scenario: No recommendations rendered
- **WHEN** it is the local user's turn and a decision point is captured
- **THEN** the sidebar shows the captured state/options as data and renders no recommended move
