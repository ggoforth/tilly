import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  isMeaningfulDecision,
  isStrategicDecision,
  MECHANICAL_GAMESTATES,
  TRIVIAL_ACTIONS,
} from '../src/shared/decision-gate';
import type { PositionBriefing } from '../src/shared/briefing';
import { distill } from '../src/advisor/distiller';

const FX = `${process.cwd()}/test/fixtures/`;
const ME = '94800135';

const loadGd = (f: string): unknown => JSON.parse(readFileSync(FX + f, 'utf8'));

const briefingFrom = (gdFile: string) => {
  const r = distill(loadGd(gdFile), ME);
  assert.ok(r.ok, `distill must succeed for ${gdFile}`);
  if (!r.ok) throw new Error('unreachable');
  return r.briefing;
};

test('TRIVIAL_ACTIONS holds the confirm/restart/pass set', () => {
  assert.ok(TRIVIAL_ACTIONS.has('actConfirmTurn'));
  assert.ok(TRIVIAL_ACTIONS.has('actRestart'));
  assert.ok(TRIVIAL_ACTIONS.has('actPassOptionalAction'));
  assert.ok(!TRIVIAL_ACTIONS.has('actPlaceFarmer'));
});

test('isStrategicDecision fires ONLY on top-level placement (actPlaceFarmer)', () => {
  // Live observation: sub-states (construct/improvement/exchange/plow/etc.)
  // generated noisy advice that ignored the sub-state context — "Grab
  // Fireplace for 2 clay" fired while user was mid-Farm-Expansion build.
  // The fix: auto-advice ONLY fires when legalActions contains actPlaceFarmer
  // (the BGA code for top-level "place a farmer on an action space" decisions).
  const placeBriefing = briefingFrom('decision.gamedatas.json');

  // (1) Real top-level placement → strategic.
  const place: PositionBriefing = {
    ...placeBriefing,
    isMyTurn: true,
    legalActions: ['actPlaceFarmer', 'actRestart'],
  };
  assert.equal(isStrategicDecision(place, 'placeFarmer'), true,
    'top-level actPlaceFarmer decisions must fire auto-advice');

  // (2) Sub-state with no actPlaceFarmer (build choice) → NOT strategic.
  const construct: PositionBriefing = {
    ...placeBriefing,
    isMyTurn: true,
    legalActions: ['actBuildRoom', 'actBuildStables', 'actRestart'],
  };
  assert.equal(isStrategicDecision(construct, 'construct'), false,
    'mid-Farm-Expansion construct sub-state must NOT fire auto-advice');

  // (3) Sub-state with cooking exchange → NOT strategic.
  const exchange: PositionBriefing = {
    ...placeBriefing,
    isMyTurn: true,
    legalActions: ['actExchange', 'actPassOptionalAction'],
  };
  assert.equal(isStrategicDecision(exchange, 'exchange'), false);

  // (4) Mechanical states stay filtered even if (hypothetically) actPlaceFarmer
  // were legal — belt-and-suspenders second gate.
  const plowWithPlace: PositionBriefing = {
    ...placeBriefing,
    isMyTurn: true,
    legalActions: ['actPlaceFarmer', 'actPlow'],
  };
  assert.equal(isStrategicDecision(plowWithPlace, 'plow'), false,
    'mechanical gamestate names always filtered, even with actPlaceFarmer present');

  // (5) Trivial-only actions → NOT strategic (no real choice).
  const confirmOnly: PositionBriefing = {
    ...placeBriefing,
    isMyTurn: true,
    legalActions: ['actConfirmTurn', 'actRestart'],
  };
  assert.equal(isStrategicDecision(confirmOnly, 'confirmTurn'), false);

  // (6) Every mechanical name is still filtered regardless of legalActions.
  for (const name of MECHANICAL_GAMESTATES) {
    assert.equal(
      isStrategicDecision(place, name),
      false,
      `${name} must be filtered from auto-advice even with actPlaceFarmer in legalActions`,
    );
  }
});

test('a real my-turn decision returns true', () => {
  const b = briefingFrom('decision.gamedatas.json');
  if (b.isMyTurn) {
    assert.equal(isMeaningfulDecision(b), true);
  } else {
    // synthesize my-turn version for the contract test
    const fake = { ...b, isMyTurn: true };
    assert.equal(isMeaningfulDecision(fake), true);
  }
});

test('a trivial-only legal-actions briefing returns false', () => {
  const b = briefingFrom('decision.gamedatas.json');
  const fake = {
    ...b,
    isMyTurn: true,
    legalActions: ['actConfirmTurn', 'actRestart'],
  };
  assert.equal(isMeaningfulDecision(fake), false);
});

test('not my turn returns false regardless of legalActions', () => {
  const b = briefingFrom('decision.gamedatas.json');
  const fake = {
    ...b,
    isMyTurn: false,
    legalActions: ['actPlaceFarmer', 'actPassOptionalAction', 'actRestart'],
  };
  assert.equal(isMeaningfulDecision(fake), false);
});

test('empty legalActions returns false', () => {
  const b = briefingFrom('decision.gamedatas.json');
  const fake = { ...b, isMyTurn: true, legalActions: [] };
  assert.equal(isMeaningfulDecision(fake), false);
});

// Corpus invariant: every fixture decision-point where the snapshot shows
// "your turn with non-trivial actions" must pass the gate. This regression-
// protects against silent phase exclusion (the v1 whitelist bug).
test('corpus invariant: my-turn-with-meaningful-actions briefings all pass the gate', () => {
  const files = readdirSync(FX).filter((f) => f.endsWith('.gamedatas.json'));
  let checked = 0;
  for (const f of files) {
    const gd = loadGd(f) as Record<string, unknown>;
    const gs = (gd['gamestate'] as Record<string, unknown>) ?? {};
    const acts = (gs['possibleactions'] as string[] | undefined) ?? [];
    const meaningful = acts.filter((a) => !TRIVIAL_ACTIONS.has(a));
    const r = distill(gd, ME);
    if (!r.ok) continue;
    if (r.briefing.isMyTurn && meaningful.length > 0) {
      assert.equal(
        isMeaningfulDecision(r.briefing),
        true,
        `${f}: my-turn briefing with meaningful actions ${JSON.stringify(meaningful)} did not pass the gate`,
      );
      checked += 1;
    }
  }
  // We must have actually exercised at least one fixture; otherwise the
  // invariant is silently vacuous.
  assert.ok(checked >= 1, `corpus invariant exercised zero fixtures (got ${checked})`);
});
