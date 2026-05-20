// Pure tri-state health derivation + a small transition tracker.
// Kept dependency-free and pure so it is trivially unit-testable later.

import type { Health } from './types';

export interface HealthSignal {
  attached: boolean;
  gamedatasReadable: boolean;
  /** At least one game notification has actually been captured. */
  notificationsFlowing: boolean;
}

/**
 * healthy   = probe attached, gamedatas readable, notification hooks installed
 *             (briefings flow on real decisions even during quiet idle periods)
 * degraded  = probe gave up on notification interception and fell back to
 *             snapshot/MutationObserver polling. Briefings still flow, but
 *             the settle window has no activity signal to extend.
 * unhealthy = probe not attached or gamedatas unreadable
 *
 * `notificationsFlowing` is misnamed for historical reasons: callers pass
 * `!msg.degraded` from the probe heartbeat. The flag means "the probe is in
 * notification mode, not snapshot-fallback mode" — NOT "we have seen a notif."
 */
export function computeHealth(s: HealthSignal): Health {
  if (!s.attached || !s.gamedatasReadable) return 'unhealthy';
  if (!s.notificationsFlowing) return 'degraded';
  return 'healthy';
}

export function reasonFor(s: HealthSignal): string {
  if (!s.attached) return 'probe not attached to a game';
  if (!s.gamedatasReadable) return 'gameui.gamedatas unreadable';
  if (!s.notificationsFlowing) return 'probe fell back to snapshot polling (notif hooks failed)';
  return 'notifications + state capture active';
}

export type HealthChange = { status: Health; reason: string };

/** Tracks the current health and yields a change only on transition. */
export class HealthTracker {
  private current: Health | null = null;

  /** Returns a HealthChange when the status changed, otherwise null. */
  update(signal: HealthSignal): HealthChange | null {
    const status = computeHealth(signal);
    if (status === this.current) return null;
    this.current = status;
    return { status, reason: reasonFor(signal) };
  }

  get value(): Health | null {
    return this.current;
  }
}
