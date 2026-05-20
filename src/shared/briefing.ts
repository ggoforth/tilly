// The LLM contract. The state distiller is the only code that knows BGA's
// `gamedatas` shape; everything downstream (advisor, chat) depends only on
// PositionBriefing. Keep concrete; bump BRIEFING_SCHEMA on shape changes.

export const BRIEFING_SCHEMA = 1;

export interface CardView {
  id: string;
  name: string;
  /** "occupation" | "minor" | "major" */
  kind: string;
  /** verbatim card rules text */
  rulesText: string;
  /** cost summary, e.g. "2 wood", when present in gamedatas */
  cost?: string;
  /** e.g. "2 Occupations", when the card has a prerequisite */
  prerequisite?: string;
}

export interface PlayerView {
  resources: Record<string, number>; // wood, clay, reed, stone, food, grain, veg
  /** TOTAL animals owned by this player (housed on farm PLUS unplaced in
   *  supply). Use this for "do they own sheep?" questions. To know what's
   *  available to act on RIGHT NOW (cook, trade, exchange), use
   *  `unplacedAnimals` below — those are the ones not yet committed to the
   *  farm board. */
  animals: Record<string, number>; // sheep, boar, cattle (total)
  /** Animals currently in supply (unplaced — not yet housed in
   *  pasture/room/stable). These are the ONLY animals available to cook on
   *  a Fireplace/Cooking Hearth or trade away. Once placed they're
   *  committed to the farm and counted in `animals` but not here. */
  unplacedAnimals: Record<string, number>; // sheep, boar, cattle (supply only)
  farm: {
    rooms: number;
    roomType: string;
    fields: number;
    pastures: number;
    stables: number;
    fencedSpaces: number;
    emptySpaces: number;
    /** Rooms NOT currently occupied by a family member (`rooms - family.people`,
     *  floored at 0). Driver for family-growth advice: regular Wish for
     *  Children requires `emptyRooms > 0`. Computed in distill so the LLM
     *  doesn't have to do the subtraction (it has been getting it wrong). */
    emptyRooms: number;
    /** Can the player currently afford to build ONE new room?
     *  Pre-computed: resources[roomType] >= 5 AND resources.reed >= 2.
     *  The LLM has repeatedly recommended "build a room" without checking
     *  reed; this flag lets it read the answer instead of doing arithmetic. */
    canBuildRoom: boolean;
    /** Can the player currently afford to build ONE stable?
     *  Pre-computed: resources.wood >= 2 (standard) — Beginner variant uses
     *  1 wood but we use the conservative 2-wood check. */
    canBuildStable: boolean;
    /** Can the player currently afford at least ONE fence segment?
     *  Pre-computed: resources.wood >= 1. Useful as a quick gate before
     *  recommending Fencing actions. */
    canBuildFence: boolean;
  };
  family: { people: number; canGrow: boolean };
  /** me only — your playable occupations + minor improvements */
  hand?: CardView[];
  /** occupations / improvements already in play */
  played: CardView[];
  /** Action-space NAMES this player has farmers on RIGHT NOW. Derived from
   *  `meeples[i].location` matching an Action* card id, so it's correct even
   *  on a mid-round probe attach (no notification history required). Empty
   *  between Returning Home and the next placement. The advisor should treat
   *  these as "you have already acted here this round; do not suggest them". */
  placedFarmersThisRound: string[];
  score?: number;
}

export interface ActionSpace {
  id: string;
  name: string;
  /** accumulated goods summary, if any */
  goods?: string;
  /** "me" | "Opponent N" | undefined */
  takenBy?: string;
}

/** Harvest-planning snapshot — pre-computed so the LLM doesn't have to do
 *  the "rounds remaining × food per person − inventory" arithmetic that it
 *  has reliably failed under pressure (sending the player into harvests
 *  empty-handed). Computed in distill from `round` + `me.family.people` +
 *  `me.resources.food`. Conservative: every family member counted at the
 *  adult feeding rate (2 food), no fields/animals "projected" yield — this
 *  is the BASELINE shortfall assuming no further food actions. */
export interface HarvestPlan {
  /** The round number of the NEXT harvest (one of 4, 7, 9, 11, 13, 14), or
   *  null if the final harvest has already passed. */
  nextHarvestRound: number | null;
  /** Whole rounds from current → next harvest. 0 means the current round
   *  IS the harvest round. */
  roundsUntilHarvest: number | null;
  /** Food the family needs at the NEXT harvest assuming all current
   *  members eat at the adult rate (= 2 × family.people). Newborn discount
   *  intentionally not applied — conservative bias. */
  foodNeededAtNextHarvest: number;
  /** max(0, foodNeededAtNextHarvest − me.resources.food). >0 means a gap
   *  the player must close before that harvest fires. */
  foodShortfall: number;
}

export interface PositionBriefing {
  schemaVersion: number;
  round: number;
  phase: string; // e.g. "work", "harvest", "draft"
  isMyTurn: boolean;
  legalActions: string[]; // from gamedatas.gamestate.possibleactions
  decisionPrompt?: string; // gamestate description, if present
  /** Pre-computed harvest plan for the active player. See HarvestPlan above. */
  harvest: HarvestPlan;
  me: PlayerView;
  /** handle-stripped; identified only by array position ("Opponent 1" = [0]) */
  opponents: PlayerView[];
  actionBoard: ActionSpace[];
  /** shared board — major improvements still buildable by anyone */
  availableMajorImprovements: CardView[];
  /** cards still draftable, during the draft phase only */
  draftPool?: CardView[];
}

/** Result of distillation: either a briefing, or a non-fatal "cannot". */
export type DistillResult =
  | { ok: true; briefing: PositionBriefing }
  | { ok: false; reason: string };
