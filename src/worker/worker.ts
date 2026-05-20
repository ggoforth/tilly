// Service worker:
//  1. Registers the MAIN-world probe (so it can read page globals despite the
//     page CSP — manifest world:"MAIN" has known bugs, the scripting API does not).
//  2. Captures the visible tab on request from the content script (screenshots).
//  3. Hosts the advisor port: streams OpenRouter completions (key stays here).

import type { WorkerRequest, WorkerResponse } from '../shared/messaging';
import { registerAdvisorPort } from '../advisor/openrouter';

registerAdvisorPort();

const PROBE_ID = 'agri-observatory-probe';

// Only Agricola game pages. BGA game URLs reliably contain "/agricola".
const AGRICOLA_MATCHES = ['*://*.boardgamearena.com/*agricola*'];

async function registerProbe(): Promise<void> {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [PROBE_ID],
    });
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [PROBE_ID] });
    }
    await chrome.scripting.registerContentScripts([
      {
        id: PROBE_ID,
        js: ['probe.js'],
        matches: AGRICOLA_MATCHES,
        world: 'MAIN',
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
    console.log('[agri-observatory] MAIN-world probe registered');
  } catch (err) {
    console.error('[agri-observatory] probe registration failed', err);
  }
}

// registerContentScripts only injects into pages loaded AFTER registration.
// So on install/reload, also actively inject the MAIN-world probe into any
// already-open BGA tabs — no tab reload required. The probe self-guards
// against double injection (window.__AGRI_OBS_PROBE__) and self-gates to
// Agricola, so re-injecting is safe.
async function injectIntoOpenTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({
      url: '*://*.boardgamearena.com/*',
    });
    for (const t of tabs) {
      if (t.id == null) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          world: 'MAIN',
          files: ['probe.js'],
        });
        console.log('[agri-observatory] probe injected into open tab', t.id);
      } catch (e) {
        console.warn('[agri-observatory] inject failed for tab', t.id, e);
      }
    }
  } catch (err) {
    console.error('[agri-observatory] injectIntoOpenTabs failed', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void registerProbe();
  void injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(() => {
  void registerProbe();
  void injectIntoOpenTabs();
});

chrome.runtime.onMessage.addListener(
  (req: WorkerRequest, sender, sendResponse: (r: WorkerResponse) => void) => {
    if (req?.type === 'capture-visible-tab') {
      const windowId = sender.tab?.windowId;
      const done = (r: WorkerResponse) => sendResponse(r);
      try {
        const cb = (dataUrl?: string) => {
          if (chrome.runtime.lastError || !dataUrl) {
            done({
              ok: false,
              error: chrome.runtime.lastError?.message ?? 'no dataUrl',
            });
          } else {
            done({ ok: true, dataUrl });
          }
        };
        if (typeof windowId === 'number') {
          chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 }, cb);
        } else {
          chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 }, cb);
        }
      } catch (err) {
        done({ ok: false, error: String(err) });
      }
      return true; // async sendResponse
    }
    return false;
  },
);
