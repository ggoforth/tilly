// Options page logic. Loads/saves the user's OpenRouter key + model to
// chrome.storage.local. The key is only ever entered here, by the user.
// Never fails silently: every outcome (loaded, saved, error) is shown.

import { KEY_STORE, MODEL_STORE, DEFAULT_MODEL } from '../advisor/config';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

function setStatus(msg: string, ok: boolean): void {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = msg;
    el.style.color = ok ? '#5fdc8a' : '#ff7676';
  }
}

async function load(): Promise<void> {
  try {
    const got = await chrome.storage.local.get([KEY_STORE, MODEL_STORE]);
    if (typeof got[KEY_STORE] === 'string') $('key').value = got[KEY_STORE];
    $('model').value =
      typeof got[MODEL_STORE] === 'string' && got[MODEL_STORE]
        ? got[MODEL_STORE]
        : DEFAULT_MODEL;
  } catch (err) {
    console.error('[agri-options] load failed', err);
    setStatus(`Could not read saved settings: ${String(err)}`, false);
  }
}

async function save(): Promise<void> {
  try {
    const key = $('key').value.trim();
    const model = $('model').value.trim() || DEFAULT_MODEL;
    await chrome.storage.local.set({ [KEY_STORE]: key, [MODEL_STORE]: model });
    setStatus(
      key
        ? 'Saved ✓ — reload your BGA game tab to activate the advisor'
        : 'Saved — no key entered, advisor stays disabled',
      true,
    );
    console.log('[agri-options] saved', { hasKey: !!key, model });
  } catch (err) {
    console.error('[agri-options] save failed', err);
    setStatus(`Save failed: ${String(err)}`, false);
  }
}

const btn = document.getElementById('save');
if (btn) {
  btn.addEventListener('click', () => void save());
  console.log('[agri-options] ready');
} else {
  // Should be impossible (static HTML), but never fail silently.
  setStatus('Options page failed to initialize (no Save button found).', false);
}

void load();
