// Isolated-world content script. Owns the session log, persistence, health,
// the sidebar, and (optional) screenshots. Receives all game data from the
// MAIN-world probe via window.postMessage.
//
// OBSERVE-ONLY: this script never dispatches input to the game and never sends
// game data over the network. The only runtime message it sends is a local
// screenshot request to our own service worker.

import { HealthTracker } from '../shared/health';
import { newId, nowIso } from '../shared/log';
import {
  isProbeEnvelope,
  postToProbe,
  type ProbeMessage,
  type WorkerRequest,
  type WorkerResponse,
} from '../shared/messaging';
import {
  isStrategicDecision,
  TRIVIAL_ACTIONS as GATE_TRIVIAL_ACTIONS,
} from '../shared/decision-gate';
import { decisionKey, type DecisionContext } from '../shared/dedupe-key';
import type { GameEvent, Health, RecommendationEvent } from '../shared/types';
import type { PositionBriefing } from '../shared/briefing';
import type { ChatTurn } from '../shared/advisor-msg';
import { SessionBuffer } from './buffer';
import { chromeLocalStorage } from './storage';
import { distill } from '../advisor/distiller';
import { getAdvisorConfig } from '../advisor/config';
import { advisorClient, parseAdvice } from './advisor-client';
import {
  Sidebar,
  type FeedRow,
  type SidebarState,
  type TranscriptMsg,
} from '../sidebar/sidebar';

const EXT_VERSION = chrome.runtime.getManifest().version;
const SCREENSHOT_MIN_GAP_MS = 4000;
const MAX_FEED_ROWS = 250;

function looksLikeAgricolaTable(): boolean {
  return (
    /\bagricola\b/i.test(location.pathname + location.search) &&
    /[?&]table=\d+/.test(location.search)
  );
}

// Only run the UI on Agricola table pages; stay dormant elsewhere on BGA.
if (looksLikeAgricolaTable()) {
  void main();
}

async function main(): Promise<void> {
  const buffer = new SessionBuffer(chromeLocalStorage, EXT_VERSION);
  const health = new HealthTracker();

  let capturing = true;
  let screenshotsEnabled = false;
  let probeAttached = false;
  let healthStatus: Health | null = null;
  let healthReason = 'waiting for probe…';
  let lastScreenshotAt = 0;
  const feed: FeedRow[] = [];

  // Advisor state (separate from telemetry capture).
  let lastSnapshotId = ''; // newest snapshot event id, for notification linkage
  let advisorEnabled = false;
  // Three-phase indicator: reading (waiting for a fresh briefing from the
  // probe), thinking (LLM request dispatched, no tokens yet), streaming
  // (tokens flowing). 'idle' / 'done' / 'error' are terminal and hide the
  // indicator. 'disabled' is the no-key state.
  let advisorPhase:
    | 'disabled'
    | 'idle'
    | 'reading'
    | 'thinking'
    | 'streaming'
    | 'error'
    | 'done' = 'disabled';
  let currentBriefing: PositionBriefing | null = null;
  let latestBriefing: PositionBriefing | null = null; // newest from the probe
  // One continuous conversation: per-turn advice + user Qs + replies, in order.
  const transcript: TranscriptMsg[] = [];
  let pendingRec: RecommendationEvent | undefined;
  // Identifies a distinct decision point so churn/repeat transitions don't
  // re-fire (and cancel) an in-flight request for the same decision.
  let lastAdvisedKey: string | null = null;

  // Trivial actions come from the shared decision-gate module so probe + content
  // agree on the gate semantics. Re-exported under a local name for clarity.
  const TRIVIAL_ACTIONS = GATE_TRIVIAL_ACTIONS;

  // Notification names that unambiguously indicate a player took an action.
  // Used to clear `lastAdvisedKey` so the NEXT decision re-fires advice (in
  // solo, where activePlayerId never flips, this is the only clear trigger).
  const MOVE_NOTIFICATIONS: ReadonlySet<string> = new Set([
    'placeFarmer',
    'playerTookAction',
    'buyCard',
    'addStables',
    'addFences',
    'sow',
    'plow',
    'growFamily',
    'growChildren',
    'harvestCrop',
    'returnHome',
    'exchange',
    'reorganize',
    'construct',
    'renovate',
    'gainResources',
    'collectResources',
    'payResources',
  ]);

  // A chat send can request a fresh briefing from the probe and race it
  // against a 500ms timeout. The 'briefing' case resolves the pending request.
  let pendingBriefingRequest:
    | ((b: import('../shared/briefing').PositionBriefing | null) => void)
    | null = null;

  async function refreshAdvisorEnabled(): Promise<void> {
    advisorEnabled = (await getAdvisorConfig()) !== null;
    if (!advisorEnabled) advisorPhase = 'disabled';
    else if (advisorPhase === 'disabled') advisorPhase = 'idle';
    scheduleRender();
  }

  const sidebar = new Sidebar({
    onToggleCapture: (on) => {
      capturing = on;
      pushFeed('health', on ? 'capture resumed' : 'capture paused');
      scheduleRender();
    },
    onToggleScreenshots: (on) => {
      screenshotsEnabled = on;
      void chrome.storage.local.set({ screenshotsEnabled: on });
      scheduleRender();
    },
    onExport: () => buffer.exportJson(),
    onClear: () => {
      feed.length = 0;
      void buffer.clear();
      scheduleRender();
    },
    onOpenOptions: () => void chrome.runtime.openOptionsPage(),
    onSendChat: (text) => sendChat(text),
  });
  sidebar.mount();

  // (optional config is loaded dead-last — see the end of main())

  let renderQueued = false;
  function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const log = buffer.current;
      const counts = { events: 0, notifications: 0, snapshots: 0, screenshots: 0 };
      if (log) {
        counts.events = log.events.length;
        counts.screenshots = log.screenshots.length;
        for (const e of log.events) {
          if (e.kind === 'notification') counts.notifications += 1;
          else if (e.kind === 'snapshot') counts.snapshots += 1;
        }
      }
      const state: SidebarState = {
        health: healthStatus,
        healthReason,
        probeAttached,
        capturing,
        screenshots: screenshotsEnabled,
        tableId: log?.table.tableId ?? null,
        players: log?.table.players.map((p) => p.name).filter(Boolean) ?? [],
        counts,
        feed: feed.slice(-MAX_FEED_ROWS),
        version: EXT_VERSION,
        transcript: transcript.slice(-250),
        // The 'disabled' marker is a flag for input-gating elsewhere; the
        // indicator itself just hides while disabled by falling through.
        advisorPhase: advisorPhase === 'disabled' ? 'idle' : advisorPhase,
        chatEnabled: advisorEnabled,
        advisorDisabled: !advisorEnabled,
      };
      sidebar.render(state);
    });
  }
  scheduleRender();

  function pushFeed(kind: string, summary: string, myTurn = false): void {
    feed.push({ t: new Date().toLocaleTimeString(), kind, summary, myTurn });
    if (feed.length > MAX_FEED_ROWS * 2) feed.splice(0, feed.length - MAX_FEED_ROWS);
  }

  function add(event: GameEvent): void {
    buffer.append(event);
  }

  async function maybeScreenshot(
    reason: 'my-turn' | 'round' | 'harvest' | 'game-end',
  ): Promise<void> {
    if (!screenshotsEnabled || !capturing) return;
    const now = Date.now();
    if (now - lastScreenshotAt < SCREENSHOT_MIN_GAP_MS) return;
    lastScreenshotAt = now;
    try {
      const res = (await chrome.runtime.sendMessage<WorkerRequest>({
        type: 'capture-visible-tab',
      })) as WorkerResponse;
      if (res?.ok) {
        const shotId = newId('shot');
        const refId = newId('e');
        buffer.addScreenshot({
          id: shotId,
          eventId: refId,
          takenAt: nowIso(),
          dataUrl: res.dataUrl,
        });
        add({ kind: 'screenshot-ref', id: refId, t: nowIso(), screenshotId: shotId, reason });
        pushFeed('screenshot', `screenshot (${reason})`);
      }
    } catch {
      /* screenshots are optional — never block capture */
    }
  }

  function applyHealth(signal: {
    attached: boolean;
    gamedatasReadable: boolean;
    notificationsFlowing: boolean;
  }): void {
    const change = health.update(signal);
    if (change) {
      healthStatus = change.status;
      healthReason = change.reason;
      buffer.recordHealth(change.status, change.reason);
      add({
        kind: 'health',
        id: newId('e'),
        t: nowIso(),
        status: change.status,
        reason: change.reason,
      });
      pushFeed('health', `health: ${change.status} — ${change.reason}`);
    }
  }

  function triggerAdvice(briefing: PositionBriefing, gamestateId?: string | number): void {
    if (!advisorEnabled) return;
    // Only kill an in-flight advice — a parallel chat must keep streaming.
    advisorClient.cancelAdvise();
    currentBriefing = briefing;
    advisorPhase = 'thinking';
    // New advice flows into the same continuous transcript as a fresh message.
    // The stamp shows the EXACT state the advisor reasoned from — if this says
    // "R1 food0 wood0" while you're deep in the game, the briefing is stale.
    const rr = briefing.me.resources;
    const placed = briefing.me.placedFarmersThisRound ?? [];
    // The "placed" segment is the at-a-glance check that the briefing is
    // fresh: if you just put a person on Forest, this stamp should already
    // list it. If it doesn't, the probe didn't see the update yet.
    const placedSummary = placed.length
      ? `placed[${placed.length}]:${placed.slice(0, 3).join('/')}${placed.length > 3 ? '…' : ''}`
      : 'placed[0]';
    // Compact full-resource line so you can verify EVERY resource matches
    // your visible UI at the moment the LLM saw this position — not just
    // food/wood/clay. Animal counts included because they drive feeding
    // decisions.
    const a = briefing.me.animals;
    const stamp =
      `seen: R${briefing.round} ${briefing.phase} myTurn:${briefing.isMyTurn} · ` +
      `f${rr.food ?? 0} w${rr.wood ?? 0} c${rr.clay ?? 0} r${rr.reed ?? 0} ` +
      `s${rr.stone ?? 0} g${rr.grain ?? 0} v${rr.vegetable ?? 0} · ` +
      `sh${a.sheep ?? 0} p${a.boar ?? 0} cat${a.cattle ?? 0} · ` +
      `${placedSummary} · spaces ${briefing.actionBoard.length} hand ${briefing.me.hand?.length ?? 0}`;
    const msg: TranscriptMsg = {
      role: 'agent',
      content: '',
      kind: 'advice',
      meta: stamp,
      ts: nowIso(),
      // Show typing dots until the stream completes — user doesn't see
      // partial / scaffolding text, only the clean final recommendation.
      streaming: true,
    };
    transcript.push(msg);
    scheduleRender();
    // Build conversation history for the LLM — same shape as chat, capped
    // to the last 10 non-empty / non-error turns. This lets auto-advice see
    // prior recommendations and user pushback ("I'll get beggar tokens",
    // "I have no animals", etc.) so it doesn't repeat rejected ideas or
    // ignore corrections from earlier in the game.
    const adviseHistory: ChatTurn[] = transcript
      .filter((t) => t !== msg && t.content.trim() !== '' && t.kind !== 'error')
      .slice(-10)
      .map((t) => ({
        role: t.role === 'user' ? 'user' : 'assistant',
        content: t.content,
      }));
    advisorClient.advise(briefing, adviseHistory, {
      onChunk: (acc) => {
        // Accumulate silently — the bubble shows typing dots while
        // streaming, so we don't need to re-render per chunk. Phase flip
        // (thinking → streaming) is still informative for the global
        // indicator and may trigger one render at most.
        msg.content = acc;
        if (advisorPhase === 'thinking') {
          advisorPhase = 'streaming';
          scheduleRender();
        }
      },
      onError: (err) => {
        if (err === 'cancelled') {
          if (msg.content === '') {
            // Empty cancelled — nothing useful to show; just drop the row.
            const i = transcript.indexOf(msg);
            if (i >= 0) transcript.splice(i, 1);
          } else {
            // Partial advice cancelled by a fresher decision — keep it but
            // visually mark it as superseded so the user knows it's stale.
            msg.kind = 'superseded';
          }
          msg.streaming = false;
          advisorPhase = 'idle';
          scheduleRender();
          return;
        }
        if (err === 'no-key') {
          msg.streaming = false;
          void refreshAdvisorEnabled();
          return;
        }
        msg.kind = 'error';
        msg.content = `⚠ ${err}`;
        msg.streaming = false;
        advisorPhase = 'error';
        scheduleRender();
      },
      onDone: (full) => {
        msg.content = full;
        msg.streaming = false;
        advisorPhase = 'done';
        scheduleRender();
        if (!capturing) return;
        const { move, rationale } = parseAdvice(full);
        void getAdvisorConfig().then((cfg) => {
          const rec: RecommendationEvent = {
            kind: 'recommendation',
            id: newId('e'),
            t: nowIso(),
            gamestateId,
            model: cfg?.model ?? 'unknown',
            legalActions: briefing.legalActions,
            recommendedMove: move,
            rationale,
          };
          add(rec);
          pendingRec = rec; // linked to the actual move on the next notification
        });
      },
    });
  }

  // Level-triggered advice: evaluate the CURRENT position and advise if it's a
  // genuine, not-yet-advised decision point. Safe to call from a transition,
  // on probe attach (handles reload mid-turn), or a periodic safety net — the
  // lastAdvisedKey dedupe makes it idempotent per decision.
  // Decide whether THIS briefing is a new genuine decision worth advising.
  // Distillation happens in the probe; the action-shape gate + dedupe key
  // live in shared pure modules so probe and content agree on semantics.
  function adviseFromBriefing(b: PositionBriefing, ctx: DecisionContext): void {
    // Strategic-only gate: filter out both trivial actions (confirm/restart)
    // AND mechanical resolutions (plow/reorganize/gainResources/etc.) where
    // the player already committed to the action on the prior placement.
    // Auto-advice on mechanical resolves is pure noise — the user knows they
    // need to plow because they took Farmland. Chat is unaffected; the probe
    // still emits a briefing so on-demand questions stay fresh.
    if (!advisorEnabled || !isStrategicDecision(b, ctx.gamestateName)) return;
    const key = decisionKey(b, ctx);
    if (key === lastAdvisedKey) return; // already advising/advised this decision
    lastAdvisedKey = key;
    triggerAdvice(b, ctx.gamestateId);
  }

  async function sendChat(text: string): Promise<void> {
    if (!advisorEnabled) return;
    // Indicator: while we await the probe's fresh briefing, the bubble has
    // nothing yet — show "reading position…" so the user knows we're
    // hydrating from live state, not waiting on the LLM.
    advisorPhase = 'reading';
    scheduleRender();
    // Try for the freshest briefing — ask the probe, race against 500ms; on
    // timeout fall back to the most recent briefing we already received.
    let fresh: PositionBriefing | null = null;
    if (probeAttached) {
      fresh = await new Promise<PositionBriefing | null>((resolve) => {
        pendingBriefingRequest = (b) => resolve(b);
        try {
          postToProbe({ type: 'request-briefing' });
        } catch {
          /* no-op */
        }
        setTimeout(() => {
          if (pendingBriefingRequest) {
            pendingBriefingRequest = null;
            resolve(null);
          }
        }, 500);
      });
    }
    const briefing = fresh ?? latestBriefing ?? currentBriefing;
    if (!briefing) {
      advisorPhase = 'idle';
      transcript.push({ role: 'user', content: text, ts: nowIso() });
      transcript.push({
        role: 'agent',
        content: 'Tilly needs the game to load — try again in a moment.',
        kind: 'error',
        ts: nowIso(),
      });
      scheduleRender();
      return;
    }
    // History = prior conversation (capped), before this new question.
    const history: ChatTurn[] = transcript
      .filter((m) => m.content.trim() !== '' && m.kind !== 'error')
      .slice(-10)
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }));
    transcript.push({ role: 'user', content: text, ts: nowIso() });
    const reply: TranscriptMsg = {
      role: 'agent',
      content: '',
      kind: 'reply',
      ts: nowIso(),
      streaming: true,
    };
    transcript.push(reply);
    // Briefing in hand, LLM request about to fly — flip to 'thinking' so the
    // indicator distinguishes "fetching state" from "waiting on tokens".
    advisorPhase = 'thinking';
    scheduleRender();
    advisorClient.chat(briefing, history, text, {
      onChunk: (acc) => {
        // Silent accumulation while streaming — the bubble shows typing
        // dots, no per-chunk re-render needed.
        reply.content = acc;
        if (advisorPhase === 'thinking' || advisorPhase === 'reading') {
          advisorPhase = 'streaming';
          scheduleRender();
        }
      },
      onDone: (full) => {
        reply.content = full;
        reply.streaming = false;
        advisorPhase = 'done';
        scheduleRender();
      },
      onError: (err) => {
        reply.content = err === 'cancelled' ? '(cancelled)' : `⚠ ${err}`;
        if (err !== 'cancelled') reply.kind = 'error';
        reply.streaming = false;
        advisorPhase = err === 'cancelled' ? 'idle' : 'error';
        scheduleRender();
      },
    });
  }

  async function handle(msg: ProbeMessage): Promise<void> {
    switch (msg.type) {
      case 'attached': {
        probeAttached = true;
        await buffer.startSession({
          tableId: msg.meta.tableId,
          gameName: msg.meta.gameName,
          me: msg.meta.me,
          players: msg.meta.players,
          variant: msg.meta.variant,
          startedAt: nowIso(),
        });
        // gamedatas itself is intentionally NOT held in content memory —
        // we keep only the distilled briefing the probe sends us. The probe
        // handles reload-mid-turn via its decision-gate + settler, so no
        // content-side distill is needed at attach.
        pushFeed('attached', `probe attached — table ${msg.meta.tableId}`);
        scheduleRender();
        break;
      }
      case 'detached': {
        probeAttached = false;
        await buffer.flush();
        pushFeed('detached', msg.reason);
        scheduleRender();
        break;
      }
      case 'status': {
        // "notificationsFlowing" used to be `notifsSeen > 0`, which marked
        // health as degraded any time we sat idle waiting for a turn (e.g.
        // start of round, opponent thinking). The probe knows its own state:
        // `msg.degraded` is true only after the 25s grace period elapsed AND
        // it actually fell back to snapshot mode. Trust that flag directly so
        // we don't false-alarm on a quiet but correctly-hooked probe.
        applyHealth({
          attached: msg.attached,
          gamedatasReadable: msg.gamedatasReadable,
          notificationsFlowing: !msg.degraded,
        });
        scheduleRender();
        break;
      }
      case 'notification': {
        // Lightweight (no clone). The notification name itself is the signal
        // for the move-clear: a player acted, so the dedupe key must reset
        // even if no recommendation was pending (e.g. advice was cancelled
        // mid-stream and never set pendingRec).
        if (MOVE_NOTIFICATIONS.has(msg.name)) lastAdvisedKey = null;

        if (!capturing) break;
        const notifId = newId('e');
        add({
          kind: 'notification',
          id: notifId,
          t: nowIso(),
          name: msg.name,
          channel: msg.channel,
          args: msg.args,
          gamestateId: msg.gamestateId,
          activePlayerId: msg.activePlayerId,
          linkedSnapshotId: lastSnapshotId,
        });
        if (pendingRec) {
          // Link the recommendation to the move actually taken (post-game eval).
          pendingRec.actualActionEventId = notifId;
          pendingRec = undefined;
          void buffer.flush();
        }
        pushFeed('notif', msg.name);
        const n = msg.name.toLowerCase();
        if (n.includes('harvest')) void maybeScreenshot('harvest');
        else if (n.includes('round') || n.includes('newround')) void maybeScreenshot('round');
        scheduleRender();
        break;
      }
      case 'snapshot': {
        // Legacy/degraded path only — currently a no-op on the content side:
        // the briefing channel is authoritative. Kept as a probe escape hatch.
        scheduleRender();
        break;
      }
      case 'briefing': {
        // Hot path: distilled in the probe, ~KB. Drives the advisor with zero
        // heavy clone/transfer on BGA's render thread.
        probeAttached = true;
        latestBriefing = msg.briefing;
        // Resolve any chat request that was waiting for fresh state.
        if (pendingBriefingRequest) {
          const r = pendingBriefingRequest;
          pendingBriefingRequest = null;
          r(msg.briefing);
        }
        adviseFromBriefing(msg.briefing, {
          gamestateId: msg.gamestateId,
          gamestateName: msg.gamestateName,
          activePlayerId: msg.activePlayerId,
        });
        scheduleRender();
        break;
      }
      case 'briefing-error': {
        pushFeed('briefing-error', msg.reason);
        scheduleRender();
        break;
      }
      case 'metric': {
        // Lightweight diagnostic in the Events feed. When `detail` is present
        // (drift / briefing-summary / dom-scrape-miss / etc.), use it as the
        // visible row text so the user can scan freshness signals at a glance.
        // Otherwise fall back to the numeric value (distill-ms, settle-capped).
        const summary = msg.detail ?? msg.value.toFixed(1);
        pushFeed(msg.name, summary);
        break;
      }
      case 'gamestate': {
        const me = buffer.current?.table.me;
        const isMyTurn =
          me != null &&
          msg.activePlayerId != null &&
          String(msg.activePlayerId) === String(me);

        // Phase 2: the probe owns advisor triggering via the `briefing`
        // message. Here we only clear the dedupe key when it stops being our
        // turn — so the NEXT real decision will re-fire advice. In solo where
        // activePlayerId never flips, the MOVE_NOTIFICATIONS clear in the
        // 'notification' case carries this role instead.
        if (!isMyTurn) lastAdvisedKey = null;

        if (capturing) {
          add({
            kind: 'gamestate',
            id: newId('e'),
            t: nowIso(),
            from: msg.from,
            to: msg.to,
            name: msg.name,
            description: msg.description,
            activePlayerId: msg.activePlayerId,
            isMyTurn,
            possibleActions: msg.possibleActions,
            args: msg.args,
          });
          pushFeed('state', `${msg.name ?? msg.to}${isMyTurn ? ' — YOUR TURN' : ''}`, isMyTurn);
          if (isMyTurn) void maybeScreenshot('my-turn');
        }
        scheduleRender();
        break;
      }
      case 'final': {
        buffer.setFinal({ scores: msg.scores, raw: msg.raw });
        await buffer.flush();
        pushFeed('final', 'game end captured');
        void maybeScreenshot('game-end');
        scheduleRender();
        break;
      }
      case 'clone-error': {
        buffer.recordHealth(healthStatus ?? 'degraded', `clone error: ${msg.reason}`);
        pushFeed('health', `clone error: ${msg.reason}`);
        break;
      }
    }
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window) return;
    if (!isProbeEnvelope(ev.data)) return;
    void handle(ev.data.msg);
  });

  // Phase 2: the 4 s content-side safety-net is REMOVED. The probe now owns
  // advisor triggering (decision-gate + settler) so it sees gameui.gamedatas
  // live and never reasons off the stale buffered copy. Persist on hide:

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void buffer.flush();
  });
  window.addEventListener('pagehide', () => void buffer.flush());

  // Optional config loads dead-last, AFTER all synchronous wiring is in place
  // (sidebar mount, scheduleRender, the probe message listener, initial
  // render). Fire-and-forget so main() can never reject before the probe
  // message listener is registered. By the time this async body runs, every
  // closure variable it touches (renderQueued, etc.) is initialized.
  void (async () => {
    try {
      const got = await chrome.storage.local.get('screenshotsEnabled');
      screenshotsEnabled = got.screenshotsEnabled === true;
    } catch {
      /* default off */
    }
    await refreshAdvisorEnabled();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (
        area === 'local' &&
        ('openrouterKey' in changes || 'openrouterModel' in changes)
      ) {
        void refreshAdvisorEnabled();
      }
    });
    scheduleRender();
  })();
}
