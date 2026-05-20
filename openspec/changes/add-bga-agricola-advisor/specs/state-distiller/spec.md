## ADDED Requirements

### Requirement: Pure snapshot-to-briefing transformation

The system SHALL provide a pure function that converts a captured `gamedatas` snapshot into a `PositionBriefing`. It MUST be deterministic (same input → same output), MUST NOT perform I/O, network, or DOM access, and MUST be importable and testable in isolation.

#### Scenario: Deterministic and pure
- **WHEN** the distiller is called twice with the same snapshot
- **THEN** it returns deeply-equal briefings and performs no I/O

#### Scenario: Real captured snapshot
- **WHEN** the distiller is given a real snapshot fixture extracted from `observed-games/`
- **THEN** it returns a `PositionBriefing` with the correct round, phase, `isMyTurn`, and a non-empty `legalActions` for a decision-point snapshot

### Requirement: Briefing content completeness

The briefing SHALL include the user's resources, animals, farm summary, family, hand (the user's only) and played cards, an opponent summary, the action board with accumulated goods, the legal action list taken from `gamedatas.gamestate.possibleactions`, the shared **available major improvements** board, and — during the draft phase — the **draft pool**. Every card (hand, played, available majors, draft pool) MUST carry verbatim `rulesText` and, when present in `gamedatas`, its `cost` and `prerequisite`.

#### Scenario: Hand carries rules text
- **WHEN** the user has cards in hand in the snapshot
- **THEN** each `CardView` includes `name`, `kind`, and non-empty `rulesText`

#### Scenario: Available major improvements present
- **WHEN** major improvements remain buildable on the shared board
- **THEN** `availableMajorImprovements` lists them as `CardView`s with rules text (and cost when present), distinct from the user's hand

#### Scenario: Draft pool during draft phase
- **WHEN** the snapshot is in the draft phase with cards still draftable
- **THEN** `draftPool` lists the remaining draftable cards as `CardView`s with rules text

#### Scenario: Legal actions extracted
- **WHEN** the snapshot's gamestate has `possibleactions`
- **THEN** `legalActions` equals that list

### Requirement: Opponent handle stripping (privacy)

Opponents MUST be represented as an ordered array of `PlayerView` with no name/handle field; an opponent is identified only by array position ("Opponent N" = `opponents[N-1]`). No opponent BGA handle may appear anywhere in the briefing.

#### Scenario: No opponent handles leak
- **WHEN** a snapshot with named opponents is distilled
- **THEN** the briefing contains no opponent BGA handle and opponents are identified solely by their position in the `opponents` array

### Requirement: Malformed input is non-fatal

If a snapshot is missing expected structure, the distiller MUST signal "cannot distill" (a typed result the caller can skip on) and MUST NOT throw.

#### Scenario: Missing structure
- **WHEN** the distiller receives a snapshot lacking `gamestate`/`players`
- **THEN** it returns a cannot-distill result and does not throw
