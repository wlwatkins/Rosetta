import { browser } from 'wxt/browser';
import * as opus from '@/utils/opus-runtime';
import type { OpusStatus } from '@/utils/opus-types';

// Host for the offline OPUS-MT model. Created on demand by utils/opus.ts and
// addressed with `target: 'opus-offscreen'` so the background's own message
// router ignores these.

const TARGET = 'opus-offscreen';

function relayProgress(status: OpusStatus) {
  // The popup listens for this to drive the download bar; nobody may be
  // listening, which is not an error.
  browser.runtime.sendMessage({ type: 'opus-progress', status }).catch(() => {});
}

browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message?.target !== TARGET) return;

  const respond = (work: Promise<unknown>) => {
    work.then(
      (value) => sendResponse({ ok: true, value }),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  };

  switch (message.type) {
    case 'opus-status':
      sendResponse({ ok: true, value: opus.status() });
      return;
    case 'opus-load':
      return respond(opus.load(relayProgress).then(() => opus.status()));
    case 'opus-translate':
      return respond(opus.translate(message.texts ?? []));
    case 'opus-remove':
      return respond(opus.remove().then(() => undefined));
    case 'opus-cancel':
      opus.cancel();
      sendResponse({ ok: true, value: undefined });
      return;
  }
});
