// Message contracts. The probe (MAIN world) and content script (isolated world)
// share the page but not JS context, so they talk via window.postMessage with a
// namespaced tag. Content <-> service worker talk via chrome.runtime messaging.

import type { NotifChannel } from './types';
import type { PositionBriefing } from './briefing';

/** Tag on every probe->content window message; used to filter foreign messages. */
export const PROBE_TAG = 'AGRI_OBS_PROBE_v1';

export interface ProbeTableMeta {
  tableId: string;
  gameName: string;
  me: string;
  players: { id: string; name: string; color?: string; order?: number }[];
  variant?: string;
}

/** Probe -> content payloads (wrapped in { tag: PROBE_TAG, msg }). */
export type ProbeMessage =
  // gamedatas is intentionally NOT in the attach payload: content holds only
  // distilled briefings, so cloning multi-MB gamedatas across the world
  // boundary at attach time is pure cost. Probe distills on demand instead.
  | { type: 'attached'; meta: ProbeTableMeta }
  | { type: 'detached'; reason: string }
  | {
      // Lightweight: notifications no longer carry a full gamedatas clone
      // (that per-notification structuredClone was the main-thread cost behind
      // the in-game lag). State freshness comes from timer/gamestate snapshots.
      type: 'notification';
      name: string;
      channel: NotifChannel;
      args: unknown;
      gamestateId?: string | number;
      activePlayerId?: string;
    }
  | {
      type: 'snapshot';
      source: 'timer' | 'dom';
      gamestateId?: string | number;
      activePlayerId?: string;
      gamedatas: unknown;
    }
  | {
      type: 'gamestate';
      from?: string | number;
      to: string | number;
      name?: string;
      description?: string;
      activePlayerId?: string;
      possibleActions?: unknown;
      args?: unknown;
    }
  | {
      // periodic heartbeat so content can compute health
      type: 'status';
      attached: boolean;
      gamedatasReadable: boolean;
      notifMechanism: NotifChannel | null;
      notifsSeen: number;
      degraded: boolean;
    }
  | { type: 'clone-error'; reason: string }
  // Distilled in the probe (no gamedatas clone crosses the boundary). This is
  // the advisor's state source on the hot path. `gamestateId/Name/active` are
  // included for the dedupe key — they aren't part of the LLM-facing briefing
  // schema but identify the decision instance.
  | {
      type: 'briefing';
      briefing: PositionBriefing;
      gamestateId: string | number;
      gamestateName: string;
      activePlayerId: string;
    }
  // Distill returned {ok:false} or gameui isn't ready; surface to content.
  | { type: 'briefing-error'; reason: string }
  // Diagnostic timing values (distill-ms, settle-duration-ms, etc.).
  // Numeric metrics keep the existing shape; new optional `detail` lets the
  // probe attach a one-line human-readable string for richer Events-panel
  // telemetry (resource drift summaries, briefing summaries, scrape-status).
  | { type: 'metric'; name: string; value: number; detail?: string }
  | { type: 'final'; scores?: unknown; raw?: unknown };

export interface ProbeEnvelope {
  tag: typeof PROBE_TAG;
  msg: ProbeMessage;
}

export function postToContent(msg: ProbeMessage): void {
  const envelope: ProbeEnvelope = { tag: PROBE_TAG, msg };
  window.postMessage(envelope, window.location.origin);
}

export function isProbeEnvelope(data: unknown): data is ProbeEnvelope {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { tag?: unknown }).tag === PROBE_TAG &&
    typeof (data as { msg?: unknown }).msg === 'object'
  );
}

/** Tag on every content->probe window message (inverse direction). */
export const CONTENT_TAG = 'AGRI_OBS_CONTENT_v1';

/** Content -> probe payloads (wrapped in { tag: CONTENT_TAG, msg }). */
export type ContentMessage =
  /** Ask the probe to distill the live gamedatas right now and post a
   *  `briefing` (or `briefing-error`). Used by chat for on-demand freshness. */
  | { type: 'request-briefing' };

export interface ContentEnvelope {
  tag: typeof CONTENT_TAG;
  msg: ContentMessage;
}

export function postToProbe(msg: ContentMessage): void {
  const envelope: ContentEnvelope = { tag: CONTENT_TAG, msg };
  window.postMessage(envelope, window.location.origin);
}

export function isContentEnvelope(data: unknown): data is ContentEnvelope {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { tag?: unknown }).tag === CONTENT_TAG &&
    typeof (data as { msg?: unknown }).msg === 'object'
  );
}

/** Content -> service worker. */
export type WorkerRequest = { type: 'capture-visible-tab' };
export type WorkerResponse =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };
