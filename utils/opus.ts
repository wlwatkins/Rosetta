import { browser } from 'wxt/browser';
import type { OpusStatus } from './opus-types';

/**
 * Background-side handle on the offline OPUS-MT engine.
 *
 * The model can't run here: an MV3 service worker has no DOM, so neither the
 * WASM backend nor WebGPU is available, and the worker is killed on idle —
 * reloading 600 MB of weights every time would be unusable. Instead the
 * pipeline lives in an offscreen document (`entrypoints/offscreen/`) that stays
 * alive for as long as the extension needs it, and this module talks to it.
 */

const TARGET = 'opus-offscreen';
const OFFSCREEN_URL = 'offscreen.html';
const FRAME_ID = 'rosetta-opus-host';

export const OPUS_UNAVAILABLE =
  'This browser has nowhere to run the offline engine — it needs either the offscreen API or a background page with a DOM.';

export function opusAvailable(): boolean {
  // Chromium: a real offscreen document. Firefox: no offscreen API, but its
  // MV3 background is an event *page* with a DOM, so the same document can be
  // hosted in a hidden iframe there.
  return !!browser.offscreen?.createDocument || typeof document !== 'undefined';
}

let creating: Promise<void> | null = null;

/** Firefox path: the offscreen document as a hidden iframe in the background page. */
async function ensureFrame(): Promise<void> {
  if (document.getElementById(FRAME_ID)) return;
  const frame = document.createElement('iframe');
  frame.id = FRAME_ID;
  frame.style.display = 'none';
  frame.src = browser.runtime.getURL('/offscreen.html');
  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.addEventListener('error', () => reject(new Error('Could not start the offline engine.')), {
      once: true,
    });
  });
  (document.body ?? document.documentElement).appendChild(frame);
  await loaded;
}

async function ensureOffscreen(): Promise<void> {
  if (!opusAvailable()) throw new Error(OPUS_UNAVAILABLE);
  if (!browser.offscreen?.createDocument) return ensureFrame();
  // Cheap enough to check every time, and an offscreen document can be torn
  // down without telling us — failing a batch because it went away would be
  // much worse than one extra call. hasDocument() is missing on older
  // Chromium, where the create call below is the check.
  if (browser.offscreen.hasDocument && (await browser.offscreen.hasDocument())) return;

  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'Runs the offline OPUS-MT translation model.',
    })
    .catch((err: unknown) => {
      // Two batches can race here, and the loser is told a document already
      // exists — which is exactly the state it wanted.
      const message = err instanceof Error ? err.message : String(err);
      if (!/single offscreen document/i.test(message)) throw err;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

async function call<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  await ensureOffscreen();
  const res: any = await browser.runtime.sendMessage({ target: TARGET, type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? 'The offline engine did not respond.');
  return res.value as T;
}

export function opusStatus(): Promise<OpusStatus> {
  return call<OpusStatus>('opus-status');
}

export function opusLoad(): Promise<OpusStatus> {
  return call<OpusStatus>('opus-load');
}

export function opusTranslate(texts: string[]): Promise<string[]> {
  return call<string[]>('opus-translate', { texts });
}

export function opusRemove(): Promise<void> {
  return call<void>('opus-remove');
}

/**
 * Interrupt generation. Unlike the Google path there is no request to abort —
 * the model is mid-forward-pass — so this asks the offscreen document to stop
 * between sequences and doesn't wait for it.
 */
export function opusCancel(): void {
  if (!opusAvailable()) return;
  void browser.runtime.sendMessage({ target: TARGET, type: 'opus-cancel' }).catch(() => {});
}
