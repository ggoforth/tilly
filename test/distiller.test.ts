import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { distill, buildBriefingSummary } from '../src/advisor/distiller';
import type { PositionBriefing } from '../src/shared/briefing';

const FX = `${process.cwd()}/test/fixtures/`;
const load = (f: string): unknown => JSON.parse(readFileSync(FX + f, 'utf8'));

const ME = '94800135'; // the_begging_student (from roster.json)
const OPP_HANDLE = 'to-son61';

const decision = load('decision.gamedatas.json');
const draftGd = load('draft.gamedatas.json');
const midwork = load('midwork.gamedatas.json');

test('is deterministic and pure (same input → deep-equal output)', () => {
  const a = distill(decision, ME);
  const b = distill(decision, ME);
  assert.deepEqual(a, b);
});

test('distills a real decision-point snapshot', () => {
  const r = distill(decision, ME);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const b = r.briefing;
  assert.equal(b.isMyTurn, true); // active_player is ME in this fixture
  const expected = (decision as any).gamestate.possibleactions;
  assert.deepEqual(b.legalActions, expected);
  assert.ok(b.legalActions.includes('actPlaceFarmer'));
  assert.equal(typeof b.round, 'number');
  assert.equal(typeof b.phase, 'string');
});

test('hand cards carry verbatim rules text', () => {
  const r = distill(decision, ME);
  assert.ok(r.ok && r.briefing.me.hand && r.briefing.me.hand.length > 0);
  if (!r.ok || !r.briefing.me.hand) return;
  for (const c of r.briefing.me.hand) {
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.kind, 'string');
    assert.ok(c.rulesText.length > 0, `card ${c.id} has empty rulesText`);
  }
});

test('exposes available major improvements distinct from hand', () => {
  const r = distill(decision, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  const majors = r.briefing.availableMajorImprovements;
  assert.ok(majors.length >= 1, 'expected available major improvements');
  for (const m of majors) assert.ok(m.rulesText.length > 0);
  const handIds = new Set((r.briefing.me.hand ?? []).map((c) => c.id));
  assert.ok(majors.every((m) => !handIds.has(m.id)), 'majors must not be in hand');
});

test('exposes the action board (available spaces) with names + yields', () => {
  const r = distill(decision, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  const ab = r.briefing.actionBoard;
  assert.ok(ab.length >= 5, `actionBoard should list spaces, got ${ab.length}`);
  for (const s of ab) {
    assert.equal(typeof s.name, 'string');
    assert.ok(s.name.length > 0, 'every space needs a human name');
  }
  const names = ab.map((s) => s.name.toLowerCase());
  assert.ok(
    names.some((n) => /clay pit|day laborer|forest|grain|fishing/.test(n)),
    `expected real Agricola action spaces, got: ${names.slice(0, 8).join(', ')}`,
  );
});

test('exposes the draft pool during the draft phase', () => {
  const r = distill(draftGd, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.briefing.draftPool && r.briefing.draftPool.length > 0);
  for (const c of r.briefing.draftPool!) assert.ok(c.rulesText.length > 0);
});

test('does not include any draft pool outside the draft phase', () => {
  const r = distill(decision, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  const dp = r.briefing.draftPool;
  assert.ok(dp === undefined || dp.length === 0);
});

test('strips opponent handles (no BGA handle anywhere in the briefing)', () => {
  const r = distill(decision, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.briefing.opponents.length, 1);
  assert.ok(!JSON.stringify(r.briefing).includes(OPP_HANDLE));
});

test('malformed input is non-fatal (no throw, ok:false)', () => {
  assert.doesNotThrow(() => distill({}, ME));
  assert.equal(distill({}, ME).ok, false);
  assert.equal(distill(null, ME).ok, false);
  assert.equal(distill({ players: {} }, ME).ok, false);
});

test('placedFarmersThisRound is empty before any placement', () => {
  // Pre-placement decision fixture has no farmer with action-card location.
  const r = distill(decision, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.briefing.me.placedFarmersThisRound, []);
});

// Developed-farm fixture: slimmed snapshot from observed game 853319280
// event 1908 — player 84298950 has 5 plowed fields, 5 pastures, 15 fences.
// This is the only fixture we have that exercises a developed farm; was
// added when we discovered `farm.fields` had silently been 0 for every
// game (the distiller was reading dropZones for fields, but BGA never
// puts type='field' entries in dropZones — verified across all fixtures).
const developedFarm = load('developed-farm.gamedatas.json');
const DEV_FARM_ME = '84298950';

test('developed farm: fields counted from scores.<pid>.fields.entries[0].quantity', () => {
  // Regression for the "fields:0 when I had plenty" bug. Old code:
  //   fields: zones.filter(z => z.type === 'field').length  // → always 0
  // because BGA does not put plowed fields into board.dropZones. The
  // authoritative count lives in gd.scores[pid].fields.entries[0].quantity.
  const r = distill(developedFarm, DEV_FARM_ME);
  assert.ok(r.ok, 'distill must succeed');
  if (!r.ok) return;
  assert.equal(
    r.briefing.me.farm.fields,
    5,
    'developed-farm fixture has 5 plowed fields for pid 84298950',
  );
});

test('developed farm: pastures counted from board.pastures array', () => {
  // Regression: pastures were counted via dropZones.filter(z=>z.type==='pasture')
  // which counts drop TARGETS, not built pastures. Switch to board.pastures
  // (the canonical built-pasture array) so it's stable even when drop-zone
  // semantics change between game states.
  const r = distill(developedFarm, DEV_FARM_ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.briefing.me.farm.pastures, 5, 'developed-farm has 5 pastures');
  assert.equal(r.briefing.me.farm.fencedSpaces, 15, 'developed-farm has 15 fence segments');
});

test('animal totals override stale meeples when liveResources is supplied', () => {
  // Regression for the live R11 bug: user had 2 sheep on the farm board
  // but the briefing said sh0 because gd.meeples hadn't been re-snapshotted
  // since the user placed them. The DOM counter (#resource_<pid>_sheep)
  // reads 2 in that scenario — surfaced via liveResources, it must win.
  const fakeGd: any = {
    gamestate: {
      id: 700, name: 'placeFarmer', active_player: ME,
      possibleactions: ['actPlaceFarmer'],
    },
    players: { [ME]: { id: ME, name: 'me', resources: { sheep: 0 } } },
    // Intentionally NO sheep meeples — simulating stale gamedatas where
    // the meeples array hasn't been updated since the sheep were placed.
    meeples: [
      { id: 5, type: 'farmer', pId: ME, location: 'board', x: 1, y: 1 },
    ],
    cards: { visible: [] },
    turn: 10,
  };
  const liveResources = new Map<string, Record<string, number>>([
    [ME, { sheep: 2, pig: 0, cattle: 0 }],
  ]);
  const r = distill(fakeGd, ME, undefined, liveResources);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(
    r.briefing.me.animals.sheep, 2,
    'live DOM count (2) MUST win over stale gd.meeples (0)',
  );
  // unplaced clamped to [0, total] — meeples shows 0 in reserve, total is 2.
  assert.equal(r.briefing.me.unplacedAnimals.sheep, 0);
});

test('animals = total owned (housed + supply); unplacedAnimals = supply only', () => {
  // Live R10 bug: stamp said sh0 p0 cat0 while user had 3 sheep housed in
  // rooms. The old `animals.sheep` came from the cache (supply only) so
  // housed sheep weren't counted. LLM said "you have 0 sheep" when the
  // truth was "0 unplaced, 3 housed". Surface both unambiguously.
  const fakeGd: any = {
    gamestate: { id: 700, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: { [ME]: { id: ME, name: 'me', resources: { sheep: 0 } } },
    meeples: [
      // 3 sheep housed on the farm board (in rooms)
      { id: 1, type: 'sheep', pId: ME, location: 'board', x: 1, y: 1 },
      { id: 2, type: 'sheep', pId: ME, location: 'board', x: 2, y: 1 },
      { id: 3, type: 'sheep', pId: ME, location: 'board', x: 3, y: 1 },
      // 1 boar in the supply, available to cook
      { id: 4, type: 'pig', pId: ME, location: 'reserve' },
      // farmers for family.people
      { id: 5, type: 'farmer', pId: ME, location: 'board', x: 1, y: 1 },
    ],
    cards: { visible: [] },
    turn: 10,
  };
  const r = distill(fakeGd, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  // Total ownership — what "do you have sheep?" should answer
  assert.equal(r.briefing.me.animals.sheep, 3, 'total sheep must include the 3 housed');
  assert.equal(r.briefing.me.animals.boar, 1, 'total boar includes the 1 in supply');
  assert.equal(r.briefing.me.animals.cattle, 0);
  // Supply only — what "can I cook?" should answer
  assert.equal(
    r.briefing.me.unplacedAnimals.sheep,
    0,
    `housed sheep MUST NOT show as unplaced; got ${r.briefing.me.unplacedAnimals.sheep}`,
  );
  assert.equal(r.briefing.me.unplacedAnimals.boar, 1, 'reserve boar IS unplaced');
});

test('computeHarvestPlan: shortfall surfaces correctly across rounds (multiplayer rate, 2/person)', async () => {
  const { computeHarvestPlan } = await import('../src/advisor/distiller');
  // playerCount=2 → multiplayer rate (2 food per person).
  // Round 1, 2 people, 0 food → next harvest R4, 3 rounds away, need 4, gap 4
  let plan = computeHarvestPlan(1, 2, 0, 2);
  assert.equal(plan.nextHarvestRound, 4);
  assert.equal(plan.roundsUntilHarvest, 3);
  assert.equal(plan.foodNeededAtNextHarvest, 4);
  assert.equal(plan.foodShortfall, 4);
  // R4 with 3 food and 2 people → harvest is now (0 away), need 4, gap 1
  plan = computeHarvestPlan(4, 2, 3, 2);
  assert.equal(plan.nextHarvestRound, 4);
  assert.equal(plan.roundsUntilHarvest, 0);
  assert.equal(plan.foodShortfall, 1);
  // R5 → next harvest R7, 2 rounds away
  plan = computeHarvestPlan(5, 3, 0, 2);
  assert.equal(plan.nextHarvestRound, 7);
  assert.equal(plan.roundsUntilHarvest, 2);
  assert.equal(plan.foodNeededAtNextHarvest, 6);
  // R14 (final harvest) with plenty of food → no shortfall, this round IS harvest
  plan = computeHarvestPlan(14, 4, 10, 2);
  assert.equal(plan.nextHarvestRound, 14);
  assert.equal(plan.roundsUntilHarvest, 0);
  assert.equal(plan.foodShortfall, 0);
  // R15 (past final) → no future harvest
  plan = computeHarvestPlan(15, 3, 0, 2);
  assert.equal(plan.nextHarvestRound, null);
  assert.equal(plan.roundsUntilHarvest, null);
  assert.equal(plan.foodShortfall, 6);
});

test('computeHarvestPlan: solo Beginner uses 3/person rate (live R4 regression)', async () => {
  // Live R4 trace: 2-person solo Beginner game needed 6 food at harvest,
  // distiller was reporting 4 (multiplayer rate). User caught it and
  // corrected to '6 food, not 4'. Solo Beginner = playerCount 1 = 3/person.
  const { computeHarvestPlan, feedRatePerPerson } = await import('../src/advisor/distiller');
  assert.equal(feedRatePerPerson(1), 3, 'solo Beginner rate is 3 food per person');
  assert.equal(feedRatePerPerson(2), 2, '2+ player games use 2 food per person');
  assert.equal(feedRatePerPerson(4), 2, '4-player still 2 food per person');

  // Exact R4 scenario: 2 people, 4 food, playerCount 1 → need 6, shortfall 2.
  const plan = computeHarvestPlan(4, 2, 4, 1);
  assert.equal(plan.foodNeededAtNextHarvest, 6, 'solo: 2 people × 3 = 6');
  assert.equal(plan.foodShortfall, 2, 'solo R4 with 4 food: shortfall of 2');
});

test('distill populates briefing.harvest from current round + family + food (solo rate)', () => {
  const fakeGd: any = {
    gamestate: { id: 1, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: { [ME]: { id: ME, name: 'me', resources: { food: 0 } } },
    meeples: [
      { id: 1, type: 'farmer', pId: ME, location: 'board', x: 1, y: 1 },
      { id: 2, type: 'farmer', pId: ME, location: 'board', x: 1, y: 3 },
    ],
    cards: { visible: [] },
    turn: 3,
  };
  const r = distill(fakeGd, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  // R3, 2 farmers, 0 food, SOLO (only ME in players, no opponents).
  // Solo Beginner = 3 food per person → 2 people need 6 → shortfall 6.
  assert.equal(r.briefing.harvest.nextHarvestRound, 4);
  assert.equal(r.briefing.harvest.roundsUntilHarvest, 1);
  assert.equal(r.briefing.harvest.foodNeededAtNextHarvest, 6);
  assert.equal(r.briefing.harvest.foodShortfall, 6);
});

test('farm.canBuildRoom is false when reed is insufficient (the 1-reed bug)', () => {
  // Live trace: user had 6 wood, 1 reed, roomType=wood, and the LLM
  // recommended "Build a wood room now". Wood room needs 5 wood + 2 reed.
  // 1 reed < 2 reed → can't afford. Pre-computing this flag stops the LLM
  // from being asked to do arithmetic it has reliably failed to do.
  const fakeGd: any = {
    gamestate: { id: 800, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: {
      [ME]: {
        id: ME,
        name: 'me',
        resources: { wood: 6, reed: 1, clay: 0, stone: 0 },
        board: {
          dropZones: [
            { type: 'room', roomType: 'wood', locations: [{}, {}] }, // 2 rooms, wood
          ],
          fences: [],
        },
      },
    },
    meeples: [],
    cards: { visible: [] },
    turn: 3,
  };
  const r = distill(fakeGd, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.briefing.me.farm.roomType, 'wood');
  assert.equal(
    r.briefing.me.farm.canBuildRoom,
    false,
    `canBuildRoom must be false with 1 reed (need 2); got true`,
  );
  // canBuildStable: 6 wood >= 2 → true. canBuildFence: 6 wood >= 1 → true.
  assert.equal(r.briefing.me.farm.canBuildStable, true);
  assert.equal(r.briefing.me.farm.canBuildFence, true);

  // Now give them 2 reed → flips true.
  fakeGd.players[ME].resources.reed = 2;
  const r2 = distill(fakeGd, ME);
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.equal(r2.briefing.me.farm.canBuildRoom, true);

  // Clay-roomType variant with 5 clay + 2 reed → can build clay room.
  fakeGd.players[ME].board.dropZones[0].roomType = 'clay';
  fakeGd.players[ME].resources.clay = 5;
  const r3 = distill(fakeGd, ME);
  assert.ok(r3.ok);
  if (!r3.ok) return;
  assert.equal(r3.briefing.me.farm.roomType, 'clay');
  assert.equal(r3.briefing.me.farm.canBuildRoom, true);

  // But with clay=4 → can't build clay room (need 5).
  fakeGd.players[ME].resources.clay = 4;
  const r4 = distill(fakeGd, ME);
  assert.ok(r4.ok);
  if (!r4.ok) return;
  assert.equal(r4.briefing.me.farm.canBuildRoom, false);
});

test('farm.emptyRooms is rooms minus people, floored at 0', () => {
  // Live R8 bug: user had 3 rooms + 3 family members (0 empty rooms) but
  // LLM recommended "Wish for Children — you have 3 rooms which satisfies
  // the requirement." Surface emptyRooms explicitly so the LLM doesn't have
  // to do (and fail) the subtraction.
  const fakeGd: any = {
    gamestate: { id: 600, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: {
      [ME]: {
        id: ME,
        name: 'me',
        resources: {},
        board: {
          dropZones: [
            { type: 'room', roomType: 'wood', locations: [{}, {}, {}] }, // 3 rooms
          ],
          fences: [],
        },
      },
    },
    // 3 farmers on the farm (each in a room) — emptyRooms must be 0
    meeples: [
      { id: 1, type: 'farmer', pId: ME, location: 'board', x: 1, y: 1 },
      { id: 2, type: 'farmer', pId: ME, location: 'board', x: 1, y: 3 },
      { id: 3, type: 'farmer', pId: ME, location: 'board', x: 1, y: 5 },
    ],
    cards: { visible: [] },
    turn: 8,
  };
  const r = distill(fakeGd, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.briefing.me.farm.rooms, 3);
  assert.equal(r.briefing.me.family.people, 3);
  assert.equal(
    r.briefing.me.farm.emptyRooms,
    0,
    `with 3 rooms and 3 people, emptyRooms MUST be 0; got ${r.briefing.me.farm.emptyRooms}`,
  );

  // Variant: same farm, only 2 people → emptyRooms should be 1
  fakeGd.meeples = [
    { id: 1, type: 'farmer', pId: ME, location: 'board', x: 1, y: 1 },
    { id: 2, type: 'farmer', pId: ME, location: 'board', x: 1, y: 3 },
  ];
  const r2 = distill(fakeGd, ME);
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.equal(r2.briefing.me.farm.emptyRooms, 1);

  // Edge: more people than rooms (shouldn't happen but floor at 0)
  fakeGd.meeples = [
    { id: 1, type: 'farmer', pId: ME, location: 'board', x: 1, y: 1 },
    { id: 2, type: 'farmer', pId: ME, location: 'board', x: 1, y: 3 },
    { id: 3, type: 'farmer', pId: ME, location: 'board', x: 1, y: 5 },
    { id: 4, type: 'farmer', pId: ME, location: 'board', x: 2, y: 1 },
  ];
  const r3 = distill(fakeGd, ME);
  assert.ok(r3.ok);
  if (!r3.ok) return;
  assert.equal(r3.briefing.me.farm.emptyRooms, 0, 'must floor at 0');
});

test('actionBoard excludes future-round reveals not in gamestate.args.allCards', () => {
  // Live R8 bug: distiller pulled ActionUrgentWishChildren from cards.help
  // even though it wasn't placeable this round, and the LLM dutifully
  // recommended it. Fix: filter actionBoard to gs.args.allCards (BGA's
  // canonical "what's placeable RIGHT NOW" signal).
  const fakeGd: any = {
    gamestate: {
      id: 500,
      name: 'placeFarmer',
      active_player: ME,
      possibleactions: ['actPlaceFarmer'],
      args: {
        allCards: ['ActionClayPit', 'ActionForest', 'ActionWishChildren'],
      },
    },
    players: { [ME]: { id: ME, name: 'me', resources: {} } },
    meeples: [],
    cards: {
      visible: [
        { id: 'ActionClayPit', name: 'Clay Pit', state: '1' },
        { id: 'ActionForest', name: 'Forest', state: '1' },
        { id: 'ActionWishChildren', name: 'Wish for Children', state: '1' },
      ],
      help: [
        // future-round reveals BGA queues — must NOT appear in actionBoard
        { id: 'ActionUrgentWishChildren', name: 'Urgent Wish for Children', state: '0' },
        { id: 'ActionCattleMarket', name: 'Cattle Market', state: '0' },
      ],
    },
    turn: 8,
  };
  const r = distill(fakeGd, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  const ids = r.briefing.actionBoard.map((s) => s.id);
  assert.ok(ids.includes('ActionWishChildren'), 'currently-placeable Wish for Children must appear');
  assert.ok(
    !ids.includes('ActionUrgentWishChildren'),
    `Urgent Wish for Children is a future reveal and MUST NOT appear in actionBoard; got: ${ids.join(',')}`,
  );
  assert.ok(
    !ids.includes('ActionCattleMarket'),
    `Cattle Market is a future reveal and MUST NOT appear; got: ${ids.join(',')}`,
  );
});

test('liveAccumulators (DOM pile scrape) overrides stale meeple counts', () => {
  // Verified live: SheepMarket had m:s4 in gamedatas.meeples both BEFORE and
  // AFTER the user placed and collected 2 sheep. BGA pins the meeple count
  // to a pre-allocated value. The DOM `.resource-holder [data-type]` count
  // is the live source. When the probe passes liveAccumulators, distiller
  // must use that for actionBoard[].goods, ignoring the stale meeple count.
  const fakeGd: any = {
    gamestate: { id: 300, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: { [ME]: { id: ME, name: 'me', resources: {} } },
    // gamedatas claims 4 sheep on Sheep Market — the stale pre-allocated count.
    meeples: [
      { id: 1, type: 'sheep', pId: 0, location: 'ActionSheepMarket' },
      { id: 2, type: 'sheep', pId: 0, location: 'ActionSheepMarket' },
      { id: 3, type: 'sheep', pId: 0, location: 'ActionSheepMarket' },
      { id: 4, type: 'sheep', pId: 0, location: 'ActionSheepMarket' },
    ],
    cards: { visible: [{ id: 'ActionSheepMarket', name: 'Sheep Market', state: '1' }] },
    turn: 8,
  };
  // Live DOM says the actual pile is 2 sheep.
  const livePiles = new Map([['ActionSheepMarket', { sheep: 2 }]]);
  const r = distill(fakeGd, ME, undefined, undefined, livePiles);
  assert.ok(r.ok);
  if (!r.ok) return;
  const sm = r.briefing.actionBoard.find((s) => s.id === 'ActionSheepMarket');
  assert.ok(sm);
  assert.equal(
    sm!.goods,
    '2<SHEEP>',
    `Sheep Market goods must reflect DOM pile (2), not stale meeple count (4); got ${sm!.goods}`,
  );
});

test('fence/stable keep cache values even when liveResources is supplied', () => {
  // The DOM `#resource_<pid>_fence` shows ALREADY-BUILT fences (=0 at game
  // start). The cache `gd.players[pid].resources.fence` shows REMAINING
  // STOCKPILE (=15 at start). The briefing needs the stockpile so the LLM
  // can reason about "how many fences could I build right now." Verified
  // live as a persistent drift event.
  const fakeGd: any = {
    gamestate: { id: 400, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: { [ME]: { id: ME, name: 'me', resources: { wood: 7, fence: 15, stable: 3 } } },
    meeples: [],
    cards: { visible: [] },
    turn: 8,
  };
  // DOM shows zero fences/stables built. Cache shows 15/3 remaining to build.
  const live = new Map([[ME, { wood: 7, fence: 0, stable: 1 }]]);
  const r = distill(fakeGd, ME, undefined, live);
  assert.ok(r.ok);
  if (!r.ok) return;
  // wood pulls from DOM (canonical for actual resources).
  assert.equal(r.briefing.me.resources.wood, 7);
  // fence/stable stay on cache values — the "remaining-to-build" stockpile.
  assert.equal(
    r.briefing.me.resources.fence,
    15,
    `fence must stay on cache (stockpile remaining), not DOM (built so far); got ${r.briefing.me.resources.fence}`,
  );
  assert.equal(
    r.briefing.me.resources.stable,
    3,
    `stable must stay on cache; got ${r.briefing.me.resources.stable}`,
  );
});

test('liveResources (DOM scrape) overrides cache+pile when provided (clay-1 post-spend)', () => {
  // The R4 post-Fireplace scenario from the v0.2.0.35 live console session:
  // user paid 2 clay for Fireplace last round. Cache STILL says clay=3 (lags
  // debits) and meeples are at reserve (also stale). Only the DOM shows 1.
  // The probe scrapes #resource_<pid>_clay = "1" and passes it in. The
  // distiller MUST use that as canonical, ignoring the stale cache/pile.
  const fakeGd: any = {
    gamestate: { id: 200, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: { [ME]: { id: ME, name: 'me', resources: { clay: 3, wood: 4, reed: 2 } } },
    meeples: [
      { id: 10, type: 'clay', pId: ME, location: 'reserve' },
      { id: 11, type: 'clay', pId: ME, location: 'reserve' },
      { id: 12, type: 'clay', pId: ME, location: 'reserve' },
    ],
    cards: { visible: [] },
    turn: 4,
  };
  const live = new Map([[ME, { clay: 1, wood: 4, reed: 2 }]]);
  const r = distill(fakeGd, ME, undefined, live);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(
    r.briefing.me.resources.clay,
    1,
    `live DOM clay=1 must override cache=3; got ${r.briefing.me.resources.clay}`,
  );
});

test('effective resources include goods on action cards I sit on (the clay-3-bug)', () => {
  // Verified live against the BGA console in user's session:
  //   gd.players[me].resources.clay === 0
  //   meeples with type='clay', location='ActionClayPit', pid=0 → count 3
  //   DOM element #resource_<me>_clay → "3"
  // BGA's UI computes effective = cache + goods-on-cards-I-sit-on. The
  // distiller MUST match that formula. The tracker tells us I'm at Clay Pit.
  const fakeGd: any = {
    gamestate: { id: 99, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: { [ME]: { id: ME, name: 'me', resources: { clay: 0, wood: 4 } } },
    meeples: [
      // 3 unclaimed clay sitting on the Clay Pit action card (pid=0 in BGA).
      { id: 1, type: 'clay', pId: 0, location: 'ActionClayPit' },
      { id: 2, type: 'clay', pId: 0, location: 'ActionClayPit' },
      { id: 3, type: 'clay', pId: 0, location: 'ActionClayPit' },
      // Reserve wood for me — these ARE already in resources.wood.
      { id: 4, type: 'wood', pId: ME, location: 'reserve' },
      { id: 5, type: 'wood', pId: ME, location: 'reserve' },
      { id: 6, type: 'wood', pId: ME, location: 'reserve' },
      { id: 7, type: 'wood', pId: ME, location: 'reserve' },
    ],
    cards: { visible: [{ id: 'ActionClayPit', name: 'Clay Pit', state: '1' }] },
    turn: 3,
  };
  const tracker = new Map([
    ['ActionClayPit', { pId: ME, cardName: 'Clay Pit' }],
  ]);
  const r = distill(fakeGd, ME, tracker);
  assert.ok(r.ok);
  if (!r.ok) return;
  // The bug-fix assertion: clay must be 3 (cache 0 + 3 sitting on Clay Pit
  // which I sit on), NOT 0 (the stale cache).
  assert.equal(
    r.briefing.me.resources.clay,
    3,
    `effective clay should be 3 (cache 0 + 3 on Clay Pit I sit on); got ${r.briefing.me.resources.clay}`,
  );
  // Wood stays at 4 (cache; no extra Forest sitting in the fixture).
  assert.equal(r.briefing.me.resources.wood, 4);
  // actionBoard entry must NOT also report 3<CLAY> as `goods` — that would
  // double-count from the LLM's perspective (already in me.resources).
  const clayPit = r.briefing.actionBoard.find((s) => s.id === 'ActionClayPit');
  assert.ok(clayPit);
  assert.equal(clayPit!.takenBy, 'me');
  assert.ok(
    !clayPit!.goods,
    `goods must be cleared when takenBy is set (already in resources); got ${clayPit!.goods}`,
  );
});

test('tracked placements override stale meeple data (the BGA lag bug)', () => {
  // The empirical fault, verified in the captured corpus: a placeFarmer
  // notification fires, but `meeples[i].location` does NOT flip to the
  // action-card id for seconds (sometimes 30+). Reading meeples therefore
  // misses the placement. The probe must pass a tracker-derived map; the
  // distiller must trust it.
  //
  // Reuse the pre-placement `decision` fixture (no meeples at action cards)
  // and pretend the tracker says "me has just placed on Reed Bank". The
  // briefing must reflect it even though gamedatas itself does not.
  const tracker = new Map([
    [
      'ActionReedBank',
      { pId: ME, cardName: 'Reed Bank' },
    ],
  ]);
  const r = distill(decision, ME, tracker);
  assert.ok(r.ok);
  if (!r.ok) return;
  // The user-facing field that the LLM and the stamp consume:
  assert.deepEqual(
    r.briefing.me.placedFarmersThisRound,
    ['Reed Bank'],
    'placedFarmersThisRound must reflect tracker',
  );
  // And the action-board entry must show takenBy=me:
  const reed = r.briefing.actionBoard.find((s) => s.id === 'ActionReedBank');
  assert.ok(reed, 'ActionReedBank must be on the board');
  assert.equal(
    reed!.takenBy,
    'me',
    `Reed Bank takenBy must be "me"; got ${reed!.takenBy}`,
  );
});

test('without a tracker, distill still works (meeple fallback for corpus replay)', () => {
  // Backwards-compat: calling distill(gd, me) with no tracker must keep
  // populating placedFarmersThisRound from meeples (used by offline tests
  // against captured games where time has moved on and meeples are fresh).
  const r = distill(midwork, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  const mine = r.briefing.me.placedFarmersThisRound.join('|').toLowerCase();
  assert.ok(/reed/.test(mine), `expected meeple-derived Reed Bank; got: ${mine}`);
});

test('placedFarmersThisRound surfaces my action-space placements', () => {
  // The midwork fixture has me on ActionReedBank.
  const r = distill(midwork, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  // Should include the display name (or id fallback) — assert by case-insensitive
  // substring so a future name change in BGA doesn't silently break this.
  const mine = r.briefing.me.placedFarmersThisRound.join('|').toLowerCase();
  assert.ok(
    /reed/.test(mine),
    `expected Reed Bank in me.placedFarmersThisRound, got: ${mine}`,
  );
});

test('actionBoard.goods reflects LIVE pile, not per-round rate', () => {
  // The v0.2.0.31 bug: distiller read `card.desc` ("1<CLAY>") and the LLM
  // saw "Clay Pit → 1 clay" when the actual pile was 2 clay (1/round * 2
  // rounds untaken). midwork has these meeple-derived piles:
  //   ActionForest    → 3 wood
  //   ActionClayPit   → 1 clay   (rate=1, pile=1 here, but the field MUST
  //                                still come from the live count)
  //   ActionFishing   → 2 food   (rate=1, pile=2 — diverges from desc!)
  //   ActionCopseAdd  → 2 wood
  const r = distill(midwork, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  const ab = r.briefing.actionBoard;
  const fishing = ab.find((s) => s.id === 'ActionFishing');
  assert.ok(fishing, 'expected ActionFishing on the action board');
  assert.equal(
    fishing!.goods,
    '2<FOOD>',
    `Fishing's live pile is 2 food (rate is +1/round) — got ${fishing!.goods}`,
  );
  const forest = ab.find((s) => s.id === 'ActionForest');
  assert.equal(forest!.goods, '3<WOOD>', `Forest pile got ${forest!.goods}`);
});

test('actionBoard.goods falls back to desc for fixed-yield (non-accumulating) spaces', () => {
  // Day Laborer / Fencing / Lessons never accumulate — they have no meeples
  // at their location. `goods` should be the rules text from `card.desc`.
  const r = distill(midwork, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  const ab = r.briefing.actionBoard;
  const day = ab.find((s) => s.id === 'ActionDayLaborer');
  assert.ok(day, 'expected ActionDayLaborer on the action board');
  assert.equal(
    day!.goods,
    '+2<FOOD>',
    `Day Laborer should show its desc; got ${day!.goods}`,
  );
});

test('actionBoard.takenBy reflects real occupancy (was always-null before)', () => {
  // BGA Agricola never sets cards.visible[].pId — the old gate path always
  // returned takenBy=undefined. This test pins the new meeple-derived logic.
  // Find by exact id (multiple wish-like spaces share a display name).
  const r = distill(midwork, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  const ab = r.briefing.actionBoard;
  const reed = ab.find((s) => s.id === 'ActionReedBank');
  assert.ok(reed, 'expected ActionReedBank on the action board');
  assert.equal(reed!.takenBy, 'me', `Reed Bank should be takenBy=me; got ${reed!.takenBy}`);
  const wish = ab.find((s) => s.id === 'ActionWishChildren');
  assert.ok(wish, 'expected ActionWishChildren on the action board');
  assert.equal(
    wish!.takenBy,
    'opponent',
    `Wish for Children should be takenBy=opponent; got ${wish!.takenBy}`,
  );
});

// ---- Briefing summary (LLM cheat-sheet) tests ----

test('briefing.summary is present and contains round + harvest + farm lines', () => {
  const r = distill(decision, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  const s = r.briefing.summary;
  assert.ok(typeof s === 'string' && s.length > 0, 'summary must be a non-empty string');
  assert.match(s!, /Round \d+ — /, 'summary should open with "Round N — "');
  assert.match(s!, /Harvest/, 'summary should mention harvest');
  assert.match(s!, /Farm: /, 'summary should include farm line');
  assert.match(s!, /Stockpile: /, 'summary should include stockpile line');
  assert.match(s!, /Family: /, 'summary should include family line');
});

test('summary warns DO NOT recommend already-placed actions', () => {
  // Construct a briefing where farmers have been placed this round, then
  // assert the summary surfaces them with the strong instruction. This is
  // the direct counter to the "told me to grab Clay Pit when I already had"
  // pattern observed in the live R11 trace.
  const bf: PositionBriefing = {
    schemaVersion: 1,
    round: 11, phase: 'work', isMyTurn: true,
    legalActions: ['actPlaceFarmer'],
    harvest: { nextHarvestRound: 11, roundsUntilHarvest: 0, foodNeededAtNextHarvest: 6, foodShortfall: 0 },
    me: {
      resources: { food: 7, wood: 0, clay: 7, reed: 4, stone: 4, grain: 0, vegetable: 0, sheep: 0, pig: 0, cattle: 0, begging: 0, fence: 4, stable: 4 },
      animals: { sheep: 1, boar: 2, cattle: 0 },
      unplacedAnimals: { sheep: 0, boar: 0, cattle: 0 },
      farm: { rooms: 3, roomType: 'wood', fields: 0, pastures: 2, stables: 0, fencedSpaces: 11, emptySpaces: 0, emptyRooms: 0, canBuildRoom: false, canBuildStable: false, canBuildFence: false },
      family: { people: 3, canGrow: false },
      played: [],
      placedFarmersThisRound: ['Clay Pit', 'Cattle Market'],
      hand: [],
    },
    opponents: [],
    actionBoard: [
      { id: 'ActionClayPit', name: 'Clay Pit', takenBy: 'me' },
      { id: 'ActionDayLaborer', name: 'Day Laborer' },
      { id: 'ActionFishing', name: 'Fishing' },
    ],
    availableMajorImprovements: [],
  };
  const s = buildBriefingSummary(bf);
  assert.match(s, /Already placed this round: Clay Pit, Cattle Market\./);
  assert.match(s, /DO NOT recommend these/);
  assert.match(s, /Open spaces \(RECOMMEND ONLY FROM THIS EXHAUSTIVE LIST/);
});

test('summary lists ALL open spaces (not truncated) — anti-hallucination signal', () => {
  // Live R6 regression: Tilly recommended 'Wish for Children' when it
  // wasn't in actionBoard. Verified the actionBoard filter is correct
  // (the LLM made it up). The summary previously truncated the open
  // list to 'first 8 + N more' — the '+N more' invited the LLM to fill
  // in plausible extras from training data. Exhaustive listing closes
  // that seam.
  const manySpaces: PositionBriefing['actionBoard'] = [];
  for (let i = 0; i < 16; i++) {
    manySpaces.push({ id: `ActionX${i}`, name: `SpaceName${i}` });
  }
  const bf: PositionBriefing = {
    schemaVersion: 1,
    round: 6, phase: 'work', isMyTurn: true,
    legalActions: ['actPlaceFarmer'],
    harvest: { nextHarvestRound: 7, roundsUntilHarvest: 1, foodNeededAtNextHarvest: 6, foodShortfall: 0 },
    me: {
      resources: { food: 7, wood: 1, clay: 3, reed: 1, stone: 0, grain: 0, vegetable: 0, sheep: 0, pig: 0, cattle: 0, begging: 0, fence: 15, stable: 4 },
      animals: { sheep: 0, boar: 0, cattle: 0 },
      unplacedAnimals: { sheep: 0, boar: 0, cattle: 0 },
      farm: { rooms: 3, roomType: 'wood', fields: 0, pastures: 0, stables: 1, fencedSpaces: 0, emptySpaces: 0, emptyRooms: 1, canBuildRoom: false, canBuildStable: true, canBuildFence: true },
      family: { people: 2, canGrow: true },
      played: [], placedFarmersThisRound: [], hand: [],
    },
    opponents: [],
    actionBoard: manySpaces,
    availableMajorImprovements: [],
  };
  const s = buildBriefingSummary(bf);
  // All 16 names appear in the summary; no '+N more' truncation.
  for (let i = 0; i < 16; i++) {
    assert.match(s, new RegExp(`SpaceName${i}`), `must list SpaceName${i} explicitly`);
  }
  assert.doesNotMatch(s, /\+\d+ more/, 'must NOT truncate with +N more (hallucination seam)');
  assert.match(s, /anything else is a hallucination/);
});

test('summary uses "pigs" not "boar" so it matches resources.pig naming', () => {
  // Eliminates one LLM reconciliation step (animals.boar vs resources.pig
  // referring to the same thing). The summary must speak in resource-pile
  // vocabulary.
  const r = distill(decision, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.briefing.summary!, /pigs/);
  assert.doesNotMatch(r.briefing.summary!, /\bboar\b/);
});

test('distill merges trackedCards into briefing.me.played (gd.playerCards staleness fallback)', () => {
  // Live R7 regression: user bought Fireplace via Improvements at R6 (3:36:41
  // PM `buyCard` notif). Briefings 30+ seconds and many gamestate transitions
  // later still showed me.played:[] because gd.playerCards hadn't been
  // refreshed. LLM re-recommended building Fireplace. Same staleness class
  // as the meeples / dropZones bugs — fixed by a notification-driven
  // CardTracker mirroring PlacementTracker.
  const fakeGd: any = {
    gamestate: { id: 700, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: { [ME]: { id: ME, name: 'me', resources: { food: 7 } } },
    // gd.playerCards is empty — the staleness window. Tracker must rescue.
    playerCards: [],
    meeples: [
      { id: 1, type: 'farmer', pId: ME, location: 'board', x: 1, y: 1 },
      { id: 2, type: 'farmer', pId: ME, location: 'board', x: 1, y: 3 },
    ],
    cards: {
      visible: [
        // Fireplace card metadata available so toCardView can enrich.
        { id: 'Major_Fireplace1', name: 'Fireplace', kind: 'major', desc: ['cooking'] },
      ],
    },
    turn: 7,
  };
  const trackedCards = new Map<string, Array<{ cardId: string; cardName: string }>>([
    [ME, [{ cardId: 'Major_Fireplace1', cardName: 'Fireplace' }]],
  ]);
  const r = distill(fakeGd, ME, undefined, undefined, undefined, trackedCards);
  assert.ok(r.ok);
  if (!r.ok) return;
  const played = r.briefing.me.played;
  assert.equal(played.length, 1, 'must include the tracker-only card');
  assert.equal(played[0]!.id, 'Major_Fireplace1');
  assert.equal(played[0]!.name, 'Fireplace');
});

test('distill dedups when gd.playerCards AND trackedCards both have a card', () => {
  // After gd.playerCards eventually refreshes, the tracked entry still
  // exists. Distiller must dedup by id so the played list doesn't show
  // the same card twice.
  const fakeGd: any = {
    gamestate: { id: 700, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: { [ME]: { id: ME, name: 'me', resources: {} } },
    playerCards: [
      { id: 'Major_Fireplace1', pId: ME, location: 'inPlay', name: 'Fireplace', kind: 'major' },
    ],
    meeples: [{ id: 1, type: 'farmer', pId: ME, location: 'board', x: 1, y: 1 }],
    cards: { visible: [] },
    turn: 7,
  };
  const trackedCards = new Map<string, Array<{ cardId: string; cardName: string }>>([
    [ME, [{ cardId: 'Major_Fireplace1', cardName: 'Fireplace' }]],
  ]);
  const r = distill(fakeGd, ME, undefined, undefined, undefined, trackedCards);
  assert.ok(r.ok);
  if (!r.ok) return;
  // EXACTLY one entry — both sources agree, dedup picks the gd one.
  assert.equal(r.briefing.me.played.length, 1);
  assert.equal(r.briefing.me.played[0]!.id, 'Major_Fireplace1');
});

test('family.canGrow is TRUE when farm has an empty room', () => {
  // Live R8 regression: emptyRooms=1 but canGrow=false in the same briefing
  // — internally contradictory. canGrow was hardcoded to false in distiller;
  // now derived from emptyRooms > 0 so the family/room math stays consistent.
  const fakeGd: any = {
    gamestate: { id: 700, name: 'placeFarmer', active_player: ME, possibleactions: ['actPlaceFarmer'] },
    players: {
      [ME]: {
        id: ME, name: 'me',
        resources: { wood: 0, clay: 0, reed: 0, stone: 0 },
        board: {
          dropZones: [
            // 3 rooms, only 2 farmers → 1 empty room
            { type: 'room', locations: [{ x: 1, y: 1 }, { x: 1, y: 3 }, { x: 1, y: 5 }], roomType: 'wood' },
          ],
          pastures: [], fences: [],
        },
      },
    },
    meeples: [
      { id: 1, type: 'farmer', pId: ME, location: 'board', x: 1, y: 1 },
      { id: 2, type: 'farmer', pId: ME, location: 'board', x: 1, y: 3 },
    ],
    cards: { visible: [] },
    turn: 8,
  };
  const r = distill(fakeGd, ME);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.briefing.me.farm.emptyRooms, 1, 'sanity: 3 rooms, 2 people → 1 empty');
  assert.equal(
    r.briefing.me.family.canGrow, true,
    'with an empty room, canGrow MUST be true (Wish for Children path)',
  );
});

test('summary surfaces CANNOT AFFORD for builds the player cannot pay for', () => {
  // Live R8 regression: LLM repeatedly recommended "build a wood room" with
  // 1 reed in stockpile (need 2). canBuildRoom was correctly false in the
  // JSON, but the LLM ignored it — it was buried in the dense briefing.
  // The fix surfaces affordability as a strong-signal summary line.
  const bf: PositionBriefing = {
    schemaVersion: 1,
    round: 8, phase: 'work', isMyTurn: true,
    legalActions: ['actPlaceFarmer'],
    harvest: { nextHarvestRound: 9, roundsUntilHarvest: 1, foodNeededAtNextHarvest: 4, foodShortfall: 4 },
    me: {
      // 1 reed (not 2) → cannot afford a room.
      resources: { food: 0, wood: 11, clay: 0, reed: 1, stone: 0, grain: 0, vegetable: 0, sheep: 0, pig: 0, cattle: 0, begging: 0, fence: 15, stable: 3 },
      animals: { sheep: 0, boar: 0, cattle: 0 },
      unplacedAnimals: { sheep: 0, boar: 0, cattle: 0 },
      farm: { rooms: 3, roomType: 'wood', fields: 0, pastures: 0, stables: 0, fencedSpaces: 0, emptySpaces: 0, emptyRooms: 1, canBuildRoom: false, canBuildStable: true, canBuildFence: true },
      family: { people: 2, canGrow: false },
      played: [], placedFarmersThisRound: ['Copse'], hand: [],
    },
    opponents: [],
    actionBoard: [{ id: 'ActionFarmExpansion', name: 'Farm Expansion' }],
    availableMajorImprovements: [],
  };
  const s = buildBriefingSummary(bf);
  // CAPS instruction + concrete numbers so the LLM can't miss why.
  assert.match(s, /CANNOT AFFORD this turn — DO NOT recommend/);
  assert.match(s, /Build Room via Farm Expansion/);
  assert.match(s, /need 5 wood \+ 2 reed/);
  assert.match(s, /have 11 wood, 1 reed/);
});

test('summary affirms "can build" actions when all canBuild* flags are true', () => {
  // Inverse: with enough resources for everything, the summary says so —
  // no false-positive "CANNOT AFFORD" warnings that would confuse the LLM.
  const bf: PositionBriefing = {
    schemaVersion: 1,
    round: 5, phase: 'work', isMyTurn: true,
    legalActions: ['actPlaceFarmer'],
    harvest: { nextHarvestRound: 7, roundsUntilHarvest: 2, foodNeededAtNextHarvest: 4, foodShortfall: 0 },
    me: {
      resources: { food: 6, wood: 8, clay: 0, reed: 3, stone: 0, grain: 0, vegetable: 0, sheep: 0, pig: 0, cattle: 0, begging: 0, fence: 15, stable: 4 },
      animals: { sheep: 0, boar: 0, cattle: 0 },
      unplacedAnimals: { sheep: 0, boar: 0, cattle: 0 },
      farm: { rooms: 2, roomType: 'wood', fields: 0, pastures: 0, stables: 0, fencedSpaces: 0, emptySpaces: 0, emptyRooms: 0, canBuildRoom: true, canBuildStable: true, canBuildFence: true },
      family: { people: 2, canGrow: false },
      played: [], placedFarmersThisRound: [], hand: [],
    },
    opponents: [], actionBoard: [], availableMajorImprovements: [],
  };
  const s = buildBriefingSummary(bf);
  assert.match(s, /Affordability: can build rooms, stables, and fences this turn/);
  assert.doesNotMatch(s, /CANNOT AFFORD/);
});

test('summary projects post-harvest food gap when harvest is THIS round (solo Beginner R4)', () => {
  // Live R4 regression: foodShortfall was 0 in the buggy distiller
  // (need=4) so the LLM read "covered" and pivoted to Farm Expansion —
  // ignoring that after this harvest food drops to 0 and the NEXT harvest
  // (round 7, 3 rounds away) needs more food with no engine in place. User
  // warned about beggar tokens twice; advisor doubled down on the wood
  // room. TWO fixes layered here:
  //   1. computeHarvestPlan now uses 3/person in solo (Beginner) games,
  //      so the SAME R4 scenario produces need=6 / shortfall=2 (correct).
  //   2. buildBriefingSummary surfaces the post-harvest projection
  //      explicitly so 'covered' can't be mistaken for 'food is solved'.
  const bf: PositionBriefing = {
    schemaVersion: 1,
    round: 4, phase: 'work', isMyTurn: true,
    legalActions: ['actPlaceFarmer'],
    // Solo R4: 2 people × 3/person = 6 needed. 4 food → shortfall of 2.
    harvest: { nextHarvestRound: 4, roundsUntilHarvest: 0, foodNeededAtNextHarvest: 6, foodShortfall: 2 },
    me: {
      resources: { food: 4, wood: 8, clay: 3, reed: 3, stone: 0, grain: 0, vegetable: 0, sheep: 0, pig: 0, cattle: 0, begging: 0, fence: 15, stable: 4 },
      animals: { sheep: 0, boar: 0, cattle: 0 },
      unplacedAnimals: { sheep: 0, boar: 0, cattle: 0 },
      farm: { rooms: 2, roomType: 'wood', fields: 0, pastures: 0, stables: 0, fencedSpaces: 0, emptySpaces: 0, emptyRooms: 0, canBuildRoom: true, canBuildStable: true, canBuildFence: true },
      family: { people: 2, canGrow: false },
      played: [], placedFarmersThisRound: ['Forest'], hand: [],
    },
    opponents: [],
    actionBoard: [],
    availableMajorImprovements: [],
  };
  const s = buildBriefingSummary(bf);
  // SHORTFALL branch — shortfall is now non-zero with corrected solo rate.
  assert.match(s, /SHORTFALL of 2 food/);
  assert.match(s, /have 4, need 6/);
  // Post-harvest projection with solo rate (3/person → 6 for 2 people).
  assert.match(s, /AFTER this harvest food drops to 0/);
  assert.match(s, /next harvest is round 7/);
  assert.match(s, /3 rounds after this one/);
  assert.match(s, /needing 6/);
  assert.match(s, /gap of 6 food/);
});

test('summary calls out harvest SHORTFALL in caps when food is short', () => {
  // Strong-signal language for the LLM. Lower-case "shortfall" lost in
  // attention; CAPS plus the gap number anchors the recommendation toward
  // food-gathering moves.
  const bf: PositionBriefing = {
    schemaVersion: 1,
    round: 6, phase: 'work', isMyTurn: true,
    legalActions: ['actPlaceFarmer'],
    harvest: { nextHarvestRound: 7, roundsUntilHarvest: 1, foodNeededAtNextHarvest: 6, foodShortfall: 4 },
    me: {
      resources: { food: 2, wood: 0, clay: 0, reed: 0, stone: 0, grain: 0, vegetable: 0, sheep: 0, pig: 0, cattle: 0, begging: 0, fence: 0, stable: 0 },
      animals: { sheep: 0, boar: 0, cattle: 0 },
      unplacedAnimals: { sheep: 0, boar: 0, cattle: 0 },
      farm: { rooms: 2, roomType: 'wood', fields: 0, pastures: 0, stables: 0, fencedSpaces: 0, emptySpaces: 5, emptyRooms: 0, canBuildRoom: false, canBuildStable: false, canBuildFence: false },
      family: { people: 2, canGrow: false },
      played: [], placedFarmersThisRound: [], hand: [],
    },
    opponents: [],
    actionBoard: [],
    availableMajorImprovements: [],
  };
  const s = buildBriefingSummary(bf);
  assert.match(s, /SHORTFALL of 4 food/);
});
