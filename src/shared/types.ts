// The captured/exported telemetry schema. This is the contract a future
// advisor change is built from — keep it concrete and bump SCHEMA_VERSION
// on any shape change.

// v2: schemaVersion 2 adds the additive `recommendation` event (advisor).
export const SCHEMA_VERSION = 2;

export type Health = 'healthy' | 'degraded' | 'unhealthy';

/** How a snapshot was obtained. */
export type SnapshotSource = 'initial' | 'notification' | 'timer' | 'dom';

/** Which notification mechanism delivered an event. */
export type NotifChannel = 'dojo' | 'bga';

export interface PlayerInfo {
  id: string;
  name: string;
  color?: string;
  order?: number;
}

export interface TableMeta {
  tableId: string;
  gameName: string; // expected "agricola"
  me: string; // local player id
  players: PlayerInfo[];
  variant?: string; // family/normal, decks, if detectable
  startedAt: string; // ISO
}

export interface SnapshotEvent {
  kind: 'snapshot';
  id: string;
  t: string; // client capture time (ISO)
  serverT?: string;
  source: SnapshotSource;
  gamestateId?: string | number;
  activePlayerId?: string;
  gamedatas: unknown; // safe deep clone of gameui.gamedatas
}

export interface NotificationEvent {
  kind: 'notification';
  id: string;
  t: string;
  serverT?: string;
  name: string;
  channel: NotifChannel;
  args: unknown;
  gamestateId?: string | number;
  activePlayerId?: string;
  linkedSnapshotId: string; // pairs to a SnapshotEvent
}

export interface GamestateEvent {
  kind: 'gamestate';
  id: string;
  t: string;
  from?: string | number;
  to: string | number;
  name?: string;
  description?: string;
  activePlayerId?: string;
  isMyTurn: boolean;
  possibleActions?: unknown;
  args?: unknown;
}

export interface HealthEvent {
  kind: 'health';
  id: string;
  t: string;
  status: Health;
  reason: string;
}

export interface ScreenshotRefEvent {
  kind: 'screenshot-ref';
  id: string;
  t: string;
  screenshotId: string;
  reason: 'my-turn' | 'round' | 'harvest' | 'game-end';
}

/**
 * Advisor recommendation (v2). Additive — existing event kinds are unchanged.
 * `actualActionEventId` is linked once the move actually taken is observed,
 * making the log a recommended-vs-actual record for empirical evaluation.
 */
export interface RecommendationEvent {
  kind: 'recommendation';
  id: string;
  t: string;
  gamestateId?: string | number;
  model: string;
  legalActions: string[];
  recommendedMove: string;
  rationale: string;
  actualActionEventId?: string;
}

export type GameEvent =
  | SnapshotEvent
  | NotificationEvent
  | GamestateEvent
  | HealthEvent
  | ScreenshotRefEvent
  | RecommendationEvent;

export interface StoredScreenshot {
  id: string;
  eventId: string;
  takenAt: string;
  dataUrl: string;
}

export interface SessionLog {
  schemaVersion: number;
  capturedBy: { extensionVersion: string; userAgent: string };
  table: TableMeta;
  events: GameEvent[];
  healthTransitions: { t: string; status: Health; reason: string }[];
  screenshots: StoredScreenshot[];
  final?: { scores?: unknown; raw?: unknown };
}
