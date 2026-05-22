import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardTracker } from '../src/probe/card-tracker';

test('CardTracker: onCardOwned records by player and card id', () => {
  const t = new CardTracker();
  t.onCardOwned('100', 'Major_Fireplace1', 'Fireplace');
  t.onCardOwned('100', 'B102_Consultant', 'Consultant');
  t.onCardOwned('200', 'Major_Pottery', 'Pottery');
  const mine = t.cardsForPlayer('100');
  assert.equal(mine.length, 2);
  assert.deepEqual(
    mine.map((c) => c.cardId).sort(),
    ['B102_Consultant', 'Major_Fireplace1'],
  );
  assert.equal(t.cardsForPlayer('200')[0]!.cardName, 'Pottery');
});

test('CardTracker: idempotent on duplicate notifications', () => {
  // BGA can re-fire the same notification on reconnect. Tracker must not
  // grow the list for the same (pid, cardId) pair.
  const t = new CardTracker();
  t.onCardOwned('100', 'Major_Fireplace1', 'Fireplace');
  t.onCardOwned('100', 'Major_Fireplace1', 'Fireplace'); // duplicate
  t.onCardOwned('100', 'Major_Fireplace1', 'Fireplace'); // triplicate
  assert.equal(t.cardsForPlayer('100').length, 1);
});

test('CardTracker: skips inputs with missing pid or cardId', () => {
  const t = new CardTracker();
  // Empty-string args ARE valid string types, just falsy — exercising the
  // tracker's runtime defensiveness against malformed notifications.
  t.onCardOwned('', 'Major_X', 'X');
  t.onCardOwned('100', '', 'X');
  assert.equal(t.cardsForPlayer('100').length, 0);
});

test('CardTracker: view() returns a per-player snapshot map', () => {
  const t = new CardTracker();
  t.onCardOwned('100', 'A', 'Card A');
  t.onCardOwned('100', 'B', 'Card B');
  t.onCardOwned('200', 'C', 'Card C');
  const v = t.view();
  assert.equal(v.get('100')?.length, 2);
  assert.equal(v.get('200')?.length, 1);
  assert.equal(v.get('999'), undefined);
});

test('CardTracker: seedFromPlayerCards picks up only inPlay entries', () => {
  // Mid-game reload: we missed the live buyCard burst. seed from any
  // playerCards that already show location='inPlay'.
  const t = new CardTracker();
  t.seedFromPlayerCards([
    { id: 'Major_Fireplace1', pId: 100, location: 'inPlay' },
    { id: 'B125_EstateWorker', pId: 100, location: 'inPlay' },
    { id: 'A87_Conservator', pId: 100, location: 'hand' }, // ← skip: in hand
    { id: 'Major_Pottery', pId: '200', location: 'inPlay' },
    { id: 'X_Empty', pId: 100 }, // ← skip: no location
  ]);
  assert.equal(t.cardsForPlayer('100').length, 2);
  assert.equal(t.cardsForPlayer('200').length, 1);
});

test('CardTracker: reset wipes all state (probe detach)', () => {
  const t = new CardTracker();
  t.onCardOwned('100', 'X', 'X');
  t.onCardOwned('200', 'Y', 'Y');
  t.reset();
  assert.equal(t.cardsForPlayer('100').length, 0);
  assert.equal(t.cardsForPlayer('200').length, 0);
  assert.equal(t.view().size, 0);
});
