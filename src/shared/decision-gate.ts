// Action-shape decision gate. Pure module. Used by both the MAIN-world probe
// (to decide whether to start a settle window) and the isolated content script
// (to decide whether a received briefing should produce advice). It MUST NOT
// depend on `gamestate.name` — a whitelist of names silently excludes new
// phases that BGA may rename or add. The shape of legalActions is the source
// of truth.

import type { PositionBriefing } from './briefing';

/**
 * Legal actions that are framework chrome (confirm / restart / pass-optional)
 * rather than a meaningful player choice. A briefing whose legalActions are
 * entirely in this set is not worth advising on.
 */
export const TRIVIAL_ACTIONS: ReadonlySet<string> = new Set([
  'actConfirmTurn',
  'actRestart',
  'actPassOptionalAction',
]);

export function isMeaningfulDecision(briefing: PositionBriefing): boolean {
  if (!briefing.isMyTurn) return false;
  const acts = briefing.legalActions;
  if (!Array.isArray(acts) || acts.length === 0) return false;
  for (const a of acts) if (!TRIVIAL_ACTIONS.has(a)) return true;
  return false;
}

/**
 * Gamestate names where the decision is mechanical/forced — the player
 * already committed to the action on the prior placement and BGA is just
 * walking them through the resolution clicks. Auto-advice on these is noise
 * (verified live: post-Farmland "plow a field" bubble that just echoes the
 * placement decision the user already made). The probe STILL distills and
 * emits a briefing for these states so chat-on-demand stays fresh — we just
 * suppress the AUTO-advice trigger on the content side.
 *
 * Strategic sub-decisions stay UNGATED here (construct, improvement,
 * occupation, sow, exchange, payResources, resolveChoice, fencing-layout,
 * etc.) because those still warrant input even though they followed a
 * placement.
 */
export const MECHANICAL_GAMESTATES: ReadonlySet<string> = new Set([
  'plow',
  'reorganize',
  'gainResources',
  'collectResources',
  'placeFutureMeeples',
  'harvestCrop',
  'reapCrops',
]);

/**
 * Auto-advice gate: only fire when the user is at a true TOP-LEVEL
 * placement decision (`legalActions` contains `actPlaceFarmer`). All
 * sub-states — Build Room vs Stables, choose Major, Sow grain, pay
 * resources, exchange animals, plow location, etc. — are silenced from
 * auto-advice. The user can still ask in chat for input on those, and
 * the probe still distills a fresh briefing for chat freshness.
 *
 * Rationale (live observation): once the user has committed to an action
 * by placing a farmer, the multi-step sub-decisions BGA walks them through
 * generated noisy / context-confused auto-advice bubbles ("Grab Fireplace
 * for 2 clay" while user is mid-Farm-Expansion). Filtering on
 * actPlaceFarmer makes the advisor fire exactly once per placement, which
 * matches the user's mental model of "one decision = one piece of advice."
 *
 * Mechanical gamestate names (plow/reorganize/etc.) stay in the filter as
 * a belt-and-suspenders second gate.
 */
export function isStrategicDecision(
  briefing: PositionBriefing,
  gamestateName: string,
): boolean {
  if (!isMeaningfulDecision(briefing)) return false;
  if (MECHANICAL_GAMESTATES.has(gamestateName)) return false;
  if (!briefing.legalActions.includes('actPlaceFarmer')) return false;
  return true;
}
