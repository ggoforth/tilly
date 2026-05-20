// Small pure helpers for building the session log.

import { SCHEMA_VERSION, type SessionLog, type TableMeta } from './types';

let counter = 0;

/** Monotonic, collision-resistant event id (ordering aid + uniqueness). */
export function newId(prefix = 'e'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newSessionLog(
  table: TableMeta,
  extensionVersion: string,
): SessionLog {
  return {
    schemaVersion: SCHEMA_VERSION,
    capturedBy: {
      extensionVersion,
      userAgent: navigator.userAgent,
    },
    table,
    events: [],
    healthTransitions: [],
    screenshots: [],
  };
}
