// Pure dedupe-key module. Identifies a distinct decision instance so the
// advisor fires exactly once per real decision but not on mid-decision churn.
//
// Key components (architect's review, hardened from v1):
//   - gamestate.name      — what kind of decision is in play
//   - gamestate.id        — distinct instance counter; increments per real
//                           decision even when name/round/actions are equal
//                           (THIS is what makes solo placements re-fire)
//   - round               — bumps once per game round
//   - activePlayerId      — flips on opponent turns (multiplayer); always you
//                           in solo (then gamestate.id carries the load)
//   - sorted(legalActions) — what choices are on the table (changes per real
//                           sub-decision within a multi-step turn)
//
// Explicitly NOT in the key (and why):
//   - actionBoard occupancy: BGA renders optimistic state before user confirms,
//     so the count can flip mid-decision, which would re-fire wrongly.
//   - briefing.me.family.people: this is HOUSEHOLD SIZE, not people-placed
//     this round. v1 conflated the two; not a useful discriminator.

import type { PositionBriefing } from './briefing';

export interface DecisionContext {
  /** From `gamedatas.gamestate.id` — increments per real decision instance. */
  gamestateId: string | number;
  /** From `gamedatas.gamestate.name` — kind of decision. */
  gamestateName: string;
  /** From `gamedatas.gamestate.active_player`, stringified. */
  activePlayerId: string;
}

export function decisionKey(
  briefing: PositionBriefing,
  ctx: DecisionContext,
): string {
  const acts = [...briefing.legalActions].sort().join(',');
  return [
    ctx.gamestateName,
    String(ctx.gamestateId),
    String(briefing.round),
    ctx.activePlayerId,
    acts,
  ].join('|');
}
