// In-memory session log with debounced persistence and reload recovery.

import { newSessionLog, nowIso } from '../shared/log';
import type {
  GameEvent,
  Health,
  SessionLog,
  StoredScreenshot,
  TableMeta,
} from '../shared/types';
import type { StorageBackend } from './storage';

type Listener = (log: SessionLog) => void;

export class SessionBuffer {
  private log: SessionLog | null = null;
  private flushTimer: number | undefined;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly storage: StorageBackend,
    private readonly extensionVersion: string,
  ) {}

  get current(): SessionLog | null {
    return this.log;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.log) fn(this.log);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    if (this.log) for (const fn of this.listeners) fn(this.log);
  }

  /** Start (or resume) a session for a table, recovering any persisted log. */
  async startSession(table: TableMeta): Promise<void> {
    const existing = await this.storage.load(table.tableId);
    if (existing && existing.table.tableId === table.tableId) {
      this.log = existing;
      // Refresh metadata in case players/variant resolved later.
      this.log.table = { ...existing.table, ...table };
    } else {
      this.log = newSessionLog(table, this.extensionVersion);
    }
    this.scheduleFlush(true);
    this.notify();
  }

  append(event: GameEvent): void {
    if (!this.log) return;
    this.log.events.push(event);
    this.scheduleFlush();
    this.notify();
  }

  recordHealth(status: Health, reason: string): void {
    if (!this.log) return;
    this.log.healthTransitions.push({ t: nowIso(), status, reason });
    this.scheduleFlush();
  }

  addScreenshot(shot: StoredScreenshot): void {
    if (!this.log) return;
    this.log.screenshots.push(shot);
    this.scheduleFlush();
  }

  setFinal(final: SessionLog['final']): void {
    if (!this.log) return;
    this.log.final = final;
    this.scheduleFlush(true);
  }

  private scheduleFlush(immediate = false): void {
    if (immediate) {
      void this.flush();
      return;
    }
    if (this.flushTimer != null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, 3000);
  }

  async flush(): Promise<void> {
    if (this.log) await this.storage.save(this.log);
  }

  exportJson(): void {
    if (!this.log) return;
    const blob = new Blob([JSON.stringify(this.log, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agricola-observatory_${this.log.table.tableId}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async clear(): Promise<void> {
    if (!this.log) return;
    const { table } = this.log;
    await this.storage.clear(table.tableId);
    this.log = newSessionLog(table, this.extensionVersion);
    this.notify();
  }
}
