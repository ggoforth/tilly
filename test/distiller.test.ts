import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { distill } from '../src/advisor/distiller';

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

test('computeHarvestPlan: shortfall surfaces correctly across rounds', async () => {
  const { computeHarvestPlan } = await import('../src/advisor/distiller');
  // Round 1, 2 people, 0 food → next harvest R4, 3 rounds away, need 4, gap 4
  let plan = computeHarvestPlan(1, 2, 0);
  assert.equal(plan.nextHarvestRound, 4);
  assert.equal(plan.roundsUntilHarvest, 3);
  assert.equal(plan.foodNeededAtNextHarvest, 4);
  assert.equal(plan.foodShortfall, 4);
  // R4 with 3 food and 2 people → harvest is now (0 away), need 4, gap 1
  plan = computeHarvestPlan(4, 2, 3);
  assert.equal(plan.nextHarvestRound, 4);
  assert.equal(plan.roundsUntilHarvest, 0);
  assert.equal(plan.foodShortfall, 1);
  // R5 → next harvest R7, 2 rounds away
  plan = computeHarvestPlan(5, 3, 0);
  assert.equal(plan.nextHarvestRound, 7);
  assert.equal(plan.roundsUntilHarvest, 2);
  assert.equal(plan.foodNeededAtNextHarvest, 6);
  // R14 (final harvest) with plenty of food → no shortfall, this round IS harvest
  plan = computeHarvestPlan(14, 4, 10);
  assert.equal(plan.nextHarvestRound, 14);
  assert.equal(plan.roundsUntilHarvest, 0);
  assert.equal(plan.foodShortfall, 0);
  // R15 (past final) → no future harvest
  plan = computeHarvestPlan(15, 3, 0);
  assert.equal(plan.nextHarvestRound, null);
  assert.equal(plan.roundsUntilHarvest, null);
  assert.equal(plan.foodShortfall, 6);
});

test('distill populates briefing.harvest from current round + family + food', () => {
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
  // R3, 2 farmers, 0 food → harvest at R4, 1 round away, need 4 food, gap 4
  assert.equal(r.briefing.harvest.nextHarvestRound, 4);
  assert.equal(r.briefing.harvest.roundsUntilHarvest, 1);
  assert.equal(r.briefing.harvest.foodShortfall, 4);
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
