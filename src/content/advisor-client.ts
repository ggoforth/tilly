// Owns the long-lived advisor Port (content -> worker). Two independent
// in-flight slots — `advise` and `chat` — so a chat message never cancels
// an in-flight advice stream (and vice versa). Starting a new request in a
// slot cancels only the prior request in THAT slot. Streams accumulated text
// to the caller. The OpenRouter key never reaches here — only generated
// text/errors.

import {
  ADVISOR_PORT,
  newRequestId,
  type AdvisorResponse,
  type ChatTurn,
} from '../shared/advisor-msg';
import type { PositionBriefing } from '../shared/briefing';

export interface StreamHandlers {
  onChunk(accumulated: string): void;
  onDone(full: string): void;
  onError(error: string): void;
}

type SlotKind = 'advise' | 'chat';

interface Slot {
  id: string;
  acc: string;
  h: StreamHandlers;
}

class AdvisorClient {
  private port: chrome.runtime.Port | undefined;
  // Independent per-kind slots: a chat must not cancel in-flight advice and
  // vice versa. Each slot only ever holds one request — starting a new one
  // in a slot replaces (and cancels) the prior request in the same slot.
  private slots: Record<SlotKind, Slot | undefined> = {
    advise: undefined,
    chat: undefined,
  };

  private ensurePort(): chrome.runtime.Port {
    if (!this.port) {
      const p = chrome.runtime.connect({ name: ADVISOR_PORT });
      p.onMessage.addListener((m) => this.onMessage(m as AdvisorResponse));
      p.onDisconnect.addListener(() => {
        this.port = undefined;
        // Disconnect orphans both slots — surface to each handler.
        for (const k of ['advise', 'chat'] as const) {
          const s = this.slots[k];
          if (s) {
            this.slots[k] = undefined;
            s.h.onError('advisor disconnected');
          }
        }
      });
      this.port = p;
    }
    return this.port;
  }

  private slotForId(id: string): SlotKind | undefined {
    if (this.slots.advise?.id === id) return 'advise';
    if (this.slots.chat?.id === id) return 'chat';
    return undefined;
  }

  private onMessage(r: AdvisorResponse): void {
    const kind = this.slotForId(r.requestId);
    if (!kind) return;
    const slot = this.slots[kind]!;
    if (r.kind === 'chunk') {
      slot.acc += r.delta;
      slot.h.onChunk(slot.acc);
    } else if (r.kind === 'done') {
      const { h, acc } = slot;
      this.slots[kind] = undefined;
      h.onDone(r.full || acc);
    } else {
      const { h } = slot;
      this.slots[kind] = undefined;
      h.onError(r.error);
    }
  }

  /** Cancel the in-flight request in a specific slot. */
  private cancelSlot(kind: SlotKind): void {
    const slot = this.slots[kind];
    if (!slot) return;
    if (this.port) {
      try {
        this.port.postMessage({ kind: 'cancel', requestId: slot.id });
      } catch {
        /* port already gone */
      }
    }
    this.slots[kind] = undefined;
  }

  /** Cancel everything in flight (e.g. on shutdown / advisor disable). */
  cancel(): void {
    this.cancelSlot('advise');
    this.cancelSlot('chat');
  }

  /** Cancel the advise slot specifically. Chat is untouched. */
  cancelAdvise(): void {
    this.cancelSlot('advise');
  }

  private start(
    kind: SlotKind,
    req:
      | {
          kind: 'advise';
          requestId: string;
          briefing: PositionBriefing;
          history?: ChatTurn[];
        }
      | {
          kind: 'chat';
          requestId: string;
          briefing: PositionBriefing;
          history: ChatTurn[];
          message: string;
        },
    h: StreamHandlers,
  ): void {
    // Replace ONLY the request in this slot; the other slot keeps streaming.
    this.cancelSlot(kind);
    const port = this.ensurePort();
    this.slots[kind] = { id: req.requestId, acc: '', h };
    try {
      port.postMessage(req);
    } catch {
      this.slots[kind] = undefined;
      h.onError('could not reach the advisor worker');
    }
  }

  advise(
    briefing: PositionBriefing,
    history: ChatTurn[] | undefined,
    h: StreamHandlers,
  ): void {
    this.start(
      'advise',
      { kind: 'advise', requestId: newRequestId(), briefing, history },
      h,
    );
  }

  chat(
    briefing: PositionBriefing,
    history: ChatTurn[],
    message: string,
    h: StreamHandlers,
  ): void {
    this.start(
      'chat',
      { kind: 'chat', requestId: newRequestId(), briefing, history, message },
      h,
    );
  }
}

/** Parse the "MOVE: / WHY:" advice shape; tolerant of free-form replies. */
export function parseAdvice(full: string): { move: string; rationale: string } {
  const move = /MOVE:\s*(.+)/i.exec(full)?.[1]?.trim();
  const why = /WHY:\s*([\s\S]+)/i.exec(full)?.[1]?.trim();
  if (move) return { move, rationale: why ?? '' };
  const firstLine = full.trim().split('\n')[0]?.trim() ?? '';
  return { move: firstLine, rationale: full.trim() };
}

export const advisorClient = new AdvisorClient();
