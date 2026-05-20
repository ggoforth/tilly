// Persistence behind a small interface so the backing store can be swapped
// (e.g. to IndexedDB) later without touching the capture pipeline.

import type { SessionLog } from '../shared/types';

export interface StorageBackend {
  load(tableId: string): Promise<SessionLog | null>;
  save(log: SessionLog): Promise<void>;
  clear(tableId: string): Promise<void>;
}

const key = (tableId: string) => `session:${tableId}`;

export const chromeLocalStorage: StorageBackend = {
  async load(tableId) {
    try {
      const k = key(tableId);
      const got = await chrome.storage.local.get(k);
      return (got[k] as SessionLog | undefined) ?? null;
    } catch (err) {
      console.warn('[agri-observatory] storage load failed', err);
      return null;
    }
  },
  async save(log) {
    try {
      await chrome.storage.local.set({ [key(log.table.tableId)]: log });
    } catch (err) {
      console.warn('[agri-observatory] storage save failed', err);
    }
  },
  async clear(tableId) {
    try {
      await chrome.storage.local.remove(key(tableId));
    } catch (err) {
      console.warn('[agri-observatory] storage clear failed', err);
    }
  },
};
