// Two docked Shadow-DOM panels:
//  1. CHAT panel (primary, always docked right): one continuous, autoscrolling
//     conversation — the agent posts each turn's advice as a message; the
//     user's questions and the agent's replies interleave inline.
//  2. EVENTS console (telemetry: probe/health/feed/controls): a separate panel
//     left of the chat panel, collapsed by default, toggled from the chat panel.
// Observe-only: it advises; it never plays for you.
//
// Render strategy: the transcript renders INCREMENTALLY. We keep a parallel
// DOM-node map keyed by message identity so that streaming chunks mutate the
// existing bubble's textContent only — we don't tear the transcript down on
// every chunk (that was the on-stream re-flow lag). Bubbles unmount only when
// their message leaves the transcript.

import type { Health } from '../shared/types';

const DEFAULT_CHAT_W = 380;
const MIN_CHAT_W = 280;
const MAX_CHAT_W = 720;
const EV_W = 340;
/** Within this many pixels of the bottom counts as "at bottom" — sticky-scroll. */
const STICK_THRESHOLD_PX = 24;
/** chrome.storage key for the persisted chat-panel width. */
const CHAT_WIDTH_STORAGE_KEY = 'agri_chat_width_px';

export interface FeedRow {
  t: string;
  kind: string;
  summary: string;
  myTurn?: boolean;
}

export interface TranscriptMsg {
  role: 'user' | 'agent';
  content: string;
  kind?: 'advice' | 'reply' | 'error' | 'superseded';
  /** Diagnostic stamp: the state the advisor actually reasoned from. */
  meta?: string;
  /** ISO-ish timestamp captured when the message was created. Rendered as a
   *  hh:mm label on the bubble — gives the conversation a familiar IM feel. */
  ts?: string;
  /** True while the LLM is still streaming tokens into this message. The
   *  sidebar shows a typing indicator instead of partial text — the user
   *  shouldn't see the LLM's scaffolding ("Let me reassess… actually…")
   *  scrolling past, only the final clean recommendation. */
  streaming?: boolean;
}

/** Three-phase indicator: reading the position, thinking (request in flight,
 *  no tokens yet), or streaming (tokens are flowing into the bubble). 'done'
 *  and 'error' are terminal and not surfaced as an indicator. */
export type AdvisorPhase =
  | 'idle'
  | 'reading'
  | 'thinking'
  | 'streaming'
  | 'done'
  | 'error';

export interface SidebarState {
  version: string;
  health: Health | null;
  healthReason: string;
  probeAttached: boolean;
  capturing: boolean;
  screenshots: boolean;
  tableId: string | null;
  players: string[];
  counts: { events: number; notifications: number; snapshots: number; screenshots: number };
  feed: FeedRow[];
  transcript: TranscriptMsg[];
  advisorPhase: AdvisorPhase;
  chatEnabled: boolean;
  advisorDisabled: boolean;
}

export interface SidebarHandlers {
  onToggleCapture(enabled: boolean): void;
  onToggleScreenshots(enabled: boolean): void;
  onExport(): void;
  onClear(): void;
  onOpenOptions(): void;
  onSendChat(text: string): void;
}

/** Format a timestamp into a short hh:mm label. Accepts an ISO string,
 *  number, or undefined; returns '' if no parseable time is present so the
 *  footer just collapses naturally. */
function formatBubbleTime(input?: string | number): string {
  if (input == null || input === '') return '';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Split an advisor message into its short move (shown) and longer rationale
 *  (hidden behind an expand toggle). The LLM is asked to output:
 *   MOVE: short imperative...
 *   WHY: explanation...
 *  Tolerant of missing structure — falls back to first-line + rest. The
 *  `MOVE:`/`WHY:` markers themselves are stripped so the bubble reads
 *  naturally. While streaming, this runs on partial content each render. */
function splitAdvice(content: string): { move: string; why: string } {
  if (!content) return { move: '', why: '' };
  const moveMatch = /MOVE:\s*(.+?)(?=\n\s*WHY:|\n\s*$|$)/is.exec(content);
  const whyMatch = /WHY:\s*([\s\S]+?)$/i.exec(content);
  if (moveMatch) {
    return {
      move: moveMatch[1]!.trim(),
      why: whyMatch ? whyMatch[1]!.trim() : '',
    };
  }
  // No MOVE: prefix — fallback. First line is the move; rest is rationale.
  const trimmed = content.trim();
  const nl = trimmed.indexOf('\n');
  if (nl < 0) return { move: trimmed, why: '' };
  return { move: trimmed.slice(0, nl).trim(), why: trimmed.slice(nl + 1).trim() };
}

const STYLE = `
:host {
  all: initial;
  --chat-w: ${DEFAULT_CHAT_W}px;
  --ev-w: ${EV_W}px;
  /* Agricola palette — pulled from the game's grass/wood/parchment look. */
  --grass-dark: #2f4a26;
  --grass-mid:  #4a7236;
  --grass-light:#6b9450;
  --wood-dark:  #4a3818;
  --wood-mid:   #76542a;
  --wood-light: #a07c44;
  --parchment:       #ead8a8;
  --parchment-dim:   #d9c590;
  --parchment-ink:   #2a1d0c;
  --parchment-ink-2: #5a4524;
}
.hidden { display: none !important; }
/* Tiled grass background matching the BGA Agricola farmyard feel — a CSS
   pattern instead of a remote URL (works regardless of BGA's asset paths,
   no cross-origin fetch). Two layered radial-gradient dot patterns over a
   mid-grass base give a soft mottled texture. */
/* Background: when the runtime detects BGA's own grass tile, use it
   (set as a CSS var by JS). Otherwise fall back to a CSS-only pattern
   that mimics the grass look without needing remote assets. */
.chat {
  position: fixed; top: 0; right: 0; width: var(--chat-w); height: 100vh;
  z-index: 2147483646; display: flex; flex-direction: column;
  font: 13px/1.5 -apple-system, system-ui, sans-serif; color: var(--parchment);
  background-color: var(--grass-mid);
  background-image: var(--bga-bg, none),
    radial-gradient(rgba(255,255,255,.05) 1.2px, transparent 2px),
    radial-gradient(rgba(0,0,0,.08)        1px,   transparent 2px);
  background-repeat: repeat, repeat, repeat;
  background-size: auto, 18px 18px, 12px 12px;
  background-position: 0 0, 0 0, 6px 6px;
  /* Seamless join with the BGA game area: no hard border, just a soft
     inner shadow on the left edge that fades the grass into the advisor
     without a visible vertical line. */
  box-shadow: inset 12px 0 16px -10px rgba(0,0,0,.25);
}
.events {
  position: fixed; top: 0; right: var(--chat-w); width: var(--ev-w); height: 100vh;
  z-index: 2147483645; display: flex; flex-direction: column;
  font: 12px/1.4 -apple-system, system-ui, sans-serif; color: var(--parchment);
  background-color: var(--grass-dark);
  background-image: var(--bga-bg, none),
    radial-gradient(rgba(255,255,255,.04) 1.2px, transparent 2px),
    radial-gradient(rgba(0,0,0,.10)       1px,   transparent 2px);
  background-repeat: repeat, repeat, repeat;
  background-size: auto, 18px 18px, 12px 12px;
  background-position: 0 0, 0 0, 6px 6px;
}
.tab {
  position: fixed; top: 50%; right: 0; z-index: 2147483646; transform: translateY(-50%);
  writing-mode: vertical-rl; background: var(--wood-mid); color: var(--parchment);
  border: 1px solid var(--wood-dark);
  border-right: none; border-radius: 6px 0 0 6px; padding: 10px 6px; cursor: pointer;
  font: 11px system-ui;
}
.resize-handle {
  position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
  cursor: ew-resize; z-index: 2; background: transparent;
  transition: background .15s ease;
}
.resize-handle:hover, .resize-handle.dragging { background: var(--wood-light); opacity: .65; }
.chat.resizing { user-select: none; cursor: ew-resize; }
header {
  display: flex; align-items: center; gap: 8px; padding: 0 11px;
  /* Match BGA's own top bar — color sampled at runtime from #topbar_content
     and written to --bga-header-bg / --bga-header-fg. Falls back to a wood
     palette before the sample lands. */
  background: var(--bga-header-bg, var(--wood-dark));
  color: var(--bga-header-fg, var(--parchment));
  border-bottom: 1px solid rgba(0,0,0,.18);
  flex: none;
  /* Dynamically matched to BGA's own top bar at mount + on resize so the
     advisor header sits flush with the game page chrome at any resolution.
     Defaults to 40px before the measurement lands. */
  min-height: var(--bga-header-h, 40px);
  box-sizing: border-box;
}
header b { font-size: 13px; }
.ver { font-size: 10px; opacity: .55; }
.ver-sub { font-size: 10px; opacity: .55; font-style: italic; margin-left: -3px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #555; }
.dot.healthy { background: #6fd870; } .dot.degraded { background: #e8b540; }
.dot.unhealthy { background: #e85a5a; }
.hbtn { margin-left: auto; display: flex; gap: 6px; }
.hbtn span {
  cursor: pointer; opacity: .75; font-size: 11px; padding: 2px 6px;
  border: 1px solid currentColor; border-radius: 5px;
  background: rgba(0,0,0,.05);
}
.hbtn span:hover { opacity: 1; background: rgba(0,0,0,.12); }
.scroll-wrap { position: relative; flex: 1; display: flex; min-height: 0; }
.transcript {
  flex: 1; overflow-y: auto; padding: 14px 12px 14px 18px; display: flex;
  flex-direction: column; gap: 10px;
}

/* Bubbles styled like Agricola's parchment cards over wooden trim. */
.msg { display: flex; flex-direction: column; max-width: 88%; gap: 3px; }
.msg.user { align-self: flex-end; align-items: flex-end; }
.msg.agent { align-self: flex-start; align-items: flex-start; }
.msg .bubble {
  padding: 9px 13px; white-space: pre-wrap; word-break: break-word;
  font-size: 13px; line-height: 1.45;
  box-shadow: 0 1px 2px rgba(0,0,0,.35);
  position: relative;
}
/* User: warm wood plank look */
.msg.user .bubble {
  background: var(--wood-mid); color: #f6ecd0;
  border: 1px solid var(--wood-dark);
  border-radius: 14px 14px 3px 14px;
}
/* Advisor: parchment card */
.msg.agent .bubble {
  background: var(--parchment); color: var(--parchment-ink);
  border: 1px solid var(--wood-light);
  border-radius: 14px 14px 14px 3px;
}
.msg.agent.advice .bubble {
  background: linear-gradient(180deg, var(--parchment) 0%, var(--parchment-dim) 100%);
  border-color: var(--wood-mid);
}
.msg.agent.error .bubble {
  background: #3a1a1a; color: #f6c0c0;
  border-color: #7a3a3a;
}
.msg.agent.superseded { opacity: .55; }
.msg.agent.superseded .bubble {
  background: #b8a989; border-color: #6a542a;
  text-decoration: line-through; text-decoration-color: rgba(0,0,0,.4);
}
/* The whole bubble (when it has rationale) is clickable to expand WHY.
   Subtle chevron in the bottom-right indicates expandability; rotates
   when expanded. */
.msg .bubble.has-why {
  cursor: pointer; padding-right: 26px;
  transition: filter .15s ease;
}
.msg .bubble.has-why:hover { filter: brightness(1.04); }
.msg .bubble.has-why::after {
  content: '▾';
  position: absolute; right: 9px; bottom: 5px;
  font-size: 12px; color: var(--parchment-ink-2);
  opacity: .55; transition: transform .15s ease, opacity .15s ease;
}
.msg.user .bubble.has-why::after { color: rgba(255,255,255,.65); }
.msg .bubble.has-why:hover::after { opacity: 1; }
.msg.expanded .bubble.has-why::after { transform: rotate(180deg); opacity: .9; }

/* Footer: just the timestamp now (no orange stamp, no Why? link — the
   bubble itself opens the rationale). Dark brown text reads cleanly on
   the grass background. */
.msg .footer {
  display: flex; gap: 8px; align-items: baseline;
  font-size: 11px; color: var(--wood-dark); opacity: .9;
  padding: 0 4px;
  font-weight: 600;
}
.msg.user .footer { flex-direction: row-reverse; }
.msg .footer .ts { font-variant-numeric: tabular-nums; }

/* The expandable rationale section — also parchment-styled. The diagnostic
   "seen:" stamp lives in here too (only visible when the bubble is
   expanded), so it stays inspectable without cluttering the bubble face. */
/* Garden whimsy: small earth-tone sprigs tucked into the corners of each
   bubble. SVG symbols defined once in a hidden defs block at the top of
   the shadow root; bubbles reference them via use. The currentColor trick
   lets each bubble role tint its own sprigs (sage/olive on parchment
   advisor, straw on wood user). On hover, sprigs gently sway and grow.
   Decorative only — aria-hidden plus pointer-events: none so they never
   interfere with text or click-to-expand. */
.sprig-defs { position: absolute; width: 0; height: 0; overflow: hidden;
  pointer-events: none; }
.msg { position: relative; }
/* Sprig sizing/positioning. Three nuances:
   1. transform-box: fill-box + transform-origin: center — without these
      the SVG element rotates around its own (0,0) corner instead of its
      visual center. (Was the v0.2.0.72 "hover sway not working" bug.)
   2. Rotation and hover sway are driven entirely by per-element CSS
      custom properties set inline by buildSprig — --rest-rot points the
      leaf outward from its corner, --hover-delta and --hover-scale make
      each sprig sway in its own direction/amount, and --sway-duration
      varies the timing so adjacent sprigs don't move in lockstep.
   3. z-index: -1 keeps them behind the bubble face so the bubble's
      parchment / wood background covers the half tucked under it — only
      the outward-facing portion peeks out of the corner. */
.msg .sprig {
  position: absolute;
  width: 38px; height: 38px;
  pointer-events: none;
  opacity: .78;
  transform-box: fill-box;
  transform-origin: center;
  transform: rotate(var(--rest-rot, -22deg));
  transition-property: transform, opacity;
  transition-duration: var(--sway-duration, 550ms), 350ms;
  transition-timing-function: cubic-bezier(.34, 1.56, .64, 1), ease-out;
  z-index: -1;
  /* Default sprig color — sage olive — overridden per bubble role below. */
  color: #4f7330;
}
.msg .sprig-tl { top:    -12px; left:  -12px; }
.msg .sprig-tr { top:    -12px; right: -12px; }
.msg .sprig-bl { bottom: -12px; left:  -12px; }
.msg .sprig-br { bottom: -12px; right: -12px; }
/* User bubbles get warmer straw-colored sprigs to match the wood bubble. */
.msg.user .sprig { color: #b89545; }
/* Hover sway: a single rule covers all four corners. Each sprig already
   carries its own --rest-rot, --hover-delta, and --hover-scale via inline
   style from buildSprig, so adjacent sprigs sway in different directions
   and amounts — feels like a real breeze instead of a synchronized dance. */
.msg:hover .sprig,
.msg:focus-within .sprig {
  transform: rotate(calc(var(--rest-rot, -22deg) + var(--hover-delta, 24deg)))
             scale(var(--hover-scale, 1.18));
  opacity: .95;
}
@media (prefers-reduced-motion: reduce) {
  .msg .sprig { transition: opacity .2s; }
  .msg:hover .sprig,
  .msg:focus-within .sprig {
    transform: rotate(var(--rest-rot, -22deg));
  }
}

/* Bug parade — emoji critters that crawl across the conversation. Layered
   above bubbles (z-index 5) so they walk over the parchment too. The Web
   Animations API drives one element per bug; this rule controls baseline
   appearance only. Animated opacity fades them in at one edge and out at
   the other so they appear to slip in and out of view, not pop on/off. */
.scroll-wrap .bug {
  position: absolute; top: 0; left: 0;
  width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; line-height: 1;
  pointer-events: none; user-select: none;
  z-index: 5;
  opacity: 0;
  /* Soft drop shadow gives the bugs a touch of weight against parchment
     bubbles — without it they look pasted on. */
  filter: drop-shadow(0 1px 1px rgba(0,0,0,.35));
  will-change: transform, opacity;
}
@media (prefers-reduced-motion: reduce) {
  .scroll-wrap .bug { display: none; }
}

.msg .why-text {
  display: none; margin-top: 4px; padding: 8px 12px;
  font-size: 12px; line-height: 1.45;
  color: var(--parchment-ink-2);
  background: rgba(234,216,168,.85);
  border: 1px solid var(--wood-light);
  border-radius: 4px;
  white-space: pre-wrap; word-break: break-word;
}
.msg .why-text .why-meta {
  display: block; margin-top: 6px;
  padding-top: 6px; border-top: 1px dashed var(--wood-light);
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 10px; color: #7a5a2a; opacity: .85;
  word-break: break-all;
}
.msg.expanded .why-text { display: block; }
/* Typing indicator — three dots bouncing while the LLM streams. Replaces
   the bubble content so the user never sees partial / scaffolding text. */
.typing-dots { display: inline-flex; gap: 5px; align-items: center;
  padding: 3px 2px; }
.typing-dots span { width: 7px; height: 7px; border-radius: 50%;
  background: var(--grass-dark); opacity: .5;
  animation: typing-bounce 1.1s infinite ease-in-out; }
.typing-dots span:nth-child(2) { animation-delay: .18s; }
.typing-dots span:nth-child(3) { animation-delay: .36s; }
@keyframes typing-bounce {
  0%, 70%, 100% { transform: translateY(0); opacity: .35; }
  35%           { transform: translateY(-5px); opacity: 1; }
}
.thinking { color: #f0c44a; font-style: italic; padding: 0 12px 8px; min-height: 18px; }
.thinking.streaming { color: #6b6d77; }
.thinking.reading { color: #8ab4ff; }
.empty { color: #6b6d77; padding: 20px 14px; text-align: center; }
.empty button, .setkey { margin-top: 10px; }
.keybanner { display: flex; align-items: center; gap: 8px; padding: 7px 11px;
  background: #2a221a; border-top: 1px solid #4a3a22; color: #ffd28a; font-size: 12px; }
.keybanner button { background: #5a3a18; border-color: #7a5024; color: #fff;
  margin-left: auto; padding: 4px 9px; font-size: 11px; }
.newpill { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
  background: #2a8a55; color: #fff; padding: 4px 10px; border-radius: 14px;
  font-size: 11px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.5);
  user-select: none; z-index: 1; }
.newpill:hover { background: #34a366; }
.input { display: flex; gap: 7px; padding: 10px; border-top: 1px solid #23242b; flex: none; }
.input textarea { flex: 1; resize: none; height: 38px; background: #1c1d23; color: #e8e8ea;
  border: 1px solid #3a3d47; border-radius: 6px; padding: 8px 10px; font: inherit; }
.input textarea:disabled { opacity: .5; }
button { font: 12px system-ui; background: #2a2c34; color: #e8e8ea; border: 1px solid #3a3d47;
  border-radius: 6px; padding: 7px 12px; cursor: pointer; }
button:hover { background: #343742; }
button.primary { background: #1f6f43; border-color: #2a8a55; color: #fff; }
button.on { background: #1f6f43; border-color: #2a8a55; color: #fff; }
.evmeta { padding: 8px 11px; color: #9aa; border-bottom: 1px solid #23242b; }
.evmeta .reason { color: #777; font-size: 11px; margin-top: 2px; }
.stats { display: flex; gap: 10px; padding: 7px 11px; border-bottom: 1px solid #23242b;
  flex-wrap: wrap; }
.stats b { color: #fff; }
.ctl { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 11px;
  border-bottom: 1px solid #23242b; }
.ctl button { font-size: 11px; padding: 5px 9px; }
.feed { flex: 1; overflow-y: auto; padding: 4px 0; }
.row { display: grid; grid-template-columns: 58px 52px 1fr; gap: 6px;
  padding: 3px 11px; border-bottom: 1px solid #1d1e24; }
.row .tm { color: #6b6d77; } .row .kd { color: #8ab4ff; font-size: 10px;
  text-transform: uppercase; } .row .sm { color: #d6d6da; word-break: break-word; }
.row.turn { background: #1a2c1f; } .row.turn .sm { color: #7fe6a4; font-weight: 600; }
`;

/** Per-message DOM record kept across renders so streaming mutates in place. */
interface RowDom {
  row: HTMLElement;
  bubble: HTMLElement;
  footer: HTMLElement;
  tsEl: HTMLElement;
  /** The full rationale block — hidden by default, revealed when the bubble
   *  is clicked. Contains the WHY text + the diagnostic stamp at the bottom. */
  whyEl?: HTMLElement;
  /** Diagnostic stamp (e.g. "seen: R3 work …"), nested INSIDE whyEl so it
   *  only shows when expanded — keeps the bubble face clean. */
  metaEl?: HTMLElement;
  lastKind?: string;
  lastContent?: string;
  lastMeta?: string;
  lastStreaming?: boolean;
}

/** HTML fragment for the three-bouncing-dots typing indicator. Built fresh
 *  for each streaming bubble so the animation timeline starts cleanly. */
function buildTypingIndicator(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'typing-dots';
  el.innerHTML = '<span></span><span></span><span></span>';
  return el;
}

/** Inline SVG <symbol> definitions for the garden sprigs. Embedded once in
 *  the shadow root; each bubble references via <use>. Five variants — all
 *  emphasising pointed leaf tips rather than round blobs — keep the panel
 *  from looking uniform when many bubbles stack up. All share the 24×24
 *  viewBox so positioning logic stays simple.
 *
 *  Design note: every shape's "axis" is roughly vertical (tip up, stem
 *  down), so when buildSprig rotates by ±45° the leaf points outward from
 *  whichever corner it lives in. Letting the SVG dictate orientation
 *  keeps the CSS rotation logic uniform across slots. */
const SPRIG_DEFS_SVG = `
<svg class="sprig-defs" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <!-- Two-leaf sprig: a slightly curling stem with a pair of pointed
         lanceolate leaves. Cubic curves on each leaf give a sharper tip
         than the original quadratic teardrops. -->
    <symbol id="sprig-leaf-pair" viewBox="0 0 24 24">
      <path d="M 12 23 C 11 17 13 13 12 7 C 11 4 13 3 12 1"
            fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" opacity=".95"/>
      <path d="M 12 12 C 6 13 3 10 2 4 C 8 6 12 9 12 12 Z"
            fill="currentColor" opacity=".95"/>
      <path d="M 12 15 C 18 15 21 12 22 6 C 16 8 12 12 12 15 Z"
            fill="currentColor" opacity=".95"/>
      <path d="M 12 12 L 5 7" fill="none" stroke="currentColor"
            stroke-width=".7" opacity=".5"/>
      <path d="M 12 15 L 19 10" fill="none" stroke="currentColor"
            stroke-width=".7" opacity=".5"/>
    </symbol>
    <!-- Single lance-shaped blade: one long leaf with a sharp tip and a
         visible central vein. Reads cleanly at 38px even though it's a
         single shape — uses an asymmetric curve so it feels organic. -->
    <symbol id="sprig-blade" viewBox="0 0 24 24">
      <path d="M 12 1 C 17 7 17 14 14 22 C 13 22 11 22 10 22 C 7 14 7 7 12 1 Z"
            fill="currentColor" opacity=".95"/>
      <line x1="12" y1="2" x2="12" y2="22"
            stroke="currentColor" stroke-width=".7" opacity=".55"/>
    </symbol>
    <!-- Fern frond: a central stem with five alternating pointed leaflets
         shrinking towards the tip — the classic fern silhouette. -->
    <symbol id="sprig-fern" viewBox="0 0 24 24">
      <line x1="12" y1="23" x2="12" y2="2"
            stroke="currentColor" stroke-width="1.4"
            stroke-linecap="round" opacity=".95"/>
      <path d="M 12 19 C 7 19 4 21 1 22 C 5 18 9 18 12 19 Z"
            fill="currentColor" opacity=".95"/>
      <path d="M 12 15 C 17 15 20 17 23 18 C 19 14 15 14 12 15 Z"
            fill="currentColor" opacity=".95"/>
      <path d="M 12 11 C 7 11 5 12 2 13 C 6 9 10 9 12 11 Z"
            fill="currentColor" opacity=".95"/>
      <path d="M 12 7 C 16 7 18 8 21 9 C 17 5 14 5 12 7 Z"
            fill="currentColor" opacity=".95"/>
      <path d="M 12 4 C 14 4 16 4 18 4 C 16 2 13 2 12 4 Z"
            fill="currentColor" opacity=".95"/>
    </symbol>
    <!-- Trefoil: three sharply pointed leaves radiating from a tiny stem.
         Cubic curves with their control points pulled toward the tip
         give a real leaf silhouette (vs. the original rounded clover). -->
    <symbol id="sprig-trefoil" viewBox="0 0 24 24">
      <line x1="12" y1="18" x2="12" y2="23"
            stroke="currentColor" stroke-width="1.3"
            stroke-linecap="round" opacity=".9"/>
      <path d="M 12 18 C 7 12 8 5 12 1 C 16 5 17 12 12 18 Z"
            fill="currentColor" opacity=".95"/>
      <path d="M 12 18 C 8 15 4 16 1 20 C 5 22 9 21 12 18 Z"
            fill="currentColor" opacity=".95"/>
      <path d="M 12 18 C 16 15 20 16 23 20 C 19 22 15 21 12 18 Z"
            fill="currentColor" opacity=".95"/>
    </symbol>
    <!-- Curling tendril with a pointed leaf at the tip — adds whimsy
         and breaks up the "leaves on stems" rhythm of the other four. -->
    <symbol id="sprig-curl" viewBox="0 0 24 24">
      <path d="M 4 23 C 14 20 7 13 17 11 C 22 10 20 5 16 5"
            fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" opacity=".95"/>
      <path d="M 16 5 C 12 3 11 7 14 9 C 18 10 20 6 16 5 Z"
            fill="currentColor" opacity=".95"/>
    </symbol>
  </defs>
</svg>
`;

/** Sprig corners. Bubble decoration sits at any of the four bubble
 *  corners; placement is picked per-message so each bubble feels unique. */
type SprigSlot = 'tl' | 'tr' | 'bl' | 'br';

const SPRIG_VARIANTS = [
  'sprig-leaf-pair',
  'sprig-blade',
  'sprig-fern',
  'sprig-trefoil',
  'sprig-curl',
] as const;

/** Deterministic 32-bit hash with a salt. Same (message, salt) always
 *  yields the same number, so re-renders don't reshuffle decorations.
 *  Using FNV-1a (32-bit) gives a much better distribution than
 *  `h = h * 31 + c`, which was clustering identical variants on bubbles
 *  with similar content/length. */
function sprigHash(m: TranscriptMsg, salt: string): number {
  const src = `${m.role}|${m.content.length}|${m.ts ?? ''}|${salt}`;
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return h >>> 0;
}

/** Pick which corners get a sprig for this message. Mostly two corners
 *  (a random pair out of the six possible from four corners), occasionally
 *  one (breathing room) or three (rare flourish). Stable across renders. */
function pickSprigSlots(m: TranscriptMsg): SprigSlot[] {
  const corners: SprigSlot[] = ['tl', 'tr', 'bl', 'br'];
  const seed = sprigHash(m, 'placement');
  const r = seed % 100;
  if (r < 72) {
    // Two corners — pick from the six pairs uniformly.
    const pairs: [SprigSlot, SprigSlot][] = [
      ['tl', 'br'], ['tr', 'bl'], // diagonals
      ['tl', 'tr'], ['bl', 'br'], // top / bottom edges
      ['tl', 'bl'], ['tr', 'br'], // left / right edges
    ];
    const p = pairs[Math.floor((seed >>> 7) % pairs.length)]!;
    return [p[0], p[1]];
  }
  if (r < 94) {
    // One corner — any of the four.
    return [corners[Math.floor((seed >>> 7) % 4)]!];
  }
  // Three corners — skip a random one. Rare flourish.
  const skip = Math.floor((seed >>> 7) % 4);
  return corners.filter((_, i) => i !== skip);
}

/** Resolve a per-sprig motion profile: rest rotation, hover sway delta,
 *  hover scale, and transition duration. Each value is jittered around a
 *  slot-dependent baseline so the sprig points outward at rest and sways
 *  in a slightly different direction/amount per bubble. */
interface SprigMotion {
  restRotDeg: number;
  hoverDeltaDeg: number;
  hoverScale: number;
  durationMs: number;
}

const SLOT_BASE_ROT: Record<SprigSlot, number> = {
  tl:  -45,  // points up-left out of the corner
  tr:   45,  // points up-right
  bl: -135,  // points down-left
  br:  135,  // points down-right
};

function pickSprigMotion(m: TranscriptMsg, slot: SprigSlot): SprigMotion {
  const seedRot   = sprigHash(m, `rot:${slot}`);
  const seedSway  = sprigHash(m, `sway:${slot}`);
  const seedScale = sprigHash(m, `scale:${slot}`);
  const seedDur   = sprigHash(m, `dur:${slot}`);

  // Jitter rest rotation by ±22° around the slot's baseline. Big enough
  // to make adjacent sprigs visibly different, small enough that leaves
  // still point outward from the bubble corner.
  const restJitter = ((seedRot % 45) - 22);
  const restRotDeg = SLOT_BASE_ROT[slot] + restJitter;

  // Hover sway: signed ±18°-32°. Sign comes from the high bit of the
  // sway seed so half the sprigs sway clockwise and half counter, even
  // within the same bubble — feels like a real breeze.
  const swayMag = 18 + (seedSway % 15);          // 18-32°
  const swaySign = (seedSway & 0x80000000) ? -1 : 1;
  const hoverDeltaDeg = swayMag * swaySign;

  // Hover scale: 1.10 - 1.22.
  const hoverScale = 1.10 + (seedScale % 13) / 100;

  // Transition duration: 420-700ms. Mixes "snappy" and "languid" so the
  // sprigs don't sway in lockstep when many bubbles render in sequence.
  const durationMs = 420 + (seedDur % 280);

  return { restRotDeg, hoverDeltaDeg, hoverScale, durationMs };
}

/** Build one <svg><use href="#sprig-X"/></svg> decoration element for a
 *  bubble corner. The SVG uses the SVG namespace because document
 *  createElement('svg') would yield an HTML element. Per-sprig motion
 *  variance is written to inline CSS custom properties so each leaf can
 *  rest, sway, and scale independently of its neighbours. */
function buildSprig(m: TranscriptMsg, slot: SprigSlot): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `sprig sprig-${slot}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const variantIdx = sprigHash(m, `variant:${slot}`) % SPRIG_VARIANTS.length;
  const variant = SPRIG_VARIANTS[variantIdx]!;
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${variant}`);
  svg.appendChild(use);

  const motion = pickSprigMotion(m, slot);
  // Stash motion as inline custom properties — the .sprig CSS reads them
  // via var(...). Keeps the CSS rule generic; the per-bubble variance
  // lives entirely on the element instance.
  svg.style.setProperty('--rest-rot',     `${motion.restRotDeg}deg`);
  svg.style.setProperty('--hover-delta',  `${motion.hoverDeltaDeg}deg`);
  svg.style.setProperty('--hover-scale',  `${motion.hoverScale}`);
  svg.style.setProperty('--sway-duration', `${motion.durationMs}ms`);
  return svg;
}

/** Bug parade — occasional emoji critters that crawl across the conversation.
 *  Each bug is a long-lived DOM node that cycles: walk across panel → wait
 *  off-screen → walk again from a fresh edge with a new emoji. 2-4 bugs
 *  active at any time per the design discussion.
 *
 *  Per-character "personality" knobs (wiggleAmp/freq, speedMul) make a snail
 *  drag straight and slow while a bee zigzags fast — without this the bugs
 *  feel like interchangeable sprites. */
interface BugCharacter {
  emoji: string;
  /** Min/max length of one scuttle segment in px. Bugs walk in bursts of
   *  this distance, pause briefly, then plan the next segment. Real bugs
   *  don't glide — they dart. */
  scuttleMin: number;
  scuttleMax: number;
  /** Pause between segments in ms. 0 = continuous (bee, snail). */
  pauseMin: number;
  pauseMax: number;
  /** Max heading change between segments, in degrees. Caterpillars barely
   *  turn; bees zigzag wildly. */
  turnMaxDeg: number;
  /** Segment duration is length × this. Snail ~25 ms/px = drag; bee ~4 ms/px
   *  = quick darts. */
  segMsPerPx: number;
  /** Default facing direction of the emoji glyph in most fonts. Top-down
   *  bugs (ladybug, butterfly, beetle) face 'up'; side-view bugs (bee,
   *  snail, ant, caterpillar) face 'right'. Used to align rotation so the
   *  emoji points the way it's traveling. */
  baseOrient: 'up' | 'right';
}

const BUG_POOL: readonly BugCharacter[] = [
  { emoji: '🐞', scuttleMin:  30, scuttleMax:  60, pauseMin:  80, pauseMax: 280, turnMaxDeg: 22, segMsPerPx:  6, baseOrient: 'up'    },
  { emoji: '🐝', scuttleMin:  25, scuttleMax:  55, pauseMin:   0, pauseMax:  40, turnMaxDeg: 55, segMsPerPx:  4, baseOrient: 'right' },
  { emoji: '🐌', scuttleMin: 220, scuttleMax: 340, pauseMin:   0, pauseMax:   0, turnMaxDeg:  4, segMsPerPx: 25, baseOrient: 'right' },
  { emoji: '🦋', scuttleMin:  60, scuttleMax: 110, pauseMin: 220, pauseMax: 500, turnMaxDeg: 38, segMsPerPx:  7, baseOrient: 'up'    },
  { emoji: '🐜', scuttleMin:  25, scuttleMax:  50, pauseMin:  60, pauseMax: 220, turnMaxDeg: 22, segMsPerPx:  5, baseOrient: 'right' },
  { emoji: '🪲', scuttleMin:  40, scuttleMax:  75, pauseMin: 120, pauseMax: 340, turnMaxDeg: 15, segMsPerPx:  8, baseOrient: 'up'    },
  { emoji: '🐛', scuttleMin:  15, scuttleMax:  30, pauseMin:  90, pauseMax: 200, turnMaxDeg: 10, segMsPerPx: 13, baseOrient: 'right' },
];

const BUG_PARADE_SIZE = 3; // mid of the 2-4 range agreed during design
const BUG_PEAK_OPACITY = 1.0; // user wants bugs at full visibility
const BUG_PATH_FADE_PX = 80; // px of distance over which a bug fades in/out
const BUG_BUBBLE_REPEL_R = 64; // bubble repulsion influence radius in px
const BUG_BUBBLE_REPEL_BLEND = 0.45; // how strongly repulsion bends heading

/** Spawn the bug parade inside the given container (typically .scroll-wrap).
 *  Each bug runs an independent async loop — no shared scheduler, so one
 *  bug's walk never blocks another. Idempotent guard via a data flag on
 *  the container so accidental double-init doesn't double the bugs. */
function startBugParade(container: HTMLElement): void {
  if (container.dataset['bugParade'] === 'on') return;
  container.dataset['bugParade'] = 'on';
  for (let i = 0; i < BUG_PARADE_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'bug';
    el.setAttribute('aria-hidden', 'true');
    container.appendChild(el);
    // Stagger initial appearances so the first three don't enter together.
    const initialDelay = 1200 + i * 5500 + Math.random() * 3500;
    setTimeout(() => void runBugLoop(el, container), initialDelay);
  }
}

type BugEdge = 'top' | 'right' | 'bottom' | 'left';
const BUG_EDGES: readonly BugEdge[] = ['top', 'right', 'bottom', 'left'];

function bugSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Continuous loop: walk a bug across the panel, rest off-screen, repeat.
 *  Wrapped in try/catch so a thrown animation or DOM error ends the loop
 *  gracefully (e.g. when the host is removed from the page). */
async function runBugLoop(el: HTMLElement, container: HTMLElement): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await walkBugOnce(el, container);
    } catch {
      return; // host removed / animation cancelled mid-flight — stop quietly
    }
    // 6-18s off-screen, then re-enter from a fresh edge with a new emoji.
    await bugSleep(6000 + Math.random() * 12000);
  }
}

/** Animate one cameo: enter from a random edge, scuttle across the panel
 *  in short bursts, then exit. Each segment plans its next heading with
 *  a small random turn, bias toward staying in-bounds, and gentle
 *  repulsion away from nearby bubbles — so the path feels bug-like
 *  rather than gliding. */
async function walkBugOnce(el: HTMLElement, container: HTMLElement): Promise<void> {
  const rect = container.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w < 40 || h < 40) {
    await bugSleep(4000); // panel collapsed or not yet laid out
    return;
  }

  const bug = BUG_POOL[Math.floor(Math.random() * BUG_POOL.length)]!;
  el.textContent = bug.emoji;

  // Pick an entry edge and start the bug just off-screen, heading inward.
  const entryEdge = BUG_EDGES[Math.floor(Math.random() * 4)]!;
  let { x, y } = pointOnBugEdge(entryEdge, w, h);
  let heading = inwardHeadingRad(entryEdge);
  // Wobble the inward heading a bit so consecutive entries on the same
  // edge don't all point straight in.
  heading += (Math.random() - 0.5) * (Math.PI / 3);

  let prevRotDeg = headingToRotDeg(heading, bug.baseOrient);
  // Place the bug at entry with rotation aligned, fully transparent — the
  // first segment will fade it in over the first BUG_PATH_FADE_PX.
  el.style.opacity = '0';
  el.style.transform = `translate(${x}px, ${y}px) rotate(${prevRotDeg}deg)`;

  // Total path budget — bug walks this many px before naturally fading out.
  const targetPath = 700 + Math.random() * 600; // 700-1300 px
  let traveled = 0;

  while (traveled < targetPath) {
    // Plan next segment: random length + small heading turn.
    const segLen =
      bug.scuttleMin + Math.random() * (bug.scuttleMax - bug.scuttleMin);
    const turnDeg = (Math.random() - 0.5) * 2 * bug.turnMaxDeg;
    heading += turnDeg * Math.PI / 180;
    // Gentle steer back toward the interior when the bug nears an edge.
    heading = biasInBounds(heading, x, y, w, h);
    // Bubble avoidance — soft repulsion from nearby bubble rects.
    heading = applyBubbleRepulsion(heading, x, y, container, rect);

    const nx = x + Math.cos(heading) * segLen;
    const ny = y + Math.sin(heading) * segLen;

    // Rotate the emoji to align with travel direction. Computing the
    // shortest angular delta from prevRotDeg avoids spinning 350° when
    // 10° in the other direction would do.
    const targetRotDeg = headingToRotDeg(heading, bug.baseOrient);
    const rotDelta = shortestAngleDeltaDeg(prevRotDeg, targetRotDeg);
    const endRotDeg = prevRotDeg + rotDelta;

    // Fade in over the first PATH_FADE_PX, hold at peak, fade out over
    // the last PATH_FADE_PX. Interpolated linearly between start/end of
    // each segment so the animation API can blend it smoothly.
    const startOp = bugFadeOpacity(traveled, targetPath);
    const endOp = bugFadeOpacity(traveled + segLen, targetPath);

    const segDuration = Math.max(80, segLen * bug.segMsPerPx);

    // Ease-in-out per segment: bug accelerates, then decelerates to a
    // brief stop. Stringing many of these together with short pauses is
    // what creates the scuttling, real-bug feel — vs. one long animation
    // with linear easing which reads as gliding.
    const anim = el.animate(
      [
        {
          transform: `translate(${x}px, ${y}px) rotate(${prevRotDeg}deg)`,
          opacity: startOp,
        },
        {
          transform: `translate(${nx}px, ${ny}px) rotate(${endRotDeg}deg)`,
          opacity: endOp,
        },
      ],
      {
        duration: segDuration,
        easing: 'cubic-bezier(.45, 0, .55, 1)',
        fill: 'forwards',
      },
    );
    await anim.finished;
    // Commit the final keyframe into inline style and release the
    // animation. Without this, finished-but-held WAA animations stack
    // on the element and chew memory across many cameos.
    try { anim.commitStyles(); } catch { /* element detached */ }
    anim.cancel();

    x = nx;
    y = ny;
    prevRotDeg = endRotDeg;
    traveled += segLen;

    // Cap heading at a normalised range so prevRotDeg doesn't drift
    // unboundedly across many segments (purely numerical hygiene).
    prevRotDeg = ((prevRotDeg + 540) % 360) - 180;

    // Pause between segments (skipped for snail/bee since pauseMax = 0).
    if (bug.pauseMax > 0) {
      const pauseMs =
        bug.pauseMin + Math.random() * (bug.pauseMax - bug.pauseMin);
      if (pauseMs > 0) await bugSleep(pauseMs);
    }

    // Bug wandered well off-screen — end the cameo early.
    if (x < -60 || x > w + 60 || y < -60 || y > h + 60) break;
  }

  el.style.opacity = '0';
}

function pointOnBugEdge(
  edge: BugEdge,
  w: number,
  h: number,
): { x: number; y: number } {
  const OFF = 32;
  switch (edge) {
    case 'top':    return { x: Math.random() * w, y: -OFF };
    case 'bottom': return { x: Math.random() * w, y: h + OFF };
    case 'left':   return { x: -OFF,             y: Math.random() * h };
    case 'right':  return { x: w + OFF,          y: Math.random() * h };
  }
}

/** Heading (radians) that points inward from the given edge. Used to set
 *  the initial direction so a bug entering from the right starts walking
 *  left, etc. */
function inwardHeadingRad(edge: BugEdge): number {
  switch (edge) {
    case 'top':    return Math.PI / 2;   // down
    case 'bottom': return -Math.PI / 2;  // up
    case 'left':   return 0;             // right
    case 'right':  return Math.PI;       // left
  }
}

/** Convert a motion heading to a CSS rotation, accounting for the emoji's
 *  default facing direction. Top-down bugs (head at top of glyph) need
 *  +90° so heading=0 (rightward motion) rotates them to face right. */
function headingToRotDeg(
  headingRad: number,
  baseOrient: 'up' | 'right',
): number {
  return headingRad * 180 / Math.PI + (baseOrient === 'up' ? 90 : 0);
}

/** Shortest signed angular delta from a → b, both in degrees. Result is
 *  in (-180, 180]. Avoids the "spin the long way around" jitter when a
 *  bug turns more than 180° between segments. */
function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

/** Lerp between two angles (radians) along the shortest path. */
function blendAnglesRad(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2;
  const diff = ((b - a + Math.PI * 3) % TAU) - Math.PI;
  return a + diff * t;
}

/** When a bug nears a panel edge AND is heading further outward, gently
 *  rotate its heading back toward the interior. Without this, bugs that
 *  pick an edge-grazing heading early on would just slide along the
 *  border looking awkward instead of crossing the panel. */
function biasInBounds(
  heading: number,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const MARGIN = 60;
  let bx = 0;
  let by = 0;
  if (x < MARGIN) bx = 1;
  else if (x > w - MARGIN) bx = -1;
  if (y < MARGIN) by = 1;
  else if (y > h - MARGIN) by = -1;
  if (bx === 0 && by === 0) return heading;
  const dx = Math.cos(heading);
  const dy = Math.sin(heading);
  // Only steer if the bug is heading further toward the edge.
  if (
    (bx !== 0 && Math.sign(dx) === -bx) ||
    (by !== 0 && Math.sign(dy) === -by)
  ) {
    const inwardRad = Math.atan2(by !== 0 ? by : dy, bx !== 0 ? bx : dx);
    return blendAnglesRad(heading, inwardRad, 0.35);
  }
  return heading;
}

/** Soft repulsion from nearby bubble rects: returns a heading rotated
 *  away from any bubble whose surface is within BUG_BUBBLE_REPEL_R px.
 *  Strength scales linearly from 0 at the influence radius up to 1 at the
 *  bubble surface, and the result is blended with the original heading
 *  via BUG_BUBBLE_REPEL_BLEND. Net effect: bugs curve around bubbles
 *  most of the time but can still cross when momentum carries them in. */
function applyBubbleRepulsion(
  heading: number,
  x: number,
  y: number,
  container: HTMLElement,
  containerRect: DOMRect,
): number {
  const bubbles = container.querySelectorAll<HTMLElement>('.bubble');
  let rx = 0;
  let ry = 0;
  for (const bubble of Array.from(bubbles)) {
    const br = bubble.getBoundingClientRect();
    const bcx = (br.left + br.right) / 2 - containerRect.left;
    const bcy = (br.top + br.bottom) / 2 - containerRect.top;
    const halfW = (br.right - br.left) / 2;
    const halfH = (br.bottom - br.top) / 2;
    const ddx = x - bcx;
    const ddy = y - bcy;
    const distCenter = Math.hypot(ddx, ddy);
    // Approximate distance from bug to bubble surface — treats the bubble
    // as an ellipse via the larger half-extent. Imperfect for very long
    // bubbles but cheap and good enough for soft avoidance.
    const surfaceDist = distCenter - Math.max(halfW, halfH);
    if (surfaceDist >= BUG_BUBBLE_REPEL_R) continue;
    const strength = 1 - Math.max(0, surfaceDist) / BUG_BUBBLE_REPEL_R;
    const norm = Math.max(1, distCenter);
    rx += (ddx / norm) * strength;
    ry += (ddy / norm) * strength;
  }
  if (rx === 0 && ry === 0) return heading;
  const repelRad = Math.atan2(ry, rx);
  return blendAnglesRad(heading, repelRad, BUG_BUBBLE_REPEL_BLEND);
}

/** Per-segment fade curve: 0 at entry/exit, BUG_PEAK_OPACITY across the
 *  middle of the cameo. Computed off the running traveled-px count so
 *  the fade happens over a fixed distance regardless of how many short
 *  segments make it up. */
function bugFadeOpacity(traveled: number, targetPath: number): number {
  if (traveled < BUG_PATH_FADE_PX) {
    return BUG_PEAK_OPACITY * (traveled / BUG_PATH_FADE_PX);
  }
  if (traveled > targetPath - BUG_PATH_FADE_PX) {
    return (
      BUG_PEAK_OPACITY *
      Math.max(0, (targetPath - traveled) / BUG_PATH_FADE_PX)
    );
  }
  return BUG_PEAK_OPACITY;
}

export class Sidebar {
  private host?: HTMLDivElement;
  private root?: ShadowRoot;
  private els: Record<string, HTMLElement> = {};
  private collapsed = false;
  private eventsOpen = false;
  private prevMargin = '';
  /** Map message identity → its DOM record. Cleared whenever the transcript
   *  is fully replaced (rare). Mutating m.content in place lets the next
   *  render simply update the bubble's textContent rather than rebuild. */
  private rowMap = new WeakMap<TranscriptMsg, RowDom>();
  /** Mirrors `state.transcript` order from the previous render — we use it
   *  to detect appended messages and to unmount stale rows. */
  private renderedOrder: TranscriptMsg[] = [];
  /** True iff the transcript was scrolled near the bottom at the last user
   *  scroll. If false, new content does NOT auto-scroll and we offer a pill. */
  private stickyBottom = true;
  /** True iff something has appended/changed since the user last scrolled
   *  away from the bottom — drives the "New ↓" pill. */
  private hasUnseenBelow = false;
  /** Current chat-panel width in pixels — initially the default, swapped
   *  to the persisted value on mount, mutated by the resize handle. */
  private chatWidth = DEFAULT_CHAT_W;

  constructor(private readonly handlers: SidebarHandlers) {}

  private dock(): void {
    const html = document.documentElement;
    if (this.collapsed) {
      html.style.setProperty('margin-right', this.prevMargin || '0px');
      return;
    }
    const w = this.chatWidth + (this.eventsOpen ? EV_W : 0);
    html.style.setProperty('margin-right', `${w}px`, 'important');
  }

  /** Apply a new chat-panel width: clamp, write the CSS custom property
   *  (which the .chat and .events selectors read via `var(--chat-w)`), and
   *  re-dock the host margin so the BGA page stays aligned. */
  private setChatWidth(w: number, persist: boolean): void {
    const clamped = Math.max(MIN_CHAT_W, Math.min(MAX_CHAT_W, Math.round(w)));
    this.chatWidth = clamped;
    if (this.host) this.host.style.setProperty('--chat-w', `${clamped}px`);
    // The :host inside Shadow DOM is what actually owns --chat-w in CSS;
    // setting it on the host element is the cleanest path. We mirror to the
    // root for older Chrome where :host var inheritance behaves oddly.
    if (this.root) {
      const styleHost = this.root.host as HTMLElement | undefined;
      styleHost?.style.setProperty('--chat-w', `${clamped}px`);
    }
    this.dock();
    if (persist) {
      try {
        chrome.storage?.local?.set?.({ [CHAT_WIDTH_STORAGE_KEY]: clamped });
      } catch {
        /* storage best-effort — width still applies for this session */
      }
    }
  }

  /** Load the user's previously-chosen width on mount; no-op if none. */
  private async loadPersistedWidth(): Promise<void> {
    try {
      const r = await chrome.storage?.local?.get?.(CHAT_WIDTH_STORAGE_KEY);
      const v = (r as Record<string, unknown> | undefined)?.[CHAT_WIDTH_STORAGE_KEY];
      if (typeof v === 'number' && Number.isFinite(v)) {
        this.setChatWidth(v, false);
      }
    } catch {
      /* storage best-effort */
    }
  }

  /** Find BGA's own top header element (selectors vary by theme/era), measure
   *  its rendered height, and write it to a CSS variable so our header
   *  matches. Re-runs on layout changes via ResizeObserver, and a final
   *  fallback on window resize. No-op (default 40px) if no BGA header is
   *  located — the advisor still renders, just at the default size. */
  private syncBgaHeaderHeight(): void {
    if (!this.host) return;
    const CANDIDATE_SELECTORS = [
      '#topbar_content',          // confirmed by user inspect — Agricola
      '#current_header_infos_wrap',
      '#globalheader',
      '#bgawebsite_header',
      '#right_page_header',
      '#header',
      '.bga-page-header',
      '.bga-top-bar',
    ];
    let bgaHeader: HTMLElement | null = null;
    for (const sel of CANDIDATE_SELECTORS) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.offsetHeight > 0) {
        bgaHeader = el;
        break;
      }
    }
    if (!bgaHeader) return;
    const apply = (): void => {
      try {
        const h = bgaHeader!.offsetHeight;
        if (h > 0 && this.host) {
          this.host.style.setProperty('--bga-header-h', `${h}px`);
        }
        // Also steal BGA's header pigment (solid color OR gradient) so the
        // advisor header blends visually with the game chrome. BGA's bar
        // uses a transparent #topbar_content with the visible gradient on
        // a descendant — `findHeaderBgPigment` walks the subtree to find it.
        if (this.host) {
          const bg = this.findHeaderBgPigment(bgaHeader!);
          const fg = window.getComputedStyle(bgaHeader!).color;
          if (bg) this.host.style.setProperty('--bga-header-bg', bg);
          if (fg) this.host.style.setProperty('--bga-header-fg', fg);
        }
      } catch {
        /* never break the host page */
      }
    };
    apply();
    // ResizeObserver covers BGA-side layout shifts (responsive breakpoints,
    // banner reveal/hide). Window resize is a belt-and-suspenders fallback.
    try {
      const ro = new ResizeObserver(apply);
      ro.observe(bgaHeader);
    } catch {
      /* older browsers — fall through to resize listener only */
    }
    window.addEventListener('resize', apply, { passive: true });
  }

  /** Find the visible pigment for BGA's header — could be a solid color OR
   *  a gradient applied to a descendant. Strategy:
   *    1) Check the element itself (color or background-image).
   *    2) BFS through descendants — many BGA top bars stack transparent
   *       containers and put the visible gradient on a deep child like
   *       \`#ingame_menu_content\` (linear-gradient(248,248,248 → 231,233,232)).
   *    3) Walk up ancestors as a last resort.
   *  Returns either a color string ("rgb(...)") or a background-image
   *  string ("linear-gradient(...)"); both are valid CSS `background` values.
   *  Empty string if nothing pigmented found. */
  private findHeaderBgPigment(root: HTMLElement): string {
    const probe = (el: HTMLElement): string => {
      try {
        const cs = window.getComputedStyle(el);
        const bg = cs.backgroundColor;
        if (bg && bg !== 'transparent' && !/rgba?\([^)]*,\s*0\s*\)/i.test(bg)) {
          return bg;
        }
        const bgImg = cs.backgroundImage;
        if (bgImg && bgImg !== 'none') {
          return bgImg;
        }
      } catch {
        /* cross-origin or stale element — skip */
      }
      return '';
    };

    // 1) Try the element itself
    const self = probe(root);
    if (self) return self;

    // 2) BFS through descendants (capped to avoid runaway on huge subtrees)
    const queue: HTMLElement[] = [root];
    const seen = new Set<HTMLElement>();
    while (queue.length > 0 && seen.size < 60) {
      const el = queue.shift()!;
      if (seen.has(el)) continue;
      seen.add(el);
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const c = probe(child);
        if (c) return c;
        queue.push(child);
      }
    }

    // 3) Walk up ancestors as a last resort
    let cur: HTMLElement | null = root.parentElement;
    let safety = 8;
    while (cur && safety-- > 0) {
      const p = probe(cur);
      if (p) return p;
      cur = cur.parentElement;
    }
    return '';
  }

  /** Locate BGA's Agricola grass background image and apply it to our
   *  panel. Two strategies:
   *
   *  1) Best: find the loaded \`agricola.css\` stylesheet and resolve
   *     \`img/background.jpg\` against its href. Uses the browser's own URL
   *     resolution — guaranteed to match whatever theme version BGA shipped.
   *
   *  2) Fallback: walk all DOM elements looking for a computed
   *     \`background-image\` that contains "background.jpg", extract that URL.
   *
   *  Falls back silently to the CSS pattern in the stylesheet if neither
   *  finds anything. */
  private syncAgricolaBackground(): void {
    if (!this.host) return;
    let url: string | null = null;

    // Strategy 1: locate agricola.css and resolve img/background.jpg
    try {
      const sheets = Array.from(document.styleSheets);
      for (const sheet of sheets) {
        const href = (sheet as CSSStyleSheet).href || '';
        if (/agricola[^/]*\.css/i.test(href)) {
          url = new URL('img/background.jpg', href).href;
          break;
        }
      }
    } catch {
      /* cross-origin sheets throw on .href access in some browsers — skip */
    }

    // Strategy 2: brute-force scan for any element bg image referencing
    // background.jpg. Slow but only runs once at mount.
    if (!url) {
      try {
        const all = document.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          const el = all[i] as HTMLElement;
          const bg = window.getComputedStyle(el).backgroundImage;
          if (!bg || bg === 'none') continue;
          if (!/background\.jpg/i.test(bg)) continue;
          const m = /url\((['"]?)([^)'"]+)\1\)/.exec(bg);
          if (m && m[2]) {
            url = new URL(m[2], document.baseURI).href;
            break;
          }
        }
      } catch {
        /* never break the host page */
      }
    }

    if (url) {
      this.host.style.setProperty('--bga-bg', `url("${url}")`);
    }
  }

  /** Serialize the rendered transcript into a markdown-friendly text block
   *  and copy it to the clipboard. Useful for pasting into a chat report
   *  ("here's what the advisor told me this game"). */
  private copyTranscript(): void {
    const transcriptEl = this.els['transcript'];
    if (!transcriptEl) return;
    const lines: string[] = [];
    // Walk the rendered DOM in order (mirrors what the user sees). Each .msg
    // contributes one block: header line + body (move) + indented why.
    const rows = transcriptEl.querySelectorAll<HTMLElement>('.msg');
    rows.forEach((row) => {
      const role = row.classList.contains('user') ? 'you' : 'Tilly';
      const kind = row.classList.contains('advice') ? 'advice'
        : row.classList.contains('reply') ? 'reply'
        : row.classList.contains('error') ? 'error'
        : row.classList.contains('superseded') ? 'superseded'
        : 'message';
      const ts = (row.querySelector('.ts')?.textContent || '').trim();
      const move = (row.querySelector('.bubble')?.textContent || '').trim();
      const whyEl = row.querySelector('.why-text');
      const whyText = (whyEl?.firstChild?.nodeType === Node.TEXT_NODE
        ? (whyEl.firstChild as Text).textContent ?? ''
        : ''
      ).trim();
      const meta = (whyEl?.querySelector('.why-meta')?.textContent || '').trim();
      const header = `[${ts}] ${role}${kind && kind !== 'message' ? ` (${kind})` : ''}:`;
      lines.push(header);
      if (move) lines.push(`  ${move}`);
      if (whyText) lines.push(`  Why: ${whyText}`);
      if (meta) lines.push(`  ${meta}`);
      lines.push('');
    });
    const text = lines.join('\n').trimEnd();
    const indicator = this.els['copy'] as HTMLElement | undefined;
    const orig = indicator?.textContent ?? 'Copy';
    const flashIndicator = (label: string) => {
      if (!indicator) return;
      indicator.textContent = label;
      window.setTimeout(() => {
        indicator.textContent = orig;
      }, 1400);
    };
    try {
      void navigator.clipboard.writeText(text).then(
        () => flashIndicator('Copied!'),
        () => flashIndicator('Copy failed'),
      );
    } catch {
      flashIndicator('Copy failed');
    }
  }

  /** Wire pointerdown on the resize handle, then track move/up on document
   *  so the drag continues even if the pointer leaves the handle's bounds. */
  private setupResize(): void {
    const handle = this.els['resize'];
    const chat = this.els['chat'];
    if (!handle || !chat) return;
    let startX = 0;
    let startW = 0;
    let dragging = false;
    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      // Chat is docked to the right edge; dragging the handle LEFT widens.
      const delta = startX - ev.clientX;
      this.setChatWidth(startW + delta, false);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      chat.classList.remove('resizing');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      // Persist only on release so we don't write to storage on every pixel.
      this.setChatWidth(this.chatWidth, true);
    };
    handle.addEventListener('pointerdown', (ev) => {
      const e = ev as PointerEvent;
      dragging = true;
      startX = e.clientX;
      startW = this.chatWidth;
      handle.classList.add('dragging');
      chat.classList.add('resizing');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      ev.preventDefault();
    });
  }

  mount(): void {
    if (this.host) return;
    this.host = document.createElement('div');
    this.host.id = 'agri-observatory-host';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.root.appendChild(style);

    const tab = document.createElement('div');
    tab.className = 'tab hidden';
    tab.textContent = '◀ Tilly';
    tab.onclick = () => this.setCollapsed(false);

    const chat = document.createElement('div');
    chat.className = 'chat';
    chat.innerHTML = `
      <div class="resize-handle" data-el="resize" title="Drag to resize"></div>
      <header>
        <span class="dot" data-el="dot"></span>
        <b>Tilly</b>
        <span class="ver-sub" title="your Agricola coach">for Agricola</span>
        <span class="ver" data-el="ver"></span>
        <span class="hbtn">
          <span data-el="copy" title="Copy chat to clipboard">Copy</span>
          <span data-el="ev-toggle" title="Events console">Events</span>
          <span data-el="collapse" title="Collapse">▶</span>
        </span>
      </header>
      <div class="scroll-wrap">
        <div class="transcript" data-el="transcript"></div>
        <div class="newpill hidden" data-el="newpill">New ↓</div>
      </div>
      <div class="thinking hidden" data-el="thinking">Tilly is thinking…</div>
      <div class="keybanner hidden" data-el="keybanner">
        <span>Tilly is off — set your OpenRouter key to get advice.</span>
        <button data-el="keybanner-btn">Set key</button>
      </div>
      <div class="input">
        <textarea data-el="chat-input" placeholder="Ask Tilly about this position…"></textarea>
        <button class="primary" data-el="chat-send">Send</button>
      </div>`;

    const events = document.createElement('div');
    events.className = 'events hidden';
    events.innerHTML = `
      <header><b>Events / telemetry</b>
        <span class="hbtn"><span data-el="ev-close" title="Close">✕</span></span>
      </header>
      <div class="evmeta">
        <div data-el="probe">probe: …</div>
        <div data-el="table"></div>
        <div class="reason" data-el="reason"></div>
      </div>
      <div class="stats">
        <span>events <b data-el="c-ev">0</b></span>
        <span>notif <b data-el="c-no">0</b></span>
        <span>snaps <b data-el="c-sn">0</b></span>
        <span>shots <b data-el="c-sh">0</b></span>
      </div>
      <div class="ctl">
        <button data-el="cap">Pause</button>
        <button data-el="shot">Screenshots: off</button>
        <button data-el="exp">Export JSON</button>
        <button data-el="clr">Clear</button>
      </div>
      <div class="feed" data-el="feed"></div>`;

    // Inject the SVG sprig definitions once. All bubbles reference these
    // via <use> — keeps the DOM tiny even with many bubbles.
    const defs = document.createElement('div');
    defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
    defs.innerHTML = SPRIG_DEFS_SVG;
    this.root.appendChild(defs);

    this.root.append(tab, events, chat);
    (document.documentElement || document.body).appendChild(this.host);
    this.dock();

    const q = (k: string) =>
      this.root!.querySelector<HTMLElement>(`[data-el="${k}"]`)!;
    for (const k of [
      'dot', 'ver', 'ev-toggle', 'collapse', 'transcript', 'thinking',
      'newpill', 'keybanner', 'keybanner-btn',
      'chat-input', 'chat-send', 'ev-close', 'probe', 'table', 'reason',
      'c-ev', 'c-no', 'c-sn', 'c-sh', 'cap', 'shot', 'exp', 'clr', 'feed',
      'resize', 'copy',
    ]) {
      this.els[k] = q(k);
    }
    this.els.tab = tab;
    this.els.chat = chat;

    (this.els['collapse'] as HTMLElement).onclick = () => this.setCollapsed(true);
    (this.els['ev-toggle'] as HTMLElement).onclick = () => this.toggleEvents();
    (this.els['ev-close'] as HTMLElement).onclick = () => this.toggleEvents();
    (this.els['keybanner-btn'] as HTMLElement).onclick = () =>
      this.handlers.onOpenOptions();
    (this.els['newpill'] as HTMLElement).onclick = () => this.scrollToBottom(true);

    // Resize: drag the left-edge handle to widen/narrow the chat panel.
    // Width is persisted to chrome.storage so it survives reloads.
    this.setupResize();
    void this.loadPersistedWidth();
    // Match the advisor's header height to BGA's own top bar so the chrome
    // lines up across resolutions / themes. Observes for layout changes.
    this.syncBgaHeaderHeight();
    // Steal BGA's grass background image (when available) for visual
    // continuity. Falls back to the CSS pattern in the stylesheet.
    this.syncAgricolaBackground();
    // Bug parade — emoji critters cameo across the transcript area at
    // random. Lives inside .scroll-wrap so the bugs roam over bubbles and
    // grass alike but never escape into the input or header.
    const scrollWrap =
      this.root!.querySelector<HTMLElement>('.scroll-wrap');
    if (scrollWrap) startBugParade(scrollWrap);
    // Copy-to-clipboard: serialize the transcript in a markdown-ish format
    // for easy pasting into chat / bug reports.
    (this.els['copy'] as HTMLElement).onclick = () => this.copyTranscript();

    // Track sticky-bottom: user's last scroll position tells us whether to
    // auto-scroll new content. Without this, streaming text would yank the
    // user back down even if they had scrolled up to read earlier advice.
    const t = this.els['transcript']!;
    t.addEventListener('scroll', () => {
      const distFromBottom = t.scrollHeight - t.scrollTop - t.clientHeight;
      this.stickyBottom = distFromBottom < STICK_THRESHOLD_PX;
      if (this.stickyBottom) {
        this.hasUnseenBelow = false;
        (this.els['newpill'] as HTMLElement).classList.add('hidden');
      }
    });

    const send = () => {
      const ta = this.els['chat-input'] as HTMLTextAreaElement;
      const text = ta.value.trim();
      if (!text || ta.disabled) return;
      ta.value = '';
      this.handlers.onSendChat(text);
    };
    (this.els['chat-send'] as HTMLButtonElement).onclick = send;
    (this.els['chat-input'] as HTMLTextAreaElement).addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      },
    );

    let cap = true;
    (this.els['cap'] as HTMLButtonElement).onclick = () => {
      cap = !cap;
      this.els['cap']!.textContent = cap ? 'Pause' : 'Resume';
      this.handlers.onToggleCapture(cap);
    };
    let sh = false;
    (this.els['shot'] as HTMLButtonElement).onclick = () => {
      sh = !sh;
      this.handlers.onToggleScreenshots(sh);
    };
    (this.els['exp'] as HTMLButtonElement).onclick = () => this.handlers.onExport();
    (this.els['clr'] as HTMLButtonElement).onclick = () => {
      if (confirm('Clear the captured session log for this table?')) {
        this.handlers.onClear();
      }
    };
  }

  private toggleEvents(): void {
    this.eventsOpen = !this.eventsOpen;
    this.root!.querySelector('.events')!.classList.toggle(
      'hidden',
      !this.eventsOpen,
    );
    (this.els['ev-toggle'] as HTMLElement).classList.toggle('on', this.eventsOpen);
    this.dock();
  }

  private setCollapsed(c: boolean): void {
    this.collapsed = c;
    this.root!.querySelector('.chat')!.classList.toggle('hidden', c);
    this.root!.querySelector('.events')!.classList.toggle(
      'hidden',
      c || !this.eventsOpen,
    );
    this.els.tab!.classList.toggle('hidden', !c);
    this.dock();
  }

  private scrollToBottom(force: boolean): void {
    const t = this.els['transcript']!;
    if (force || this.stickyBottom) {
      t.scrollTop = t.scrollHeight;
      this.stickyBottom = true;
      this.hasUnseenBelow = false;
      (this.els['newpill'] as HTMLElement).classList.add('hidden');
    }
  }

  /** Should this kind of message split into a short MOVE + collapsed WHY?
   *  Only the advisor's own structured outputs (advice / reply); user msgs
   *  and errors render the whole content as-is. */
  private static splitsAdvice(kind?: string): boolean {
    return kind === 'advice' || kind === 'reply' || kind === 'superseded';
  }

  /** Build the DOM record for one transcript message. Bubble on top, the
   *  rationale (hidden) below, then a minimal footer with just a timestamp.
   *  The bubble itself is the click target to expand the WHY — no extra
   *  link in the footer. Diagnostic stamp nests INSIDE the rationale block
   *  so it's available when expanded and out of the way when collapsed. */
  private buildRow(m: TranscriptMsg): RowDom {
    const row = document.createElement('div');
    row.className = `msg ${m.role}${m.kind ? ' ' + m.kind : ''}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const whyEl = document.createElement('div');
    whyEl.className = 'why-text';

    // Streaming: typing dots. Otherwise: split move/why for advice/reply.
    if (m.streaming) {
      bubble.appendChild(buildTypingIndicator());
    } else if (Sidebar.splitsAdvice(m.kind)) {
      const { move, why } = splitAdvice(m.content);
      bubble.textContent = move;
      whyEl.textContent = why;
    } else {
      bubble.textContent = m.content;
    }
    row.append(bubble, whyEl);

    // Garden whimsy: 1-3 sprigs picked from the four bubble corners, with
    // per-message hash-based placement, variant, rotation, sway, scale, and
    // duration variance — so every bubble has a slightly different leafy
    // personality. Re-renders stay stable because every choice is keyed
    // off the message content + ts. z-index: -1 in CSS keeps each sprig
    // behind the bubble face so text stays unobstructed.
    for (const slot of pickSprigSlots(m)) {
      row.appendChild(buildSprig(m, slot));
    }

    // Minimal footer — timestamp only (left for advisor messages, right for
    // user messages via flex-direction in CSS).
    const footer = document.createElement('div');
    footer.className = 'footer';
    const tsEl = document.createElement('span');
    tsEl.className = 'ts';
    tsEl.textContent = formatBubbleTime(m.ts);
    footer.append(tsEl);
    row.append(footer);

    const rec: RowDom = {
      row,
      bubble,
      footer,
      tsEl,
      whyEl,
      lastKind: m.kind,
      lastContent: m.content,
      lastStreaming: m.streaming,
    };

    // Diagnostic stamp lives INSIDE the why-text block (only visible on expand).
    if (m.meta) {
      rec.metaEl = document.createElement('span');
      rec.metaEl.className = 'why-meta';
      rec.metaEl.textContent = m.meta;
      whyEl.appendChild(rec.metaEl);
      rec.lastMeta = m.meta;
    }

    // Mark the bubble as expandable iff there's rationale, and wire the row
    // click to toggle the expanded state. (Click on the row not just the
    // bubble so the click target is generous.)
    this.syncWhyVisibility(rec);
    row.addEventListener('click', () => {
      if (!rec.bubble.classList.contains('has-why')) return;
      row.classList.toggle('expanded');
    });
    return rec;
  }

  /** Mark/unmark the bubble's `has-why` flag based on whether the rationale
   *  has any non-empty text. Drives both the click affordance and the
   *  chevron indicator (via CSS). */
  private syncWhyVisibility(rec: RowDom): void {
    if (!rec.whyEl) return;
    // The why text content is everything in whyEl EXCEPT the .why-meta child
    // (which is the stamp, not actual rationale). Inspect the first text
    // node to see if there's a real WHY block.
    const whyText = (rec.whyEl.firstChild && rec.whyEl.firstChild.nodeType === Node.TEXT_NODE
      ? (rec.whyEl.firstChild as Text).textContent ?? ''
      : ''
    ).trim();
    rec.bubble.classList.toggle('has-why', whyText.length > 0);
  }

  /** Incremental diff render of the transcript. Critical for streaming perf:
   *  appending tokens mutates one Text node, not the whole list. */
  private renderTranscript(transcript: TranscriptMsg[], advisorDisabled: boolean): void {
    const t = this.els['transcript']!;

    if (transcript.length === 0) {
      // Empty-state full replace is cheap and rare.
      this.renderedOrder = [];
      t.textContent = '';
      const e = document.createElement('div');
      e.className = 'empty';
      if (advisorDisabled) {
        e.textContent = 'Tilly is off — add your OpenRouter key to wake her up.';
        const b = document.createElement('button');
        b.className = 'primary setkey';
        b.textContent = 'Set OpenRouter key';
        b.onclick = () => this.handlers.onOpenOptions();
        e.appendChild(document.createElement('br'));
        e.appendChild(b);
      } else {
        e.textContent = 'Waiting for your turn…';
      }
      t.appendChild(e);
      return;
    }

    // If switching out of empty-state, clear the placeholder.
    if (this.renderedOrder.length === 0) t.textContent = '';

    // 1) Reconcile by message identity. The expected steady state is
    //    "transcript grew by one bubble and one existing bubble's content
    //    changed" — both fast paths.
    const seen = new Set<TranscriptMsg>();
    for (let i = 0; i < transcript.length; i++) {
      const m = transcript[i]!;
      seen.add(m);
      let rec = this.rowMap.get(m);
      if (!rec) {
        rec = this.buildRow(m);
        this.rowMap.set(m, rec);
      } else {
        // Bubble exists — mutate only what changed. textContent assignment
        // is essentially free if the string is identical, but skip anyway
        // to avoid extra invalidations from white-space/scroll-anchoring.
        // Streaming-aware content update:
        //  - While streaming → bubble shows the typing indicator; don't
        //    spend cycles updating textContent (saves a re-flow per chunk).
        //  - On stream completion (streaming flips false) → swap dots
        //    for the parsed move; populate the whyEl from any WHY: section.
        //  - Edits to non-streaming messages → normal text update.
        const streamingChanged = rec.lastStreaming !== m.streaming;
        const contentChanged = rec.lastContent !== m.content;
        if (m.streaming) {
          if (streamingChanged) {
            rec.bubble.textContent = '';
            rec.bubble.appendChild(buildTypingIndicator());
          }
        } else if (contentChanged || streamingChanged) {
          if (Sidebar.splitsAdvice(m.kind)) {
            const { move, why } = splitAdvice(m.content);
            rec.bubble.textContent = move;
            // Carefully update the why text WITHOUT removing the metaEl
            // child (which lives inside whyEl as a sibling text node + span).
            if (rec.whyEl) {
              const first = rec.whyEl.firstChild;
              if (first && first.nodeType === Node.TEXT_NODE) {
                (first as Text).textContent = why;
              } else {
                rec.whyEl.insertBefore(
                  document.createTextNode(why),
                  rec.metaEl ?? null,
                );
              }
            }
            this.syncWhyVisibility(rec);
          } else {
            rec.bubble.textContent = m.content;
          }
        }
        rec.lastContent = m.content;
        rec.lastStreaming = m.streaming;
        if (rec.lastKind !== m.kind) {
          // Preserve user's expanded-state when kind transitions
          // (e.g. advice → superseded): rebuild the row class but keep the
          // `.expanded` flag if it was set by the user.
          const wasExpanded = rec.row.classList.contains('expanded');
          rec.row.className = `msg ${m.role}${m.kind ? ' ' + m.kind : ''}`;
          if (wasExpanded) rec.row.classList.add('expanded');
          rec.lastKind = m.kind;
        }
        if (rec.lastMeta !== m.meta) {
          if (m.meta) {
            if (!rec.metaEl) {
              rec.metaEl = document.createElement('span');
              rec.metaEl.className = 'why-meta';
              // Append to whyEl so it shows only when the bubble is expanded.
              rec.whyEl?.appendChild(rec.metaEl);
            }
            rec.metaEl.textContent = m.meta;
          } else if (rec.metaEl) {
            rec.metaEl.remove();
            rec.metaEl = undefined;
          }
          rec.lastMeta = m.meta;
        }
      }
    }

    // 2) Drop rows whose messages are no longer present (rare — only when
    //    transcript shrinks, e.g. cancelled-empty advice purge).
    for (const prev of this.renderedOrder) {
      if (!seen.has(prev)) {
        const rec = this.rowMap.get(prev);
        if (rec?.row.parentNode) rec.row.remove();
        this.rowMap.delete(prev);
      }
    }

    // 3) Ensure DOM order matches transcript order. This is also cheap when
    //    only appends happened — appendChild on an existing node moves it.
    let cursor: Node | null = t.firstChild;
    for (const m of transcript) {
      const rec = this.rowMap.get(m)!;
      if (cursor !== rec.row) {
        t.insertBefore(rec.row, cursor);
      } else {
        cursor = rec.row.nextSibling;
      }
    }

    this.renderedOrder = transcript.slice();
  }

  private renderPhase(phase: AdvisorPhase): void {
    const el = this.els['thinking']!;
    // Phase → label table. Idle / done / error don't show an indicator at all
    // (terminal states leave the bubble itself as the visible result).
    let label = '';
    let cls = '';
    if (phase === 'reading') {
      label = 'reading position…';
      cls = 'reading';
    } else if (phase === 'thinking') {
      label = 'Tilly is thinking…';
      cls = '';
    } else if (phase === 'streaming') {
      label = 'streaming…';
      cls = 'streaming';
    }
    el.textContent = label;
    el.className = `thinking${cls ? ' ' + cls : ''}${label ? '' : ' hidden'}`;
  }

  render(s: SidebarState): void {
    if (!this.host) return;
    this.els['ver']!.textContent = `v${s.version}`;
    this.els['dot']!.className = `dot ${s.health ?? ''}`;
    this.els['dot']!.title = s.healthReason;

    // Snapshot the bottom-stick decision BEFORE we mutate the DOM. After we
    // append/update rows, scrollHeight changes and the old measurement is
    // misleading. The user may have just scrolled up while a stream is going.
    const wasSticky = this.stickyBottom;
    const beforeLen = this.renderedOrder.length;

    this.renderTranscript(s.transcript, s.advisorDisabled);

    if (wasSticky) {
      this.scrollToBottom(true);
    } else if (s.transcript.length > beforeLen) {
      // Content arrived while user is scrolled up — surface the pill.
      this.hasUnseenBelow = true;
      (this.els['newpill'] as HTMLElement).classList.remove('hidden');
    }

    this.renderPhase(s.advisorPhase);

    // Persistent "Set key" banner above the input when the advisor is off
    // AND the transcript has any history. (Empty-state already shows the
    // CTA inline, so no need to double up.)
    const showBanner = s.advisorDisabled && s.transcript.length > 0;
    (this.els['keybanner'] as HTMLElement).classList.toggle('hidden', !showBanner);

    const ta = this.els['chat-input'] as HTMLTextAreaElement;
    // Three reasons to disable the input, with distinct placeholders so the
    // user can tell why typing isn't working.
    const probeOk = s.probeAttached;
    const inputEnabled = s.chatEnabled && probeOk;
    ta.disabled = !inputEnabled;
    if (!s.chatEnabled) {
      ta.placeholder = 'Set your OpenRouter key in options to chat';
    } else if (!probeOk) {
      ta.placeholder = 'Reconnecting to game…';
    } else {
      ta.placeholder = 'Ask Tilly about this position…';
    }
    (this.els['chat-send'] as HTMLButtonElement).disabled = !inputEnabled;

    // Events console
    this.els['probe']!.textContent = `probe: ${s.probeAttached ? 'attached' : 'NOT attached'}`;
    this.els['table']!.textContent = s.tableId
      ? `table ${s.tableId}${s.players.length ? ' · ' + s.players.join(', ') : ''}`
      : 'waiting for an Agricola table…';
    this.els['reason']!.textContent = s.healthReason;
    this.els['c-ev']!.textContent = String(s.counts.events);
    this.els['c-no']!.textContent = String(s.counts.notifications);
    this.els['c-sn']!.textContent = String(s.counts.snapshots);
    this.els['c-sh']!.textContent = String(s.counts.screenshots);
    this.els['cap']!.textContent = s.capturing ? 'Pause' : 'Resume';
    this.els['shot']!.textContent = `Screenshots: ${s.screenshots ? 'on' : 'off'}`;
    this.els['shot']!.classList.toggle('on', s.screenshots);

    // The events feed is bounded and short — a full rebuild here is cheap
    // and not on the streaming hot path, so we keep it simple.
    const feed = this.els['feed']!;
    feed.textContent = '';
    const ff = document.createDocumentFragment();
    for (const row of s.feed) {
      const div = document.createElement('div');
      div.className = `row${row.myTurn ? ' turn' : ''}`;
      const tm = document.createElement('span');
      tm.className = 'tm';
      tm.textContent = row.t;
      const kd = document.createElement('span');
      kd.className = 'kd';
      kd.textContent = row.kind;
      const sm = document.createElement('span');
      sm.className = 'sm';
      sm.textContent = row.summary;
      div.append(tm, kd, sm);
      ff.appendChild(div);
    }
    feed.appendChild(ff);
    feed.scrollTop = feed.scrollHeight;
  }
}
