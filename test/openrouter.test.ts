// Tests for buildMessages — verifies the prompt-caching marker stays
// attached to the system message. Regression coverage: without the
// cache_control block, OpenRouter / Anthropic won't cache the ~6K-token
// preamble across turns and per-game cost roughly triples (cache read
// is 0.1× input, vs full 1× without caching).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from '../src/advisor/openrouter';
import type { PositionBriefing } from '../src/shared/briefing';

const baseBriefing: PositionBriefing = {
  schemaVersion: 1,
  round: 1,
  phase: 'work',
  isMyTurn: true,
  legalActions: ['actPlaceFarmer'],
  harvest: {
    nextHarvestRound: 4,
    roundsUntilHarvest: 3,
    foodNeededAtNextHarvest: 4,
    foodShortfall: 0,
  },
  me: {
    resources: {
      wood: 0, clay: 0, reed: 0, stone: 0, food: 3,
      grain: 0, vegetable: 0, sheep: 0, pig: 0, cattle: 0,
      begging: 0, fence: 0, stable: 0,
    },
    animals: { sheep: 0, boar: 0, cattle: 0 },
    unplacedAnimals: { sheep: 0, boar: 0, cattle: 0 },
    farm: {
      rooms: 2, roomType: 'wood', fields: 0, pastures: 0, stables: 0,
      fencedSpaces: 0, emptySpaces: 0, emptyRooms: 0,
      canBuildRoom: false, canBuildStable: false, canBuildFence: false,
    },
    family: { people: 2, canGrow: false },
    played: [], placedFarmersThisRound: [], hand: [],
  },
  opponents: [],
  actionBoard: [],
  availableMajorImprovements: [],
};

test('buildMessages: system message is a content block with cache_control', () => {
  // Anthropic / OpenRouter prompt caching requires the cacheable prefix
  // to be wrapped in a structured content block carrying the marker.
  // Plain `content: "..."` strings do NOT activate caching.
  const msgs = buildMessages({
    kind: 'advise',
    requestId: 'test-1',
    briefing: baseBriefing,
  });
  const system = msgs[0];
  assert.ok(system, 'system message must exist');
  assert.equal(system.role, 'system', 'first message must be role=system');
  assert.ok(
    Array.isArray(system.content),
    'system content MUST be an array (structured blocks), not a plain string — otherwise caching does not activate',
  );
  const block = (system.content as Array<{ type: string; text: string; cache_control?: { type: string } }>)[0];
  assert.equal(block?.type, 'text', 'system content[0] must be a text block');
  assert.ok(
    typeof block?.text === 'string' && block.text.length > 1000,
    'system text must contain the full STRATEGY_PREAMBLE',
  );
  assert.deepEqual(
    block?.cache_control, { type: 'ephemeral' },
    'cache_control marker MUST be present and set to ephemeral',
  );
});

test('buildMessages: user/assistant messages stay as plain strings', () => {
  // Only the system message needs the cache_control wrapper; user and
  // assistant content stays as plain strings to keep the request body
  // small and the API contract familiar.
  const msgs = buildMessages({
    kind: 'chat',
    requestId: 'test-2',
    briefing: baseBriefing,
    history: [
      { role: 'user', content: 'why?' },
      { role: 'assistant', content: 'because' },
    ],
    message: 'what should I do?',
  });
  for (let i = 1; i < msgs.length; i++) {
    assert.equal(
      typeof msgs[i]!.content, 'string',
      `message ${i} (${msgs[i]!.role}) must have a plain-string content`,
    );
  }
});

test('buildMessages: get-last-prompt and cancel produce no messages', () => {
  // Sanity — these are control-plane requests, not chat completions.
  assert.deepEqual(
    buildMessages({ kind: 'get-last-prompt', requestId: 'x' }),
    [],
  );
  assert.deepEqual(
    buildMessages({ kind: 'cancel', requestId: 'x' }),
    [],
  );
});
