## ADDED Requirements

### Requirement: Action-shape decision gate

A pure module SHALL determine whether a `PositionBriefing` represents a genuine, advisable decision based on the **shape of the legal actions** rather than a hard-coded list of gamestate names. The gate MUST return `true` only when `briefing.isMyTurn === true` AND the briefing's `legalActions`, after removing trivial actions (`actConfirmTurn`, `actRestart`, `actPassOptionalAction`), is non-empty. It MUST NOT depend on `gamestate.name`. The module MUST be importable and tested from both probe and content contexts (no DOM / no chrome.* dependencies).

#### Scenario: Real decision returns true
- **WHEN** the briefing is `isMyTurn: true` with `legalActions: ['actPlaceFarmer', 'actPassOptionalAction', 'actRestart']`
- **THEN** the gate returns `true`

#### Scenario: Trivial-only returns false
- **WHEN** the briefing is `isMyTurn: true` with `legalActions: ['actConfirmTurn', 'actRestart']`
- **THEN** the gate returns `false`

#### Scenario: Not my turn returns false
- **WHEN** `briefing.isMyTurn === false` (regardless of legalActions)
- **THEN** the gate returns `false`

#### Scenario: Coverage across observed corpus
- **WHEN** parameterized over every distinct `gamestate.name` that appears in `observed-games/*.json` with `isMyTurn && non-trivial legalActions`
- **THEN** the gate returns `true` for each one (regression-protects against silent exclusion of game phases)

### Requirement: Stable decision identifier (dedupe key)

A pure module SHALL produce a deterministic `decisionKey(briefing): string` that is **stable across mid-decision churn** but **distinct across two real consecutive decisions** (including in solo play where `activePlayerId` is unchanged between placements). The key MUST be derived from: gamestate name, gamestate id, round, active-player id, and the sorted `legalActions`. It MUST NOT depend on values that mutate optimistically before user confirmation (e.g. board-occupancy counts) and MUST NOT conflate household size with "placed this round".

#### Scenario: Same briefing yields same key
- **WHEN** `decisionKey(b)` is called twice on the same briefing object
- **THEN** the two strings are equal

#### Scenario: Different gamestate id yields different key
- **WHEN** two briefings differ only in `gamestate.id` (same name, same round, same actions, same active player)
- **THEN** their keys are different

#### Scenario: Consecutive solo placements differentiate
- **WHEN** two consecutive `placeFarmer` decisions in solo (same `activePlayerId`, same round) arrive with distinct `gamestate.id` values
- **THEN** their keys are different (so advice re-fires on the second placement)
