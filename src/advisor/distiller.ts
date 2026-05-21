// Pure: BGA `gamedatas` snapshot -> PositionBriefing. The ONLY place that knows
// BGA's gamedatas shape. No I/O, no globals, no DOM. Malformed input is
// non-fatal (returns ok:false, never throws).

import type {
  CardView,
  DistillResult,
  HarvestPlan,
  PlayerView,
  PositionBriefing,
} from '../shared/briefing';
import { BRIEFING_SCHEMA } from '../shared/briefing';

/** Rounds in a 14-round Agricola game that fire a Harvest after the Work
 *  phase concludes. Used by `computeHarvestPlan` to project "how many
 *  rounds until next feeding" and the food gap. */
const HARVEST_ROUNDS: ReadonlyArray<number> = [4, 7, 9, 11, 13, 14];

/** Pre-compute the next-harvest food check the LLM has reliably failed to
 *  do under pressure. Pure / unit-testable. */
export function computeHarvestPlan(
  round: number,
  people: number,
  food: number,
): HarvestPlan {
  let nextHarvestRound: number | null = null;
  for (const h of HARVEST_ROUNDS) {
    if (h >= round) {
      nextHarvestRound = h;
      break;
    }
  }
  const roundsUntilHarvest =
    nextHarvestRound != null ? Math.max(0, nextHarvestRound - round) : null;
  // Conservative: every family member eats 2 food. Newborns this round would
  // pay only 1 but counting them at 2 errs on the cautious-planning side.
  const foodNeededAtNextHarvest = Math.max(0, people) * 2;
  const foodShortfall = Math.max(0, foodNeededAtNextHarvest - Math.max(0, food));
  return { nextHarvestRound, roundsUntilHarvest, foodNeededAtNextHarvest, foodShortfall };
}

type Any = Record<string, any>;

const stripHtml = (s: string): string =>
  s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function rulesTextOf(card: Any): string {
  if (Array.isArray(card.desc) && card.desc.length) {
    return card.desc.map((d: unknown) => String(d)).join(' ').trim();
  }
  if (typeof card.description === 'string' && card.description.trim()) {
    return stripHtml(card.description);
  }
  if (Array.isArray(card.tooltip) && card.tooltip.length) {
    return card.tooltip.map((d: unknown) => String(d)).join(' ').trim();
  }
  return String(card.name ?? card.id ?? '').trim();
}

function costOf(card: Any): string | undefined {
  if (typeof card.costText === 'string' && card.costText.trim()) {
    return card.costText.trim();
  }
  const parts: string[] = [];
  const costs = card.costs;
  if (Array.isArray(costs)) {
    for (const c of costs) {
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        for (const [k, v] of Object.entries(c)) parts.push(`${v} ${k}`);
      }
    }
  }
  return parts.length ? parts.join(', ') : undefined;
}

function toCardView(card: Any): CardView {
  const view: CardView = {
    id: String(card.id ?? ''),
    name: String(card.name ?? ''),
    kind: String(card.type ?? card.category ?? ''),
    rulesText: rulesTextOf(card),
  };
  const cost = costOf(card);
  if (cost) view.cost = cost;
  if (card.prerequisite) view.prerequisite = String(card.prerequisite);
  return view;
}

function numericRecord(o: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o as Any)) {
      if (typeof v === 'number') out[k] = v;
    }
  }
  return out;
}

function farmOf(player: Any, playerScores: Any): PlayerView['farm'] {
  const board = (player.board ?? {}) as Any;
  const zones: Any[] = Array.isArray(board.dropZones) ? board.dropZones : [];
  const roomZones = zones.filter((z) => z.type === 'room');
  const rooms = roomZones.reduce(
    (n, z) => n + (Array.isArray(z.locations) ? z.locations.length : 0),
    0,
  );
  // Pastures: read the live `board.pastures` array (one entry per built
  // pasture, with nested nodes/stables). The dropZones array also tends to
  // carry `type='pasture'` entries that mirror this, but they represent
  // drop TARGETS not built pastures — verified against the developed-farm
  // fixture (5 built pastures = 5 pasture dropZones in that snapshot, but
  // the relationship isn't guaranteed in earlier game states). board.pastures
  // is the canonical source.
  const pastures = Array.isArray(board.pastures) ? board.pastures.length : 0;
  // Stables: BGA stores them nested inside dropZones (each `type='stable'`
  // zone is a drop target; built stables live in z.stables on the relevant
  // zones). Cross-checked against scores.<pid>.stables.entries[0].quantity:
  // the midwork fixture has 2 type='stable' drop zones but 0 built stables,
  // and z.stables is empty on each — the reduce correctly returns 0.
  const stables = zones.reduce(
    (n, z) => n + (Array.isArray(z.stables) ? z.stables.length : 0),
    0,
  );
  const fences = Array.isArray(board.fences) ? board.fences.length : 0;
  // Fields: BGA does NOT include `type='field'` entries in dropZones — even
  // in a developed-farm snapshot with 5 plowed fields, dropZones contains
  // only room + pasture entries. The authoritative count lives at
  // gd.scores[pid].fields.entries[0].quantity (live, updated as fields are
  // plowed). Was previously read as `zones.filter(z=>z.type==='field')`
  // which silently always returned 0 — undetected because no fixture
  // exercised a developed farm. The developed-farm.gamedatas.json fixture
  // now covers this regression.
  const fields =
    Number(playerScores?.fields?.entries?.[0]?.quantity) || 0;
  return {
    rooms,
    roomType: String(roomZones[0]?.roomType ?? player.color_back ?? 'wood'),
    fields,
    pastures,
    stables,
    fencedSpaces: fences,
    emptySpaces: 0,
    // Filled in by playerView once we know the family size and effective resources.
    emptyRooms: 0,
    canBuildRoom: false,
    canBuildStable: false,
    canBuildFence: false,
  };
}

/** Friendly display name for an action-card id (e.g. "ActionForest" → "Forest").
 *  Falls back to the id with the leading "Action" stripped if no card object
 *  is available — never returns an empty string. */
function actionCardDisplayName(id: string, cardById: Map<string, Any>): string {
  const card = cardById.get(id);
  if (card?.name && typeof card.name === 'string') return card.name;
  return id.startsWith('Action') ? id.slice('Action'.length) : id;
}

/** All farmer meeples placed on action spaces (not on a player's farm board
 *  and not in the reserve), grouped by player id. BGA stores placement as
 *  `meeple.location === "ActionForest"` (etc.) — `cards.visible[].pId` is
 *  ALWAYS null in Agricola, so this is the only source of truth for occupancy. */
function placedFarmersByPlayer(gd: Any): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const meeples: Any[] = Array.isArray(gd.meeples) ? gd.meeples : [];
  for (const m of meeples) {
    if (m?.type !== 'farmer') continue;
    const loc = typeof m.location === 'string' ? m.location : '';
    // 'board' = on player farm; 'reserve' = unused. Anything else is an
    // action-space id (e.g. "ActionForest", "ActionLessons"). The schema
    // doesn't prefix-encode it formally, but Agricola's pattern is "Action*".
    if (!loc || loc === 'board' || loc === 'reserve') continue;
    const pid = m.pId != null ? String(m.pId) : '';
    if (!pid) continue;
    const arr = out.get(pid) ?? [];
    arr.push(loc);
    out.set(pid, arr);
  }
  return out;
}

/** When the probe provides a tracker, rebuild the per-player card-id list
 *  from it. Mirrors the structure of `placedFarmersByPlayer` so the rest of
 *  the distiller is source-agnostic. */
function placedFromTracker(
  tracked: ReadonlyMap<string, TrackedPlacement>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [cardId, p] of tracked) {
    const arr = out.get(p.pId) ?? [];
    arr.push(cardId);
    out.set(p.pId, arr);
  }
  return out;
}

/** Effective resources for a player = `gd.players[pid].resources` (the
 *  formally-transferred cache) PLUS goods sitting on action cards they're
 *  placed on. Mirrors what BGA's UI shows — verified live against
 *  `#resource_<pid>_clay` text vs. the raw cache (cache=0, display=3 when 3
 *  clay sit unclaimed on a Clay Pit you've taken). The accumulator pile
 *  hasn't been moved to your reserve yet, but it's effectively yours. */
function effectiveResourcesFor(
  cache: Record<string, number>,
  myPlacedCards: ReadonlyArray<string>,
  accumByCard: Map<string, Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...cache };
  for (const cardId of myPlacedCards) {
    const pile = accumByCard.get(cardId);
    if (!pile) continue;
    for (const [t, n] of Object.entries(pile)) {
      out[t] = (out[t] ?? 0) + n;
    }
  }
  return out;
}

function playerView(
  gd: Any,
  player: Any,
  includeHand: boolean,
  cardById: Map<string, Any>,
  placedByPlayer: Map<string, string[]>,
  accumByCard: Map<string, Record<string, number>>,
  trackedPlacements?: ReadonlyMap<string, TrackedPlacement>,
  liveResources?: LiveResourceMap,
): PlayerView {
  const cache = numericRecord(player.resources);
  const placementIds = placedByPlayer.get(String(player.id)) ?? [];
  // Canonical source: live DOM if the probe was able to scrape it. This is
  // the only field BGA updates atomically with its `notif_*` handlers (cache
  // lags both credits and debits). Fall back to the cache+pile derivation if
  // the scrape missed this player.
  // EXCEPTION: fence/stable. The DOM `#resource_<pid>_fence/stable` counts
  // ALREADY-BUILT structures; `cache.fence/stable` counts REMAINING stockpile
  // to build with. The advisor needs the latter — keep cache for these.
  const live = liveResources?.get(String(player.id));
  const res = live
    ? { ...effectiveResourcesFor(cache, placementIds, accumByCard), ...live }
    : effectiveResourcesFor(cache, placementIds, accumByCard);
  if (live) {
    for (const t of RESOURCE_TYPES_KEEP_CACHE) {
      res[t] = cache[t] ?? 0;
    }
  }
  const farm = farmOf(player, gd.scores?.[player.id]);
  const people = Array.isArray(gd.meeples)
    ? gd.meeples.filter(
        (m: Any) =>
          m?.type === 'farmer' &&
          String(m.pId) === String(player.id) &&
          m.location !== 'reserve',
      ).length
    : 0;
  // Pre-compute empty rooms (rooms - people, floored at 0). Surfacing this
  // explicitly stops the LLM from inventing rules to justify a family-growth
  // recommendation when no empty room exists ("no empty room needed in
  // beginner mode" — a hallucinated rule observed in v0.2.0.44 traces).
  farm.emptyRooms = Math.max(0, farm.rooms - people);

  // Pre-compute affordability flags. The LLM has reliably failed to do the
  // "do I have enough resources?" check (e.g. recommending Build a wood room
  // with 1 reed when 2 is required). Reading a boolean removes the burden.
  // Room cost: 5 of current roomType + 2 reed. Stable cost: 2 wood (Beginner
  // is 1 wood — we use the safer 2-wood threshold to avoid false-positives).
  // Fence: 1 wood per segment.
  const wood = res.wood ?? 0;
  const reed = res.reed ?? 0;
  const matCount = res[farm.roomType] ?? 0;
  farm.canBuildRoom = matCount >= 5 && reed >= 2;
  farm.canBuildStable = wood >= 2;
  farm.canBuildFence = wood >= 1;
  // Animal totals. `total` = all animals the player owns (reserve + farm
  // board); `unplaced` = in supply, available to act on now (cook / trade /
  // exchange). Both surfaced so the LLM doesn't conflate "do you own
  // sheep?" with "do you have sheep available to cook?".
  //
  // Live DOM counters (`#resource_<pid>_sheep` etc.) are the canonical
  // source — BGA updates them synchronously from notif_* handlers, while
  // gd.meeples is stale (verified: user reported 2 sheep on board, briefing
  // line said `sh0` because all sheep meeples for that player still had
  // location='reserve' or location='Sheep Market' in the gamedatas snapshot).
  // Fall back to the meeple scan if liveResources missed this player
  // (e.g. opponent panel not yet rendered).
  const meepleAnimalCount = (
    meepleType: 'sheep' | 'pig' | 'cattle',
    placedOnly: boolean,
  ): number =>
    Array.isArray(gd.meeples)
      ? gd.meeples.filter((m: Any) => {
          if (m?.type !== meepleType) return false;
          if (String(m.pId) !== String(player.id)) return false;
          if (placedOnly) return m.location === 'board';
          return m.location === 'reserve' || m.location === 'board';
        }).length
      : 0;
  const liveAnimal = (t: 'sheep' | 'pig' | 'cattle'): number | undefined => {
    const v = live?.[t];
    return typeof v === 'number' ? v : undefined;
  };
  const totalSheep = liveAnimal('sheep') ?? meepleAnimalCount('sheep', false);
  const totalPig = liveAnimal('pig') ?? meepleAnimalCount('pig', false);
  const totalCattle = liveAnimal('cattle') ?? meepleAnimalCount('cattle', false);
  // `unplaced` = sheep in player's reserve (not yet placed on farm). Derived
  // from meeples-with-location='reserve', which can be stale on the same
  // notification beat where `total` (from live DOM) updates first. The
  // clamp to [0, total] keeps the pair internally consistent: if the
  // stale reserve count exceeds the fresh total, we cap it. This is a
  // best-effort signal; the LLM should treat `total` as authoritative
  // and `unplaced` as approximate.
  const meepleReserve = (t: 'sheep' | 'pig' | 'cattle') =>
    Array.isArray(gd.meeples)
      ? gd.meeples.filter(
          (m: Any) =>
            m?.type === t &&
            String(m.pId) === String(player.id) &&
            m.location === 'reserve',
        ).length
      : 0;
  const reserveAnimal = (
    t: 'sheep' | 'pig' | 'cattle',
    total: number,
  ): number => Math.max(0, Math.min(meepleReserve(t), total));
  const view: PlayerView = {
    resources: res,
    animals: {
      sheep: totalSheep,
      boar: totalPig,
      cattle: totalCattle,
    },
    unplacedAnimals: {
      sheep: reserveAnimal('sheep', totalSheep),
      boar: reserveAnimal('pig', totalPig),
      cattle: reserveAnimal('cattle', totalCattle),
    },
    farm,
    family: {
      // "people" was previously the count of farmer meeples for this player,
      // including ones placed on action spaces — that conflated household
      // size with placements. Use household size: farmers whose location is
      // either 'board' (on the farm) or an action card (still owned, just
      // out doing a job this round). Excludes 'reserve' (uninstantiated).
      people,
      canGrow: false,
    },
    played: Array.isArray(gd.playerCards)
      ? gd.playerCards
          .filter(
            (c: Any) =>
              String(c.pId) === String(player.id) && c.location === 'inPlay',
          )
          .map(toCardView)
      : [],
    placedFarmersThisRound: placementIds.map((id) => {
      // Prefer the display name the live notification carried — it's the
      // exact string BGA showed in the log ("Reed Bank") and avoids cases
      // where cardById hasn't loaded the card yet at mid-round attach.
      const tracked = trackedPlacements?.get(id);
      if (tracked?.cardName) return tracked.cardName;
      return actionCardDisplayName(id, cardById);
    }),
    score: typeof player.score === 'number' ? player.score : undefined,
  };
  if (includeHand) {
    view.hand = Array.isArray(player.hand) ? player.hand.map(toCardView) : [];
  }
  return view;
}

/** Resource meeple types whose count at an action-card location represents
 *  the live accumulation pile on that space. Animal meeples (sheep/pig/cattle)
 *  appear on animal-market spaces; basic goods (wood/clay/...) on the rest.
 *  Anything not in this set (farmer, fence, stable, firstPlayer, roomWood) is
 *  position/scaffolding data, not "what you'd collect by taking this space." */
const RESOURCE_MEEPLE_TYPES: ReadonlySet<string> = new Set([
  'wood', 'clay', 'reed', 'stone', 'food', 'grain', 'vegetable',
  'sheep', 'pig', 'cattle',
]);

/** cardId → {resourceType: count} of goods sitting on that space right now.
 *  THIS is the source of truth for "what you collect if you take this." The
 *  per-round accumulation rate lives in `card.desc` and is NOT what's on the
 *  card — `card.desc` for Clay Pit reads "1<CLAY>" all game long even when
 *  the pile is 2 or 3 (rate vs. pile mismatch was the v0.2.0.31 bug). */
function accumulatedByCard(gd: Any): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  const meeples: Any[] = Array.isArray(gd.meeples) ? gd.meeples : [];
  for (const m of meeples) {
    const t = typeof m?.type === 'string' ? m.type : '';
    if (!RESOURCE_MEEPLE_TYPES.has(t)) continue;
    const loc = typeof m.location === 'string' ? m.location : '';
    if (!loc || loc === 'board' || loc === 'reserve') continue;
    const cur = out.get(loc) ?? {};
    cur[t] = (cur[t] ?? 0) + 1;
    out.set(loc, cur);
  }
  return out;
}

/** Format a live pile like {clay: 2, wood: 1} → "2<CLAY> 1<WOOD>" to match
 *  the BGA tag style already used in card.desc — keeps the prompt monomodal. */
function formatPile(pile: Record<string, number>): string {
  const parts: string[] = [];
  for (const [t, n] of Object.entries(pile)) {
    if (n > 0) parts.push(`${n}<${t.toUpperCase()}>`);
  }
  return parts.join(' ');
}

// Action spaces live in gd.cards.visible / gd.cards.help (NOT gd.playerCards —
// that's the major-improvements board). Each is { id, name, desc[], ... }.
// IMPORTANT: `cards.visible[].pId` is ALWAYS null in BGA Agricola — occupancy
// is recorded in `meeples[i].location` (= the action-card id when placed).
// `card.desc` describes the per-round rate (Forest = "3<WOOD>") or fixed
// yield (Day Laborer = "+2<FOOD>") — NOT what currently sits there.
// `goods` therefore prefers the LIVE PILE (meeple count at that location)
// and falls back to `card.desc` for non-accumulator spaces.
function actionBoard(
  gd: Any,
  mePid: string,
  occupancyByCard: Map<string, string>,
  accumByCard: Map<string, Record<string, number>>,
): PositionBriefing['actionBoard'] {
  const cards = gd.cards;
  const lists: Any[] = [];
  if (cards && typeof cards === 'object') {
    for (const k of ['visible', 'help']) {
      if (Array.isArray(cards[k])) lists.push(...cards[k]);
    }
  }
  // `gamestate.args.allCards` is BGA's canonical list of action cards
  // CURRENTLY PLACEABLE this round. Cards in `cards.help` that aren't in
  // `allCards` are reveals queued for future rounds — including them in
  // actionBoard let the LLM recommend "Urgent Wish for Children" when it
  // wasn't actually on the board (verified live). Filter to `allCards`
  // when supplied; otherwise include everything (defensive fallback for
  // gamestates where allCards isn't populated, e.g. confirmTurn).
  const allCardsArr = gd.gamestate?.args?.allCards;
  const placeable: Set<string> | null = Array.isArray(allCardsArr)
    ? new Set(allCardsArr.map((x: unknown) => String(x)))
    : null;
  const seen = new Set<string>();
  const out: PositionBriefing['actionBoard'] = [];
  for (const c of lists) {
    const id = String(c?.id ?? '');
    if (!id || seen.has(id)) continue;
    if (placeable && !placeable.has(id)) continue; // future-round reveal — skip
    seen.add(id);
    const space: PositionBriefing['actionBoard'][number] = {
      id,
      name: String(c.name ?? id),
    };
    const occPid = occupancyByCard.get(id);
    if (occPid) {
      space.takenBy = occPid === mePid ? 'me' : 'opponent';
    }
    // Goods semantics: when takenBy is set, the pile on this card is already
    // folded into THAT player's `me.resources` / opponent.resources via the
    // BGA-UI formula in `effectiveResourcesFor`. Leaving `goods` populated
    // here would let the LLM double-count it. Only expose `goods` for
    // unclaimed spaces — that's the "what taking this yields" signal.
    if (!occPid) {
      const pile = accumByCard.get(id);
      const liveGoods = pile ? formatPile(pile) : '';
      if (liveGoods) {
        space.goods = liveGoods;
      } else {
        const descGoods = Array.isArray(c.desc)
          ? c.desc.filter(Boolean).join(' ')
          : undefined;
        if (descGoods) space.goods = descGoods;
      }
    }
    out.push(space);
  }
  return out;
}

/** Notification-tracked placement view, supplied by the probe. Keyed by
 *  action-card id, value carries the placing player and the display name.
 *  This is the AUTHORITATIVE source for "who's where" — `meeples[i].location`
 *  in BGA Agricola lags placement by seconds to tens of seconds (verified
 *  against the captured corpus). Whenever supplied, it overrides meeple
 *  derivation. Tests without a tracker can pass `undefined`; the meeple
 *  fallback still works for offline corpus replay where time has moved on. */
export interface TrackedPlacement {
  pId: string;
  cardName: string;
}

/** Per-player live resource counts scraped from BGA's DOM (`#resource_<pid>_<type>`).
 *  BGA updates the DOM synchronously in `notif_*` handlers while
 *  `gd.players[pid].resources` can lag by minutes (verified live: cache=3,
 *  DOM=1 after a 2-clay Fireplace payment). When this map is supplied the
 *  distiller treats it as canonical; absent / missing players fall back to
 *  the cache+pile derivation. */
export type LiveResourceMap = ReadonlyMap<string, Readonly<Record<string, number>>>;

/** Per-action-card live accumulator piles scraped from BGA's DOM
 *  (`#Action<Card> .resource-holder [data-type]` element count). BGA pins
 *  gamedatas.meeples to a pre-allocated value that does NOT update when
 *  piles are taken (verified: SheepMarket stayed at 4 sheep across multiple
 *  distills while the actual pile was 2). When this map is supplied the
 *  distiller treats it as canonical for both `actionBoard[].goods` and for
 *  the on-card-piles term in effective player resources. */
export type LiveAccumulatorMap = ReadonlyMap<string, Readonly<Record<string, number>>>;

/** Resource types where DOM is NOT the canonical source. BGA's
 *  `gd.players[pid].resources.fence/stable` count REMAINING-TO-BUILD; the
 *  DOM `#resource_<pid>_fence/stable` text counts ALREADY-BUILT. Both are
 *  correct for their own semantics. The briefing wants the "available to
 *  use" stockpile (cache), not the "built so far" tally (DOM). */
const RESOURCE_TYPES_KEEP_CACHE: ReadonlySet<string> = new Set(['fence', 'stable']);

export function distill(
  gamedatas: unknown,
  mePlayerId: string,
  trackedPlacements?: ReadonlyMap<string, TrackedPlacement>,
  liveResources?: LiveResourceMap,
  liveAccumulators?: LiveAccumulatorMap,
): DistillResult {
  try {
    if (!gamedatas || typeof gamedatas !== 'object') {
      return { ok: false, reason: 'gamedatas is not an object' };
    }
    const gd = gamedatas as Any;
    const gs = gd.gamestate;
    const players = gd.players;
    if (!gs || typeof gs !== 'object') {
      return { ok: false, reason: 'missing gamestate' };
    }
    if (!players || typeof players !== 'object') {
      return { ok: false, reason: 'missing players' };
    }
    const me = String(mePlayerId);
    if (!(me in players)) {
      return { ok: false, reason: 'local player not in players' };
    }

    const legalActions: string[] = Array.isArray(gs.possibleactions)
      ? gs.possibleactions.map(String)
      : [];

    const majors: CardView[] = Array.isArray(gd.playerCards)
      ? gd.playerCards
          .filter((c: Any) => c.type === 'major' && c.pId == null)
          .map(toCardView)
      : [];

    let draftPool: CardView[] | undefined;
    const poolRaw = gs.args?._private?.cards;
    if (Array.isArray(poolRaw) && poolRaw.length > 0) {
      draftPool = poolRaw.map(toCardView);
    }

    // Build occupancy + display-name lookups once and reuse for both
    // actionBoard and per-player placedFarmersThisRound. Single pass.
    const cardById = new Map<string, Any>();
    const visibles: Any[] = Array.isArray(gd.cards?.visible) ? gd.cards.visible : [];
    const helps: Any[] = Array.isArray(gd.cards?.help) ? gd.cards.help : [];
    for (const c of visibles) if (c?.id) cardById.set(String(c.id), c);
    for (const c of helps) if (c?.id) cardById.set(String(c.id), c);
    // If the caller passed a tracked-placement map (probe runtime), trust
    // that as the source of truth — meeple.location is stale by seconds in
    // BGA Agricola. Otherwise fall back to deriving from meeples (works for
    // captured corpus tests where time has moved on and meeples are fresh).
    const placedByPlayer = trackedPlacements
      ? placedFromTracker(trackedPlacements)
      : placedFarmersByPlayer(gd);
    // Invert: card id → player id of the farmer currently sitting on it.
    const occupancyByCard = new Map<string, string>();
    if (trackedPlacements) {
      for (const [cardId, p] of trackedPlacements) occupancyByCard.set(cardId, p.pId);
    } else {
      for (const [pid, cardIds] of placedByPlayer)
        for (const id of cardIds) occupancyByCard.set(id, pid);
    }
    // Live accumulation piles on each action space. Prefer the DOM-scraped
    // map (BGA's own data binding) when supplied; the gamedatas-meeples
    // fallback only fires for offline corpus tests where the DOM isn't
    // available — at runtime, the probe always passes liveAccumulators.
    const accumByCard = liveAccumulators
      ? new Map<string, Record<string, number>>(
          Array.from(liveAccumulators, ([k, v]) => [k, { ...v }]),
        )
      : accumulatedByCard(gd);

    const opponents: PlayerView[] = Object.keys(players)
      .filter((id) => id !== me)
      .map((id) =>
        playerView(
          gd,
          { ...players[id], id },
          false,
          cardById,
          placedByPlayer,
          accumByCard,
          trackedPlacements,
          liveResources,
        ),
      );

    const meView = playerView(
      gd,
      { ...players[me], id: me },
      true,
      cardById,
      placedByPlayer,
      accumByCard,
      trackedPlacements,
      liveResources,
    );
    const round = typeof gd.turn === 'number' ? gd.turn : Number(gd.turn) || 0;
    const briefing: PositionBriefing = {
      schemaVersion: BRIEFING_SCHEMA,
      round,
      phase: String(gd.gameFlowPhase ?? gs.name ?? 'unknown'),
      isMyTurn: String(gs.active_player) === me,
      legalActions,
      decisionPrompt:
        typeof gs.descriptionmyturn === 'string'
          ? gs.descriptionmyturn
          : typeof gs.description === 'string'
            ? gs.description
            : undefined,
      harvest: computeHarvestPlan(round, meView.family.people, meView.resources.food ?? 0),
      me: meView,
      opponents,
      actionBoard: actionBoard(gd, me, occupancyByCard, accumByCard),
      availableMajorImprovements: majors,
    };
    if (draftPool) briefing.draftPool = draftPool;

    return { ok: true, briefing };
  } catch (err) {
    return { ok: false, reason: `distill threw: ${String(err)}` };
  }
}
