import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlacementTracker } from '../src/probe/placement-tracker';

test('starts empty', () => {
  const t = new PlacementTracker();
  assert.equal(t.view().size, 0);
  assert.deepEqual(t.placementsForPlayer('me'), []);
});

test('placeFarmer adds an entry visible to the right player', () => {
  const t = new PlacementTracker();
  t.onPlaceFarmer('ActionReedBank', 'Reed Bank', 'me');
  assert.equal(t.view().size, 1);
  assert.deepEqual(t.placementsForPlayer('me'), ['Reed Bank']);
  assert.deepEqual(t.placementsForPlayer('opp'), []);
});

test('multiple placements coexist', () => {
  const t = new PlacementTracker();
  t.onPlaceFarmer('ActionReedBank', 'Reed Bank', 'me');
  t.onPlaceFarmer('ActionForest', 'Forest', 'opp');
  assert.equal(t.view().size, 2);
  assert.deepEqual(t.placementsForPlayer('me'), ['Reed Bank']);
  assert.deepEqual(t.placementsForPlayer('opp'), ['Forest']);
});

test('returnHome clears the map (round over)', () => {
  const t = new PlacementTracker();
  t.onPlaceFarmer('ActionReedBank', 'Reed Bank', 'me');
  t.onPlaceFarmer('ActionForest', 'Forest', 'opp');
  t.onReturnHome();
  assert.equal(t.view().size, 0);
});

test('duplicate placeFarmer is idempotent (overwrites cleanly)', () => {
  // BGA can resend a notification on reconnect — second arrival should not
  // double-count or corrupt the entry.
  const t = new PlacementTracker();
  t.onPlaceFarmer('ActionReedBank', 'Reed Bank', 'me');
  t.onPlaceFarmer('ActionReedBank', 'Reed Bank', 'me');
  assert.equal(t.view().size, 1);
  assert.deepEqual(t.placementsForPlayer('me'), ['Reed Bank']);
});

test('empty cardId or pId is ignored', () => {
  const t = new PlacementTracker();
  t.onPlaceFarmer('', 'Reed Bank', 'me');
  t.onPlaceFarmer('ActionReedBank', 'Reed Bank', '');
  assert.equal(t.view().size, 0);
});

test('seedFromMeeples picks up existing placements on mid-round attach', () => {
  // The scenario: page reload mid-round. We missed live placeFarmer events
  // but gamedatas.meeples HAS (eventually) caught up — seed from that.
  const t = new PlacementTracker();
  const meeples = [
    { type: 'farmer', pId: 'me', location: 'ActionForest' },
    { type: 'farmer', pId: 'opp', location: 'ActionReedBank' },
    { type: 'farmer', pId: 'me', location: 'board' },
    { type: 'farmer', pId: 'me', location: 'reserve' },
    { type: 'wood', pId: 'me', location: 'ActionForest' }, // resource — ignore
  ];
  const nameByCard = new Map([
    ['ActionForest', 'Forest'],
    ['ActionReedBank', 'Reed Bank'],
  ]);
  t.seedFromMeeples(meeples, (id) => nameByCard.get(id) ?? id);
  assert.equal(t.view().size, 2);
  assert.deepEqual(t.placementsForPlayer('me').sort(), ['Forest']);
  assert.deepEqual(t.placementsForPlayer('opp'), ['Reed Bank']);
});

test('seedFromMeeples does NOT overwrite a live notification entry', () => {
  // Notification is strictly fresher than the meeple snapshot.
  const t = new PlacementTracker();
  t.onPlaceFarmer('ActionForest', 'Forest', 'me');
  // The (stale) meeple snapshot somehow attributes Forest to opp — ignore.
  t.seedFromMeeples(
    [{ type: 'farmer', pId: 'opp', location: 'ActionForest' }],
    (id) => id,
  );
  assert.equal(t.view().get('ActionForest')?.pId, 'me');
});

test('reset wipes all state (probe detach)', () => {
  const t = new PlacementTracker();
  t.onPlaceFarmer('ActionForest', 'Forest', 'me');
  t.reset();
  assert.equal(t.view().size, 0);
});
