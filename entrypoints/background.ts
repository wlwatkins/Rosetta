import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { buildCachePrefix, clearCache, countCached } from '@/utils/cache';
import { cancelActive, translateBatch } from '@/utils/providers';
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
        const tabs = await getAutoTabs();
        if (tabId == null || !tabs[tabId]) return { auto: false };
        const settings = await loadSettings();
        return { auto: true, targetLang: settings.targetLang };
      })().then(sendResponse);
      return true;
    }
    if (message?.type === 'count-cache') {
      (async () => {
        const settings = await loadSettings();
        const prefix = buildCachePrefix(settings.targetLang);
        const texts: string[] = message.texts ?? [];
        const cached = await countCached(prefix, texts);
        return { cached, total: texts.length };
      })().then(sendResponse);
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

    translateBatch(message.texts, message.targetLang, message.srcIso ?? '').then(
      (translations) => sendResponse({ ok: true, translations }),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );

    return true;
  });
});
