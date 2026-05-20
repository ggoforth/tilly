import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Settler } from '../src/probe/settle';

const IDLE = 800;
const CAP = 2500;

test('idle settle: decision then quiet → emits with idle-settled', () => {
  const s = new Settler({ idleMs: IDLE, capMs: CAP });
  const t0 = 1000;
  s.onDecisionEntered(t0);
  // Just before idle window closes — no emit yet.
  let st = s.tick(t0 + IDLE - 1);
  assert.equal(st.shouldEmit, false, 'should not emit before idle window closes');
  // After idle elapses — emit.
  st = s.tick(t0 + IDLE + 1);
  assert.equal(st.shouldEmit, true);
  assert.equal(st.reason, 'idle-settled');
});

test('activity resets idle timer', () => {
  const s = new Settler({ idleMs: IDLE, capMs: CAP });
  const t0 = 0;
  s.onDecisionEntered(t0);
  // Activity 500ms later resets idle clock.
  s.onActivity(500);
  // 1200ms total since decision; only 700ms since last activity — no emit yet.
  let st = s.tick(1200);
  assert.equal(st.shouldEmit, false);
  // 500 + IDLE = 1300ms since last activity.
  st = s.tick(500 + IDLE + 10);
  assert.equal(st.shouldEmit, true);
  assert.equal(st.reason, 'idle-settled');
});

test('continuous burst hits cap and emits exactly once at cap', () => {
  const s = new Settler({ idleMs: IDLE, capMs: CAP });
  const t0 = 0;
  s.onDecisionEntered(t0);
  // Activity every 100ms past the cap.
  let emitted = 0;
  for (let t = 100; t < CAP + 200; t += 100) {
    s.onActivity(t);
    const st = s.tick(t);
    if (st.shouldEmit) {
      emitted += 1;
      s.consumeEmit();
    }
  }
  assert.equal(emitted, 1, `expected exactly one cap emit, got ${emitted}`);
});

test('cap reason recorded when cap fires before idle', () => {
  const s = new Settler({ idleMs: IDLE, capMs: CAP });
  s.onDecisionEntered(0);
  // Keep activity well within idle window past the cap.
  for (let t = 200; t <= CAP + 50; t += 200) s.onActivity(t);
  const st = s.tick(CAP + 50);
  assert.equal(st.shouldEmit, true);
  assert.equal(st.reason, 'cap');
});

test('onDecisionExited cancels a pending settle', () => {
  const s = new Settler({ idleMs: IDLE, capMs: CAP });
  s.onDecisionEntered(0);
  s.onActivity(100);
  s.onDecisionExited();
  // Way past idle — should not emit, the decision is gone.
  const st = s.tick(5000);
  assert.equal(st.shouldEmit, false);
});

test('consumeEmit prevents re-emit until next decision', () => {
  const s = new Settler({ idleMs: IDLE, capMs: CAP });
  s.onDecisionEntered(0);
  let st = s.tick(IDLE + 10);
  assert.equal(st.shouldEmit, true);
  s.consumeEmit();
  // Even much later — no re-emit without a new decision.
  st = s.tick(10000);
  assert.equal(st.shouldEmit, false);
});

test('a new decision after consumeEmit can fire again', () => {
  const s = new Settler({ idleMs: IDLE, capMs: CAP });
  s.onDecisionEntered(0);
  let st = s.tick(IDLE + 10);
  assert.equal(st.shouldEmit, true);
  s.consumeEmit();
  // New decision arrives.
  s.onDecisionEntered(5000);
  st = s.tick(5000 + IDLE + 10);
  assert.equal(st.shouldEmit, true);
  assert.equal(st.reason, 'idle-settled');
});

test('burstCount counts activity within the window', () => {
  const s = new Settler({ idleMs: IDLE, capMs: CAP });
  s.onDecisionEntered(0);
  s.onActivity(100);
  s.onActivity(150);
  s.onActivity(200);
  const st = s.tick(250);
  assert.equal(st.burstCount, 3);
});

test('activity outside a decision window is a no-op', () => {
  const s = new Settler({ idleMs: IDLE, capMs: CAP });
  s.onActivity(100);
  s.onActivity(200);
  const st = s.tick(1000);
  assert.equal(st.shouldEmit, false);
  assert.equal(st.phase, 'idle');
});
