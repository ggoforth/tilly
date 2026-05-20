// Pure settle state machine for the probe. Encapsulates "wait for the
// notification burst to quiesce after a decision arrives, but never wait
// longer than a hard cap" — independent of clocks (caller supplies `now`),
// independent of DOM. Unit-testable.
//
// Phases:
//   idle       — no decision in flight
//   observing  — decision arrived; settle window open, may be extended by
//                activity; armed to emit on idle elapse or cap elapse
//   emitted    — caller has been told to emit; awaiting `consumeEmit()`
//                before any future emit (prevents double-fire)
//
// The caller drives the state machine: feeds in decision-entered/exited and
// activity events, then calls `tick(now)` (typically once per probe boot
// tick) to learn whether it should emit a briefing right now.

export interface SettlerConfig {
  /** Quiet window after the last activity before emitting (ms). */
  idleMs?: number;
  /** Hard cap from decision-entered to forced emit (ms). */
  capMs?: number;
}

export type SettlerPhase = 'idle' | 'observing' | 'emitted';
export type SettlerReason = 'idle-settled' | 'cap';

export interface SettlerStatus {
  phase: SettlerPhase;
  shouldEmit: boolean;
  reason?: SettlerReason;
  /** Probe activities counted while observing (resets per decision). */
  burstCount: number;
}

const DEFAULT_IDLE_MS = 800;
const DEFAULT_CAP_MS = 2500;

export class Settler {
  private idleMs: number;
  private capMs: number;
  private phase: SettlerPhase = 'idle';
  private decisionAt = 0;
  private lastActivityAt = 0;
  private burstCount = 0;
  private pendingEmit = false;
  private pendingReason: SettlerReason | undefined;

  constructor(config: SettlerConfig = {}) {
    this.idleMs = config.idleMs ?? DEFAULT_IDLE_MS;
    this.capMs = config.capMs ?? DEFAULT_CAP_MS;
  }

  /** A real decision just arrived. Opens (or refreshes) the settle window. */
  onDecisionEntered(now: number): SettlerStatus {
    this.phase = 'observing';
    this.decisionAt = now;
    this.lastActivityAt = now;
    this.burstCount = 0;
    this.pendingEmit = false;
    this.pendingReason = undefined;
    return this.status();
  }

  /** A probe event (notification or transition) arrived. Resets idle clock. */
  onActivity(now: number): SettlerStatus {
    if (this.phase !== 'observing') return this.status();
    this.lastActivityAt = now;
    this.burstCount += 1;
    return this.status();
  }

  /** We left the decision (not my turn / gate now false). Cancels the wait. */
  onDecisionExited(): SettlerStatus {
    this.phase = 'idle';
    this.pendingEmit = false;
    this.pendingReason = undefined;
    return this.status();
  }

  /** Caller asks whether to emit right now. Reads clocks, does not mutate
   *  except to flip into the `emitted` phase. */
  tick(now: number): SettlerStatus {
    if (this.phase !== 'observing') return this.status();
    const sinceActivity = now - this.lastActivityAt;
    const sinceDecision = now - this.decisionAt;
    if (sinceActivity >= this.idleMs) {
      this.pendingEmit = true;
      this.pendingReason = 'idle-settled';
      this.phase = 'emitted';
    } else if (sinceDecision >= this.capMs) {
      this.pendingEmit = true;
      this.pendingReason = 'cap';
      this.phase = 'emitted';
    }
    return this.status();
  }

  /** Caller has emitted the briefing; clear the pending flag and go idle. */
  consumeEmit(): SettlerStatus {
    this.pendingEmit = false;
    this.pendingReason = undefined;
    this.phase = 'idle';
    return this.status();
  }

  /** Hard reset — e.g. on probe detach / SPA navigation. */
  reset(): SettlerStatus {
    this.phase = 'idle';
    this.decisionAt = 0;
    this.lastActivityAt = 0;
    this.burstCount = 0;
    this.pendingEmit = false;
    this.pendingReason = undefined;
    return this.status();
  }

  status(): SettlerStatus {
    const out: SettlerStatus = {
      phase: this.phase,
      shouldEmit: this.pendingEmit,
      burstCount: this.burstCount,
    };
    if (this.pendingReason) out.reason = this.pendingReason;
    return out;
  }
}
