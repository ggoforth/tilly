// Advisor configuration (user-supplied). Absent key => advisor disabled (never
// throws). The key lives only in chrome.storage.local and is read only by the
// service worker; it is never posted to the page or written to the log.

export const KEY_STORE = 'openrouterKey';
export const MODEL_STORE = 'openrouterModel';
export const DEFAULT_MODEL = 'google/gemini-2.5-flash';

export interface AdvisorConfig {
  key: string;
  model: string;
}

export async function getAdvisorConfig(): Promise<AdvisorConfig | null> {
  try {
    const got = await chrome.storage.local.get([KEY_STORE, MODEL_STORE]);
    const key = typeof got[KEY_STORE] === 'string' ? got[KEY_STORE].trim() : '';
    if (!key) return null;
    const model =
      typeof got[MODEL_STORE] === 'string' && got[MODEL_STORE].trim()
        ? got[MODEL_STORE].trim()
        : DEFAULT_MODEL;
    return { key, model };
  } catch {
    return null;
  }
}
