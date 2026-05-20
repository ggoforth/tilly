// MAIN-world probe. Runs in the BGA page's JS context, reads window.gameui,
// hooks the notification bus and gamestate, and relays everything to the
// isolated content script via window.postMessage. Strictly read-only:
// it never dispatches input or mutates the game.
//
// Everything that touches page internals is wrapped in try/catch — the probe
// must never throw into BGA's own code.

import {
  postToContent,
  type ProbeTableMeta,
  isContentEnvelope,
} from '../shared/messaging';
import type { NotifChannel } from '../shared/types';
import { distill } from '../advisor/distiller';
import { Settler } from './settle';
import { PlacementTracker } from './placement-tracker';
import { TRIVIAL_ACTIONS } from '../shared/decision-gate';

declare global {
  interface Window {
    gameui?: any;
    dojo?: any;
    bga?: any;
    __AGRI_OBS_PROBE__?: boolean;
  }
}

// Guard against double injection.
if (window.__AGRI_OBS_PROBE__) {
  // already running
} else {
  window.__AGRI_OBS_PROBE__ = true;
  start();
}

function start(): void {
  let attached = false;
  let currentTableId: string | null = null;
  let notifsSeen = 0;
  let notifMechanism: NotifChannel | null = null;
  let degraded = false;
  let lastStateKey: string | null = null;
  const subscribedChannels = new Set<string>();

  const safeClone = (v: unknown): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: structuredClone(v) };
    } catch {
      try {
        const seen = new WeakSet<object>();
        const json = JSON.stringify(v, (_k, val) => {
          if (typeof val === 'function') return undefined;
          if (typeof val === 'object' && val !== null) {
            if (seen.has(val as object)) return undefined;
            seen.add(val as object);
          }
          return val;
        });
        return { ok: true, value: json === undefined ? null : JSON.parse(json) };
      } catch {
        return { ok: false };
      }
    }
  };

  const gd = (): unknown => {
    try {
      return window.gameui?.gamedatas;
    } catch {
      return undefined;
    }
  };

  const cloneGd = (): unknown => {
    const c = safeClone(gd());
    if (c.ok) return c.value;
    postToContent({ type: 'clone-error', reason: 'structuredClone + JSON fallback both failed' });
    return undefined;
  };

  const stateInfo = () => {
    try {
      const s = window.gameui?.gamedatas?.gamestate ?? {};
      return {
        id: s.id ?? s.name,
        name: s.name,
        description: s.description ?? s.descriptionmyturn,
        activePlayerId:
          s.active_player != null ? String(s.active_player) : undefined,
        possibleActions: s.possibleactions,
        args: s.args,
      };
    } catch {
      return {};
    }
  };

  const isAgricola = (): boolean => {
    try {
      const name = window.gameui?.game_name;
      if (typeof name === 'string') return name.toLowerCase() === 'agricola';
      return /\bagricola\b/i.test(location.pathname + location.search);
    } catch {
      return /\bagricola\b/i.test(location.href);
    }
  };

  const tableId = (): string => {
    try {
      if (window.gameui?.table_id != null) return String(window.gameui.table_id);
    } catch {
      /* ignore */
    }
    const m = /[?&]table=(\d+)/.exec(location.search);
    return m?.[1] ?? 'unknown';
  };

  const readMeta = (): ProbeTableMeta => {
    let me = '';
    let players: ProbeTableMeta['players'] = [];
    let variant: string | undefined;
    try {
      me = window.gameui?.player_id != null ? String(window.gameui.player_id) : '';
      const ps = window.gameui?.gamedatas?.players ?? {};
      players = Object.keys(ps).map((id) => ({
        id: String(id),
        name: ps[id]?.name ?? '',
        color: ps[id]?.color,
        order: ps[id]?.no != null ? Number(ps[id].no) : undefined,
      }));
      const gdAny = window.gameui?.gamedatas ?? {};
      variant =
        gdAny?.variant ?? gdAny?.options?.variant ?? gdAny?.gameoptions
          ? JSON.stringify(gdAny.gameoptions ?? gdAny.options ?? gdAny.variant)
          : undefined;
    } catch {
      /* best effort */
    }
    return { tableId: tableId(), gameName: 'agricola', me, players, variant };
  };

  // Distill IN the probe (MAIN world): read gameui.gamedatas IN PLACE (no
  // clone) → build the ~KB briefing → post only that. This removes the
  // structuredClone + cross-context postMessage of the multi-MB gamedatas
  // from BGA's render thread (the cause of the animation lag / beachball).
  // Settle state machine + per-reason briefing-error debouncer. Briefings are
  // emitted only when the settler tells us to; sendBriefing is called from the
  // settle-driven boot tick and from on-demand request-briefing handling.
  const settler = new Settler();
  // Authoritative record of "who's on which action space this round." Built
  // from the placeFarmer notification stream because BGA's `meeples[].location`
  // lags placements by SECONDS in BGA Agricola (verified at +33s in the
  // captured corpus — the briefing would otherwise read stale state).
  const placements = new PlacementTracker();
  const lastBriefingErrAt: Map<string, number> = new Map();
  const ERROR_DEBOUNCE_MS = 5000;

  /** Resource types BGA renders per-player as `#resource_<pid>_<type>`. The
   *  DOM counter is updated synchronously by BGA's `notif_*` handlers and is
   *  the canonical "what the user sees" value. Verified against live console:
   *  cache_resources lagged the spend (clay=3) while the DOM read "1". */
  const RESOURCE_TYPES_FOR_DOM = [
    'wood', 'clay', 'reed', 'stone', 'food', 'grain', 'vegetable',
    'sheep', 'pig', 'cattle', 'begging', 'fence', 'stable',
  ] as const;

  /** Read the live displayed resources from BGA's DOM for every known player.
   *  Returns Map<pid, Record<type, number>>. Players whose panel isn't yet
   *  rendered are omitted — the distiller will fall back to gamedatas for
   *  them (cache + accumulator-pile formula). Non-numeric / missing text is
   *  silently skipped. Pure DOM read, no mutation. */
  const scrapeLiveResources = (): Map<string, Record<string, number>> => {
    const out = new Map<string, Record<string, number>>();
    try {
      const players = window.gameui?.gamedatas?.players;
      if (!players || typeof players !== 'object') return out;
      for (const pid of Object.keys(players)) {
        const rec: Record<string, number> = {};
        for (const t of RESOURCE_TYPES_FOR_DOM) {
          const el = document.querySelector(`#resource_${pid}_${t}`);
          const txt = el?.textContent?.trim();
          if (!txt) continue;
          const n = parseInt(txt, 10);
          if (Number.isFinite(n)) rec[t] = n;
        }
        if (Object.keys(rec).length > 0) out.set(String(pid), rec);
      }
    } catch {
      /* DOM read must not break the page */
    }
    return out;
  };

  /** Action-card pile DOM scrape. BGA renders each pile as a `.resource-holder`
   *  inside the `#Action<Card>` element, with one `.agricola-meeple` child per
   *  token carrying `data-type="<resource>"`. This is BGA's own data binding —
   *  updated synchronously when piles are taken/refilled — and is the only
   *  reliable live source. `gamedatas.meeples` keeps the count pinned to a
   *  pre-allocated value (verified: SheepMarket stayed at m:s4 across before/
   *  after-take/after-cook snapshots while the actual pile was 2). */
  const scrapeLiveAccumulatorPiles = (): Map<string, Record<string, number>> => {
    const out = new Map<string, Record<string, number>>();
    try {
      document.querySelectorAll('[id^="Action"]').forEach((cardEl) => {
        const id = (cardEl as HTMLElement).id;
        if (!id || (cardEl as HTMLElement).children.length === 0) return;
        const holder = cardEl.querySelector('.resource-holder');
        if (!holder) return;
        const byType: Record<string, number> = {};
        holder.querySelectorAll('[data-type]').forEach((m) => {
          const t = (m as HTMLElement).dataset?.type;
          if (typeof t === 'string' && t) byType[t] = (byType[t] ?? 0) + 1;
        });
        if (Object.keys(byType).length > 0) out.set(id, byType);
      });
    } catch {
      /* never break the page */
    }
    return out;
  };

  /** Observation-only telemetry. Dumps EVERY plausible source for resource
   *  counts and action-card pile sizes in a single compact line. Run at
   *  distill time only (settle-emit) so it's not on the notification hot
   *  path. Lets us reverse-engineer which source is canonical without
   *  guessing — collect 2-3 rounds of these, see which column consistently
   *  matches the user's visible UI, switch the distiller to read from
   *  there. Strictly read-only, no mutation. Budget ~50ms per distill. */
  const RES_TYPES_FOR_EVIDENCE = ['wood','clay','reed','stone','food','grain','vegetable'] as const;
  const scrapeStateEvidence = (me: string, finalRes: Record<string, number>): string => {
    try {
      const gd: any = window.gameui?.gamedatas ?? {};
      const meeples: any[] = Array.isArray(gd.meeples) ? gd.meeples : [];

      // 1) Per-resource side-by-side: cache | reserve-meeple-count | DOM | final
      const cache = (gd.players?.[me]?.resources ?? {}) as Record<string, number>;
      const reserveByType: Record<string, number> = {};
      for (const m of meeples) {
        if (String(m?.pId) !== me) continue;
        if (m.location !== 'reserve') continue;
        const t = m.type;
        if (typeof t === 'string') reserveByType[t] = (reserveByType[t] ?? 0) + 1;
      }
      const resParts: string[] = [];
      for (const t of RES_TYPES_FOR_EVIDENCE) {
        const c = cache[t] ?? 0;
        const r = reserveByType[t] ?? 0;
        const domTxt = document.querySelector(`#resource_${me}_${t}`)?.textContent?.trim();
        const dParsed = domTxt ? parseInt(domTxt, 10) : NaN;
        const d = Number.isFinite(dParsed) ? String(dParsed) : '?';
        const f = finalRes[t] ?? 0;
        const initial = t[0]!;
        resParts.push(`${initial}{c${c}r${r}d${d}=${f}}`);
      }

      // 2) Per-action-card pile sources: meeple count by type at that card's
      // location AND various DOM child counts that might encode the pile.
      // Limit to action cards currently in the DOM (avoids enumerating hidden
      // future-round reveals).
      const cardEls = Array.from(document.querySelectorAll('[id^="Action"]'))
        .filter((el) => (el as HTMLElement).id && el.children.length > 0)
        .slice(0, 18);
      const meeplesByCardType: Map<string, Record<string, number>> = new Map();
      for (const m of meeples) {
        const loc = m?.location;
        if (typeof loc !== 'string' || !loc.startsWith('Action')) continue;
        const t = m.type;
        if (typeof t !== 'string' || t === 'farmer') continue;
        const r = meeplesByCardType.get(loc) ?? {};
        r[t] = (r[t] ?? 0) + 1;
        meeplesByCardType.set(loc, r);
      }
      const cardParts: string[] = [];
      for (const el of cardEls) {
        const id = (el as HTMLElement).id;
        const short = id.replace(/^Action/, '').replace(/(Solo|Beginner)+$/i, '').slice(0, 7);
        const mByType = meeplesByCardType.get(id) ?? {};
        const meepleStr =
          Object.entries(mByType)
            .map(([t, n]) => `${t[0]}${n}`)
            .join('') || '-';
        const imgs = el.querySelectorAll('img').length;
        const meepleEls = el.querySelectorAll('[class*="meeple"]').length;
        cardParts.push(`${short}{m:${meepleStr}|i${imgs}|x${meepleEls}}`);
      }

      const out = `RES ${resParts.join(' ')} || CARDS ${cardParts.join(' ')}`;
      // Bound the size — Events feed wants tight lines.
      return out.length > 600 ? out.slice(0, 597) + '…' : out;
    } catch {
      return '(evidence-scrape failed)';
    }
  };

  const sendBriefing = (): void => {
    try {
      const me =
        window.gameui?.player_id != null ? String(window.gameui.player_id) : '';
      if (!me) {
        const reason = 'no-player-id';
        const last = lastBriefingErrAt.get(reason) ?? 0;
        if (Date.now() - last > ERROR_DEBOUNCE_MS) {
          lastBriefingErrAt.set(reason, Date.now());
          postToContent({ type: 'briefing-error', reason });
        }
        return;
      }
      const t0 = performance.now();
      // Pass all three authoritative inputs:
      //   - tracker's view        → real-time placements (meeple.location lags)
      //   - DOM resource counters → real-time resource totals (cache lags)
      //   - DOM accumulator piles → real-time action-card pile sizes
      //                              (gamedatas.meeples stays pinned to a
      //                              pre-allocated count — verified live)
      const live = scrapeLiveResources();
      const livePiles = scrapeLiveAccumulatorPiles();
      const r = distill(window.gameui?.gamedatas, me, placements.view(), live, livePiles);
      const elapsed = performance.now() - t0;
      postToContent({ type: 'metric', name: 'distill-ms', value: elapsed });

      // Diagnostic 1: resource cache vs DOM drift. Fires ONE metric per
      // resource type whose cache value disagrees with the DOM — the smoking
      // gun for any future staleness. Silent when in sync (zero noise on the
      // common path).
      try {
        const cache = (window.gameui?.gamedatas?.players?.[me]?.resources ?? {}) as Record<
          string,
          number
        >;
        const myLive = live.get(me) ?? {};
        const types = new Set([...Object.keys(cache), ...Object.keys(myLive)]);
        for (const t of types) {
          const c = Number(cache[t] ?? 0);
          const d = Number(myLive[t] ?? 0);
          if (c !== d) {
            postToContent({
              type: 'metric',
              name: 'drift',
              value: d - c,
              detail: `${t} cache=${c} dom=${d}`,
            });
          }
        }
      } catch {
        /* never break distill */
      }

      // Diagnostic 2: DOM scrape miss. Fires only when a player's panel
      // didn't yield any usable counters — so we know we're degraded to
      // gamedatas cache for that player.
      try {
        const ps = window.gameui?.gamedatas?.players ?? {};
        const missing: string[] = [];
        for (const pid of Object.keys(ps)) if (!live.has(String(pid))) missing.push(String(pid));
        if (missing.length > 0) {
          postToContent({
            type: 'metric',
            name: 'dom-scrape-miss',
            value: missing.length,
            detail: `players=${missing.join(',')}`,
          });
        }
      } catch {
        /* never break distill */
      }

      if (r.ok) {
        // Diagnostic 3: briefing-content summary. One compact line per
        // distill showing the numbers the LLM actually saw — the user can
        // scan Events and verify the briefing was correct at each decision.
        try {
          const b = r.briefing;
          const r0 = b.me.resources;
          const pf = (b.me.placedFarmersThisRound ?? []).join(',') || '-';
          const summary =
            `R${b.round} myTurn=${b.isMyTurn ? 't' : 'f'} | ` +
            `f${r0.food ?? 0} w${r0.wood ?? 0} c${r0.clay ?? 0} r${r0.reed ?? 0} s${r0.stone ?? 0} g${r0.grain ?? 0} v${r0.vegetable ?? 0} | ` +
            `sh${r0.sheep ?? 0} p${r0.pig ?? 0} cat${r0.cattle ?? 0} | ` +
            `placed=${pf} | hand=${b.me.hand?.length ?? 0} played=${b.me.played.length} spaces=${b.actionBoard.length}`;
          postToContent({
            type: 'metric',
            name: 'briefing',
            value: b.actionBoard.length,
            detail: summary,
          });
        } catch {
          /* diagnostics never block */
        }

        // Diagnostic 4: state evidence dump. Observation-only — captures
        // every plausible source for resources and action-card piles so we
        // can reverse-engineer which is canonical without guessing.
        try {
          const evidence = scrapeStateEvidence(me, r.briefing.me.resources);
          postToContent({
            type: 'metric',
            name: 'evidence',
            value: 0,
            detail: evidence,
          });
        } catch {
          /* never block */
        }
        const gs = window.gameui?.gamedatas?.gamestate ?? {};
        postToContent({
          type: 'briefing',
          briefing: r.briefing,
          gamestateId: gs.id ?? '',
          gamestateName: String(gs.name ?? ''),
          activePlayerId: String(gs.active_player ?? me),
        });
      } else {
        const reason = r.reason ?? 'distill-failed';
        const last = lastBriefingErrAt.get(reason) ?? 0;
        if (Date.now() - last > ERROR_DEBOUNCE_MS) {
          lastBriefingErrAt.set(reason, Date.now());
          postToContent({ type: 'briefing-error', reason });
        }
      }
    } catch {
      /* never break the page */
    }
  };

  /** Cheap gamestate-level check (no distill) — does it look like a real
   *  decision the user can act on right now? */
  const looksLikeRealDecision = (): boolean => {
    try {
      const me =
        window.gameui?.player_id != null
          ? String(window.gameui.player_id)
          : null;
      if (!me) return false;
      const gs = window.gameui?.gamedatas?.gamestate;
      if (!gs) return false;
      if (String(gs.active_player) !== me) return false;
      const acts = gs.possibleactions;
      if (!Array.isArray(acts) || acts.length === 0) return false;
      for (const a of acts) if (!TRIVIAL_ACTIONS.has(a)) return true;
      return false;
    } catch {
      return false;
    }
  };

  // --- Notification hooks -------------------------------------------------

  const emitNotification = (name: string, args: unknown, channel: NotifChannel) => {
    notifsSeen += 1;
    notifMechanism = channel;
    if (degraded) {
      degraded = false; // notifications came back
      stopFallback();
    }
    // Update the authoritative placement tracker FROM the notification (the
    // only real-time source) BEFORE we post. The settle-driven distill that
    // follows will see fresh tracker state. Tolerant of args shape: the dojo
    // path unwraps once, the notifqueue path may keep the envelope.
    try {
      if (name === 'placeFarmer') {
        const a: any = args;
        const inner = a?.args && typeof a.args === 'object' ? a.args : a;
        const cardId = inner?.card?.id;
        const cardName = inner?.card?.name;
        const pid = inner?.player_id;
        if (cardId && pid != null) {
          placements.onPlaceFarmer(String(cardId), String(cardName ?? cardId), String(pid));
        }
      } else if (name === 'returnHome') {
        placements.onReturnHome();
      }
    } catch {
      /* tracker must not break the probe */
    }
    const s = stateInfo();
    postToContent({
      type: 'notification',
      name,
      channel,
      args,
      gamestateId: s.id,
      activePlayerId: s.activePlayerId,
    });
    // Activity resets the settle window. If we're in a decision and a burst
    // is in flight, this keeps us "observing" until the burst quiesces.
    settler.onActivity(Date.now());
  };

  const hookDojo = (): boolean => {
    try {
      const dojo = window.dojo;
      if (!dojo || typeof dojo.subscribe !== 'function' || typeof dojo.publish !== 'function') {
        return false;
      }
      if ((dojo.subscribe as any).__agriWrapped) return true; // idempotent
      const origSub = dojo.subscribe.bind(dojo);
      const origPub = dojo.publish.bind(dojo);
      // Record every channel the game subscribes to — those are the notif names.
      const patchedSubscribe = function (channel: string, ...rest: unknown[]) {
        try {
          if (typeof channel === 'string') subscribedChannels.add(channel);
        } catch {
          /* ignore */
        }
        return origSub(channel, ...rest);
      };
      (patchedSubscribe as any).__agriWrapped = true;
      dojo.subscribe = patchedSubscribe;
      // Tee publishes that target a subscribed notification channel.
      dojo.publish = function (channel: string, args: unknown[]) {
        // Dispatch FIRST so subscribers apply the change, THEN snapshot — the
        // captured gamedatas must reflect the post-notification state.
        const ret = origPub(channel, args);
        try {
          if (typeof channel === 'string' && subscribedChannels.has(channel)) {
            emitNotification(channel, args?.[0] ?? args, 'dojo');
          }
        } catch {
          /* never break the page */
        }
        return ret;
      };
      return true;
    } catch {
      return false;
    }
  };

  // BGA's intake for every incoming notification packet (legacy framework).
  // Wrapping this captures notifications regardless of when the game's
  // dojo.subscribe handlers were registered — so it works even when the probe
  // attaches after setupNotifications(), and on a mid-game reload. This is the
  // primary, timing-independent capture path.
  const captureFromPacket = (channel: string, packet: any) => {
    const entries =
      packet && Array.isArray(packet.data)
        ? packet.data
        : packet && packet.args && Array.isArray(packet.args.data)
          ? packet.args.data
          : [packet];
    for (const e of entries) {
      if (e == null && packet == null) continue;
      const name =
        (e && (e.type ?? e.notification_type)) ??
        (packet && packet.type) ??
        channel ??
        'notification';
      emitNotification(String(name), e ?? packet, 'dojo');
    }
  };

  const hookOnPlaceLog = (): boolean => {
    try {
      const g = window.gameui;
      if (!g || typeof g.onPlaceLogOnChannel !== 'function') return false;
      if ((g.onPlaceLogOnChannel as any).__agriWrapped) return true; // idempotent
      const orig = g.onPlaceLogOnChannel.bind(g);
      const wrapped = function (...a: any[]) {
        const ret = orig(...a); // apply first
        try {
          captureFromPacket(a[0], a[1]); // then snapshot post-apply state
        } catch {
          /* never break the game */
        }
        return ret;
      };
      (wrapped as any).__agriWrapped = true;
      g.onPlaceLogOnChannel = wrapped;
      return true;
    } catch {
      return false;
    }
  };

  // Locate the packet-shaped argument regardless of the method's signature
  // (onNotification may be (packet), (channel, packet), (packet, ...)).
  const captureFromArgs = (label: string, args: any[]) => {
    let channel = '';
    let packet: any;
    for (const a of args) {
      if (typeof a === 'string' && !channel) channel = a;
      else if (
        packet === undefined &&
        a &&
        typeof a === 'object' &&
        (Array.isArray(a.data) || a.type != null || (a.args && typeof a.args === 'object'))
      ) {
        packet = a;
      }
    }
    if (packet === undefined) packet = args.length ? args[args.length - 1] : undefined;
    const entries =
      packet && Array.isArray(packet.data)
        ? packet.data
        : packet && packet.args && Array.isArray(packet.args.data)
          ? packet.args.data
          : [packet];
    for (const e of entries) {
      if (e == null && packet == null) continue;
      const name =
        (e && (e.type ?? e.notification_type)) ??
        (packet && packet.type) ??
        channel ??
        label ??
        'notification';
      emitNotification(String(name), e ?? packet, 'dojo');
    }
  };

  // PRIMARY notification capture for the modern BGA framework: the notification
  // queue's ingress method. Stable across the game, so wrapping it after setup
  // still catches every notification — and survives a mid-game reload.
  const hookNotifQueue = (): boolean => {
    try {
      const nq = window.gameui?.notifqueue;
      if (!nq || typeof nq.onNotification !== 'function') return false;
      if ((nq.onNotification as any).__agriWrapped) return true; // idempotent
      const orig = nq.onNotification.bind(nq);
      const wrapped = function (...a: any[]) {
        const ret = orig(...a); // apply the notification FIRST
        try {
          captureFromArgs('notif', a); // then snapshot the post-apply state
        } catch {
          /* never break the game */
        }
        return ret;
      };
      (wrapped as any).__agriWrapped = true;
      nq.onNotification = wrapped;
      return true;
    } catch {
      return false;
    }
  };

  const hookModern = (): boolean => {
    try {
      const n = window.bga?.notifications;
      if (!n) return false;
      // Defensive: try a few plausible "observe all" shapes without assuming one.
      for (const m of ['onAny', 'subscribeAll', 'tap']) {
        if (typeof n[m] === 'function') {
          n[m]((name: string, args: unknown) => emitNotification(String(name), args, 'bga'));
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  // --- Gamestate watcher --------------------------------------------------

  const checkGamestate = () => {
    try {
      const s = stateInfo();
      const key = `${String(s.id)}::${String(s.activePlayerId ?? '')}`;
      if (key === lastStateKey) return;
      const from = lastStateKey ? lastStateKey.split('::')[0] : undefined;
      lastStateKey = key;
      if (s.id == null) return;
      postToContent({
        type: 'gamestate',
        from,
        to: s.id as string | number,
        name: s.name,
        description: s.description,
        activePlayerId: s.activePlayerId,
        possibleActions: s.possibleActions,
        args: s.args,
      });
      // Decision-driven: the gamestate watcher just decides whether a real
      // decision has arrived (or left). The settler will produce ONE emit
      // after the burst settles (idle window) or at the hard cap. No direct
      // sendBriefing() here.
      if (looksLikeRealDecision()) settler.onDecisionEntered(Date.now());
      else settler.onDecisionExited();
      const nm = (s.name ?? '').toString().toLowerCase();
      if (nm.includes('gameend') || nm.includes('endscore') || nm.includes('endgame')) {
        const c = safeClone(window.gameui?.gamedatas);
        postToContent({
          type: 'final',
          scores: (window.gameui?.gamedatas as any)?.scores,
          raw: c.ok ? c.value : undefined,
        });
      }
    } catch {
      /* ignore */
    }
  };

  // --- Degraded fallback capture -----------------------------------------

  let timerId: number | undefined;
  let mo: MutationObserver | undefined;
  let lastDomSnap = 0;

  const fallbackSnapshot = (source: 'timer' | 'dom') => {
    const s = stateInfo();
    postToContent({
      type: 'snapshot',
      source,
      gamestateId: s.id,
      activePlayerId: s.activePlayerId,
      gamedatas: cloneGd(),
    });
  };

  const startFallback = () => {
    if (timerId != null) return;
    degraded = true;
    timerId = window.setInterval(() => fallbackSnapshot('timer'), 12000);
    try {
      const area =
        document.getElementById('game_play_area') ??
        document.getElementById('overall-content') ??
        document.body;
      mo = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastDomSnap < 5000) return;
        lastDomSnap = now;
        fallbackSnapshot('dom');
      });
      mo.observe(area, { childList: true, subtree: true, attributes: true });
    } catch {
      /* ignore */
    }
  };

  const stopFallback = () => {
    if (timerId != null) {
      clearInterval(timerId);
      timerId = undefined;
    }
    if (mo) {
      mo.disconnect();
      mo = undefined;
    }
  };

  // --- Heartbeat ----------------------------------------------------------

  const heartbeat = () => {
    postToContent({
      type: 'status',
      attached,
      gamedatasReadable: gd() !== undefined,
      notifMechanism,
      notifsSeen,
      degraded,
    });
  };

  // --- Attach / lifecycle -------------------------------------------------

  const attach = () => {
    if (attached) return;
    if (!window.gameui || !isAgricola() || gd() === undefined) return;
    attached = true;
    currentTableId = tableId();
    const nqOk = hookNotifQueue(); // primary path (modern BGA notifqueue)
    const dojoOk = hookDojo(); // extra coverage (legacy pub/sub builds)
    const logOk = hookOnPlaceLog(); // extra coverage (log channel)
    const modernOk = !nqOk && !dojoOk && !logOk && hookModern();
    notifMechanism = nqOk || dojoOk || logOk ? 'dojo' : modernOk ? 'bga' : null;
    // Mid-round reload? Seed the placement tracker from any existing
    // meeples that the BGA framework has (eventually) updated. We won't
    // get retroactive placeFarmer notifications, so this is our only way
    // to know about placements from before the probe attached.
    try {
      const gdNow: any = window.gameui?.gamedatas;
      const ms = Array.isArray(gdNow?.meeples) ? gdNow.meeples : [];
      const nameByCard = new Map<string, string>();
      for (const k of ['visible', 'help']) {
        const list = Array.isArray(gdNow?.cards?.[k]) ? gdNow.cards[k] : [];
        for (const c of list) if (c?.id) nameByCard.set(String(c.id), String(c.name ?? c.id));
      }
      placements.seedFromMeeples(ms, (id) => nameByCard.get(id) ?? id);
    } catch {
      /* never break the page */
    }
    // No attach-time clone of gamedatas — content only consumes distilled
    // briefings from the probe. The probe will emit one on the next decision
    // (or on a `request-briefing`), which avoids the multi-MB structuredClone
    // that previously happened at attach.
    postToContent({ type: 'attached', meta: readMeta() });
    checkGamestate();
    // Grace period for the snapshot fallback. Only schedule it when we have
    // NO notification hook installed — i.e. an unusual legacy build where
    // neither notifqueue, dojo, onPlaceLog nor modern wire up. When any hook
    // installed, notifications will fire as soon as something happens; idling
    // while the user reads the advice must not trip "degraded" (the snapshot
    // fallback runs a 12s polling timer and a MutationObserver, which we do
    // not want unless they are actually buying us coverage we don't otherwise
    // have).
    if (notifMechanism == null) {
      window.setTimeout(() => {
        if (attached && notifsSeen === 0) startFallback();
      }, 25000);
    }
  };

  const detachIfNavigatedAway = () => {
    try {
      if (!attached) return;
      const t = tableId();
      if (!window.gameui || !isAgricola()) {
        attached = false;
        stopFallback();
        settler.reset();
        placements.reset();
        postToContent({ type: 'detached', reason: 'left the Agricola table' });
        lastStateKey = null;
        return;
      }
      if (currentTableId && t !== currentTableId) {
        // New table in the SPA — reset for a fresh session.
        attached = false;
        stopFallback();
        settler.reset();
        placements.reset();
        postToContent({ type: 'detached', reason: 'navigated to a new table' });
        lastStateKey = null;
        notifsSeen = 0;
      }
    } catch {
      /* ignore */
    }
  };

  // Poll for gameui with backoff (BGA loads asynchronously), then keep a light
  // watcher running for gamestate changes and SPA navigation.
  let delay = 500;
  const boot = () => {
    detachIfNavigatedAway();
    if (window.dojo) hookDojo(); // hook the bus as early as possible
    attach();
    if (attached) {
      hookNotifQueue(); // idempotent — catches notifqueue if it appeared late
      checkGamestate();
      // Settle-driven emit: if the settler says we're idle-settled (or capped),
      // distill in place and emit ONE briefing for this decision instance.
      const st = settler.tick(Date.now());
      if (st.shouldEmit) {
        if (st.reason === 'cap') {
          postToContent({ type: 'metric', name: 'settle-capped', value: 1 });
        }
        sendBriefing();
        settler.consumeEmit();
      }
      delay = 1000;
    } else {
      delay = Math.min(delay * 1.5, 5000);
    }
    window.setTimeout(boot, delay);
  };
  boot();
  // Heartbeat dropped to 10s (down from 5s); decision-driven flow doesn't
  // need a tight pulse, and this is on BGA's render thread.
  window.setInterval(heartbeat, 10000);
  heartbeat();

  // Inverse channel: content can ask for an on-demand fresh briefing (used by
  // chat to ground a reply on the latest state without waiting for the next
  // gamestate-driven settle). Distill in place, post one briefing (or
  // briefing-error). No clone crosses the boundary.
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window) return;
    if (!isContentEnvelope(ev.data)) return;
    if (ev.data.msg.type === 'request-briefing') sendBriefing();
  });
}
