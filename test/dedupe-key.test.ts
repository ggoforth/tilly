import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionKey } from '../src/shared/dedupe-key';
import type { PositionBriefing } from '../src/shared/briefing';

const baseBriefing = (overrides: Partial<PositionBriefing> = {}): PositionBriefing => ({
  schemaVersion: 1,
  round: 4,
  phase: 'work',
  isMyTurn: true,
  legalActions: ['actPlaceFarmer', 'actPassOptionalAction', 'actRestart'],
  decisionPrompt: 'You must place a person',
  me: {
    resources: { wood: 2, clay: 0, reed: 0, stone: 0, food: 3, grain: 0, vegetable: 0 },
    animals: { sheep: 0, boar: 0, cattle: 0 },
    unplacedAnimals: { sheep: 0, boar: 0, cattle: 0 },
    farm: { rooms: 2, roomType: 'wood', fields: 0, pastures: 0, stables: 0, fencedSpaces: 0, emptySpaces: 0, emptyRooms: 0, canBuildRoom: false, canBuildStable: false, canBuildFence: false },
    family: { people: 2, canGrow: false },
    hand: [],
    played: [],
    placedFarmersThisRound: [],
    score: -3,
  },
  opponents: [],
  actionBoard: [],
  availableMajorImprovements: [],
  harvest: { nextHarvestRound: 4, roundsUntilHarvest: 0, foodNeededAtNextHarvest: 4, foodShortfall: 1 },
  ...overrides,
});

// Embed gamestate id + active player in custom briefing-extras via the new dedupe-key signature
// (the public surface takes a small struct; see decision-key implementation).

test('same briefing yields same key', () => {
  const b = baseBriefing();
  const a = decisionKey(b, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '94800135' });
  const c = decisionKey(b, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '94800135' });
  assert.equal(a, c);
});

test('different gamestate id yields different key', () => {
  const b = baseBriefing();
  const a = decisionKey(b, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '94800135' });
  const c = decisionKey(b, { gamestateId: 21, gamestateName: 'placeFarmer', activePlayerId: '94800135' });
  assert.notEqual(a, c);
});

test('different gamestate name yields different key', () => {
  const b = baseBriefing();
  const a = decisionKey(b, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '94800135' });
  const c = decisionKey(b, { gamestateId: 20, gamestateName: 'occupation', activePlayerId: '94800135' });
  assert.notEqual(a, c);
});

test('consecutive solo placements differentiate via gamestate id', () => {
  // Same activePlayerId (solo: always the user), same legalActions, same round —
  // only gamestate.id increments between consecutive placements.
  const b = baseBriefing();
  const k1 = decisionKey(b, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '94800135' });
  const k2 = decisionKey(b, { gamestateId: 21, gamestateName: 'placeFarmer', activePlayerId: '94800135' });
  assert.notEqual(k1, k2);
});

test('different sorted legalActions yields different key', () => {
  const b1 = baseBriefing({ legalActions: ['actPlaceFarmer', 'actPassOptionalAction'] });
  const b2 = baseBriefing({ legalActions: ['actSow', 'actPassOptionalAction'] });
  const k1 = decisionKey(b1, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '1' });
  const k2 = decisionKey(b2, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '1' });
  assert.notEqual(k1, k2);
});

test('legalActions order does not affect the key (sorted)', () => {
  const b1 = baseBriefing({ legalActions: ['actA', 'actB', 'actC'] });
  const b2 = baseBriefing({ legalActions: ['actC', 'actA', 'actB'] });
  const k1 = decisionKey(b1, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '1' });
  const k2 = decisionKey(b2, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '1' });
  assert.equal(k1, k2);
});

test('different activePlayerId yields different key', () => {
  const b = baseBriefing();
  const k1 = decisionKey(b, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '94800135' });
  const k2 = decisionKey(b, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '84298950' });
  assert.notEqual(k1, k2);
});

test('mid-decision churn in non-key fields does NOT change the key', () => {
  // The key must be stable when optimistic-rendered values change mid-decision.
  const b1 = baseBriefing({
    actionBoard: [{ id: 'x', name: 'X' }],
    me: { ...baseBriefing().me, family: { people: 2, canGrow: false } },
  });
  const b2 = baseBriefing({
    actionBoard: [{ id: 'x', name: 'X', takenBy: 'me' }], // optimistic flip
    me: { ...baseBriefing().me, family: { people: 2, canGrow: false } },
  });
  const k1 = decisionKey(b1, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '1' });
  const k2 = decisionKey(b2, { gamestateId: 20, gamestateName: 'placeFarmer', activePlayerId: '1' });
  assert.equal(k1, k2);
});
