import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { buildCachePrefix, clearCache, countCached } from '@/utils/cache';
import { cancelActive, translateBatch } from '@/utils/providers';
import { opusAvailable, opusLoad, opusRemove, opusStatus, OPUS_UNAVAILABLE } from '@/utils/opus';
import { loadSettings } from '@/utils/settings';

// Per-tab auto-translate flags. storage.session survives service-worker
// restarts and navigations, and is wiped when the browser closes.
const AUTO_KEY = 'autoTabs';

async function getAutoTabs(): Promise<Record<string, boolean>> {
  const res = await browser.storage.session.get(AUTO_KEY);
  return (res[AUTO_KEY] as Record<string, boolean>) ?? {};
}

async function setAutoTab(tabId: number, enabled: boolean): Promise<void> {
  const tabs = await getAutoTabs();
  if (enabled) tabs[tabId] = true;
  else delete tabs[tabId];
  await browser.storage.session.set({ [AUTO_KEY]: tabs });
}

// Per-tab active translation session, keyed by tab id -> target language.
// A frame that loads *after* the session began — the iframe behind a modal, a
// lazily mounted widget — never sees the one-off 'translate' broadcast, so it
// asks whether its tab is mid-session and joins.
const SESSION_KEY = 'sessionTabs';

// These are read-modify-write; serialise them so two frames reporting at the
// same moment can't clobber each other.
let writes: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn, fn);
  writes = next.catch(() => {});
  return next;
}

// The page is recorded alongside the language: a frame may reach us after the
// tab has moved on, and it must not join a session that died with the old page.
interface SessionRecord {
  lang: string;
  engine: string;
  page: string;
}

async function getSessionTabs(): Promise<Record<string, SessionRecord>> {
  const res = await browser.storage.session.get(SESSION_KEY);
  return (res[SESSION_KEY] as Record<string, SessionRecord>) ?? {};
}

function setSessionTab(tabId: number, record: SessionRecord | null): Promise<void> {
  return serialise(async () => {
    const tabs = await getSessionTabs();
    if (record) tabs[tabId] = record;
    else delete tabs[tabId];
    await browser.storage.session.set({ [SESSION_KEY]: tabs });
  });
}

// Identifies the tab's top-level document. The hash is dropped because SPA
// routing changes it constantly without replacing the page.
function pageKey(url: string | undefined): string {
  return (url ?? '').split('#')[0]!;
}

// Toolbar badge per tab: … translating, ✓ done, ! error, empty when idle.
const BADGE_BY_TYPE: Record<string, string> = {
  progress: '…',
  complete: '✓',
  'translate-error': '!',
  restored: '',
};

export default defineBackground(() => {
  void browser.action.setBadgeBackgroundColor({ color: '#3b6ff5' });

  browser.tabs.onRemoved.addListener((tabId) => {
    void setAutoTab(tabId, false);
    void setSessionTab(tabId, null);
  });
  // Navigation wipes the page — clear a stale badge.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      void browser.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    }
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const senderTabId = sender.tab?.id;
    if (senderTabId != null && typeof message?.type === 'string') {
      const badge =
        message.type === 'cancelled'
          ? message.done > 0
            ? '✓'
            : ''
          : BADGE_BY_TYPE[message.type];
      if (badge !== undefined) {
        void browser.action.setBadgeText({ tabId: senderTabId, text: badge }).catch(() => {});
      }
    }

    // A frame started or stopped translating. Recording it per tab is what
    // lets frames created later in the same tab pick the session up.
    if (message?.type === 'session-started') {
      if (senderTabId != null) {
        void setSessionTab(senderTabId, {
          lang: message.targetLang,
          engine: message.engine ?? 'google',
          page: pageKey(sender.tab?.url),
        });
      }
      sendResponse({ ok: true });
      return;
    }
    // 'page-loaded' is a fresh top-level document: whatever session the tab
    // had belonged to the page that just went away.
    if (message?.type === 'session-ended' || message?.type === 'page-loaded') {
      if (senderTabId != null) void setSessionTab(senderTabId, null);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'frame-session-check') {
      if (senderTabId == null) {
        sendResponse({ targetLang: null });
        return;
      }
      const here = pageKey(sender.tab?.url);
      getSessionTabs().then((tabs) => {
        const rec = tabs[senderTabId];
        // Guards the gap between a new page's frames loading and its top frame
        // getting far enough to report itself.
        const live = rec?.page === here ? rec : null;
        sendResponse({ targetLang: live?.lang ?? null, engine: live?.engine ?? 'google' });
      });
      return true;
    }

    // A frame decided the page should be auto-translated; every frame in the
    // tab needs to act, not just that one.
    if (message?.type === 'broadcast-translate') {
      if (senderTabId != null) {
        void browser.tabs
          .sendMessage(senderTabId, {
            type: 'translate',
            targetLang: message.targetLang,
            engine: message.engine,
          })
          .catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'set-auto-tab') {
      setAutoTab(message.tabId, message.enabled).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message?.type === 'get-auto-tab') {
      getAutoTabs().then((tabs) => sendResponse({ enabled: !!tabs[message.tabId] }));
      return true;
    }
    if (message?.type === 'auto-translate-check') {
      const tabId = sender.tab?.id;
      (async () => {
        const settings = await loadSettings();
        const tabs = await getAutoTabs();
        return {
          // This tab was explicitly flagged in the popup.
          auto: tabId != null && !!tabs[tabId],
          // Global rule: translate any page detected as this language.
          autoSourceLang: settings.autoSourceLang,
          targetLang: settings.targetLang,
          engine: settings.engine,
        };
      })().then(sendResponse);
      return true;
    }
    if (message?.type === 'count-cache') {
      (async () => {
        const settings = await loadSettings();
        // The popup passes what it is showing; settings are the fallback for
        // the moment right after a change, before the save has landed.
        const prefix = buildCachePrefix(
          message.targetLang ?? settings.targetLang,
          message.engine ?? settings.engine,
        );
        const texts: string[] = message.texts ?? [];
        const cached = await countCached(prefix, texts);
        return { cached, total: texts.length };
      })().then(sendResponse);
      return true;
    }
    // --- offline engine -----------------------------------------------
    if (message?.type === 'opus-status') {
      if (!opusAvailable()) {
        sendResponse({ ok: false, error: OPUS_UNAVAILABLE });
        return true;
      }
      opusStatus().then(
        (value) => sendResponse({ ok: true, value }),
        (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
      return true;
    }
    if (message?.type === 'opus-load') {
      opusLoad().then(
        (value) => sendResponse({ ok: true, value }),
        (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
      return true;
    }
    if (message?.type === 'opus-remove') {
      opusRemove().then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
      return true;
    }

    if (message?.type === 'clear-cache') {
      clearCache().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message?.type === 'cancel-batches') {
      cancelActive();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type !== 'translate-batch') return;

    translateBatch(
      message.texts,
      message.targetLang,
      message.srcIso ?? '',
      message.engine ?? 'google',
    ).then(
      (translations) => sendResponse({ ok: true, translations }),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );

    return true;
  });
});
