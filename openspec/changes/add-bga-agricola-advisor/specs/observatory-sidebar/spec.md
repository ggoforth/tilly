## MODIFIED Requirements

### Requirement: Sidebar injection

The extension SHALL inject a sidebar panel into BGA Agricola tables using a Shadow DOM so its styles are isolated from the page. The sidebar SHALL be **docked** to the side of the viewport and **open by default**, occupying a reserved gutter (the extension adjusts the page's available width so the panel never overlays or obscures the game board or controls). It MAY be collapsible, but its default state is open and docked, not a closable overlay.

#### Scenario: Sidebar is docked beside the table, not overlaying it
- **WHEN** the user opens a BGA Agricola table
- **THEN** the panel is mounted in an isolated Shadow DOM, docked to the side and open, with the page laid out so the panel does not cover the board or controls

#### Scenario: Stays open across play
- **WHEN** the game progresses and notifications/turns occur
- **THEN** the panel remains open and docked without the user having to reopen it, and telemetry capture is unaffected

#### Scenario: Optional collapse does not stop capture
- **WHEN** the user collapses the panel (if a collapse control is provided)
- **THEN** the panel hides, the reserved gutter is released, and telemetry capture continues

## ADDED Requirements

### Requirement: Three-phase advisor indicator

The sidebar SHALL convey a distinct phase for the advisor on each real decision so the user can tell whether the advisor saw their turn. Phases: `idle`, `reading` (settle window active — "reading position…" with a faint pulse and an optional burst-event counter; no agent bubble yet), `thinking` (settle ended, briefing locked, request in flight; agent bubble appears with the immutable `seen:` stamp), `streaming` (chunks arriving into the in-flight bubble), `error`.

#### Scenario: Reading shows during settle
- **WHEN** a real decision arrives and the probe's settle window is open
- **THEN** the sidebar shows a "reading position…" indicator and does not yet show an empty agent bubble

#### Scenario: Stamp appears at end of settle
- **WHEN** the settle window completes and the briefing is locked
- **THEN** an agent bubble is appended carrying the `seen:` stamp derived from that briefing

### Requirement: Incremental streaming render

The sidebar MUST update only the in-flight agent message during token streaming, mutating that message's text content rather than rebuilding the full transcript on every chunk. Append-only feed entries and per-event telemetry MUST not re-render the entire transcript.

#### Scenario: Streaming does not rebuild transcript
- **WHEN** chunks arrive into an in-flight advice message
- **THEN** only that message's bubble text is updated; prior transcript entries are not recreated

### Requirement: Stick-to-bottom autoscroll

The transcript SHALL stick to the bottom only when the user is already near the bottom (within ~40 px). If the user has scrolled up, new content MUST NOT yank the view; instead a "New ↓" affordance MUST appear and bring the view to the bottom on click.

#### Scenario: Stick when at bottom
- **WHEN** new content arrives while the user is at the bottom of the transcript
- **THEN** the transcript scrolls to keep the new content visible

#### Scenario: Don't yank when scrolled up
- **WHEN** new content arrives while the user has scrolled up to re-read earlier content
- **THEN** the view does not jump; a "New ↓" affordance appears

### Requirement: Supersede UX for partial advice

When an in-flight advice request is aborted because a genuinely new decision arrived, a message that already had partial streamed content MUST be marked superseded (visually dimmed, with a clear marker), and the new advice MUST appear as a fresh message immediately after. An in-flight advice message with no streamed content yet MAY be removed silently.

#### Scenario: Partial advice superseded
- **WHEN** an in-flight advice has streamed some text and is then aborted by a new decision
- **THEN** the message is marked as superseded (dimmed, "(superseded — new advice below)") and the new advice begins as a separate message

#### Scenario: Empty bubble removed silently
- **WHEN** an in-flight advice with no streamed content yet is aborted
- **THEN** the empty bubble is removed without trace and the new advice begins fresh

### Requirement: Persistent set-key affordance

When the advisor is disabled (no OpenRouter key), the sidebar MUST surface a clearly visible "Set OpenRouter key" affordance regardless of whether the transcript is empty or already contains messages — not only in the empty-state CTA.

#### Scenario: Disabled mid-game
- **WHEN** the user removes the key while a transcript already exists
- **THEN** a persistent banner with a "Set OpenRouter key" button appears above the input (in addition to disabling the input), and the existing transcript stays visible
