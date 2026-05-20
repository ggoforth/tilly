// content <-> service-worker advisor protocol. Streaming requires a long-lived
// Port (chrome.runtime.connect): content opens it, the worker streams tokens
// back. The OpenRouter key NEVER crosses this boundary — it stays in the worker.

import type { PositionBriefing } from './briefing';

export const ADVISOR_PORT = 'agri-advisor';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** content -> worker (over the port) */
export type AdvisorRequest =
  | {
      kind: 'advise';
      requestId: string;
      briefing: PositionBriefing;
      /** Recent conversation history — same shape as chat. Lets auto-advice
       *  see prior advisor moves AND user pushback so it doesn't repeat
       *  recommendations the user already rejected or learn-from past turns. */
      history?: ChatTurn[];
    }
  | {
      kind: 'chat';
      requestId: string;
      briefing: PositionBriefing;
      history: ChatTurn[];
      message: string;
    }
  | { kind: 'cancel'; requestId: string }
  /** Diagnostic: ask the worker for the most recent assembled prompt so the
   *  user can paste / inspect what the LLM actually saw. The prompt is
   *  built on the worker side (where the API key lives) and the content
   *  script doesn't have the system preamble — this echoes it back on
   *  demand instead of forcing every request to also stream the prompt. */
  | { kind: 'get-last-prompt'; requestId: string };

/** worker -> content (over the port) */
export type AdvisorResponse =
  | { kind: 'chunk'; requestId: string; delta: string }
  | { kind: 'done'; requestId: string; full: string }
  | { kind: 'error'; requestId: string; error: string }
  /** Response to `get-last-prompt`. `prompt` is null if no advise/chat has
   *  been sent yet in this worker session. */
  | { kind: 'last-prompt'; requestId: string; prompt: string | null };

export function newRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
