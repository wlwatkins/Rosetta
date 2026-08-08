import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';

interface Entry {
  node: Text;
  original: string;
  queued: boolean;
  translated: boolean;
}

type Status = 'idle' | 'working' | 'translated';

// Elements whose text must never be translated.
const SKIP_SELECTOR =
  'script,style,noscript,code,pre,textarea,input,select,svg,iframe,canvas,[contenteditable]';

// Network round-trip dominates; send plenty per request but keep the query
// string well under server limits.
const LIMITS = { maxTexts: 40, maxChars: 2000 };

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    let entries: Entry[] = [];
    let tracked = new WeakSet<Text>();
    let status: Status = 'idle';
    let cancelled = false;
    let sessionId = 0;
    let sessionTarget = '';
    let srcIso = '';
    let startedAt = 0;
    let queue: Entry[] = [];
    let pumping = false;
    let pumpTimer: ReturnType<typeof setTimeout> | undefined;
    let io: IntersectionObserver | null = null;
    let mo: MutationObserver | null = null;
    const parentMap = new Map<Element, Entry[]>();
    const hiddenPending = new Set<Element>();
    let recheckTimer: ReturnType<typeof setTimeout> | undefined;
    let done = 0;
    let lastError: string | null = null;
    let lastElapsedMs: number | null = null;

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      switch (message?.type) {
        case 'get-status':
          sendResponse({
            status,
            done,
            total: totalEstimate(),
            elapsedMs: lastElapsedMs,
            error: lastError,
          });
          return;
        case 'restore':
          sessionId++;
          stopObservers();
          queue = [];
          browser.runtime.sendMessage({ type: 'cancel-batches' }).catch(() => {});
          restore();
          safeSend({ type: 'restored' });
          sendResponse({ ok: true });
          return;
        case 'translate':
          void startSession(message.targetLang);
          sendResponse({ ok: true });
          return;
        case 'get-cache-stats': {
          statsTarget = message.targetLang ?? '';
          void (async () => {
            const all = entries.length ? entries.map((e) => e.original.trim()) : scanTexts();
            // Only count strings a model would actually be asked to translate.
            const texts = all.filter((t) => needsTranslation(t));
            let iso = srcIso;
            if (!iso) iso = await detectSourceIso(texts);
            sendResponse({ texts: texts.slice(0, 5000), srcIso: iso });
          })();
          return true;
        }
        case 'cancel':
          cancelled = true;
          stopObservers();
          queue = [];
          clearMarks();
          browser.runtime.sendMessage({ type: 'cancel-batches' }).catch(() => {});
          if (!pumping) {
            status = done > 0 ? 'translated' : 'idle';
            safeSend({ type: 'cancelled', done, total: totalEstimate() });
          }
          sendResponse({ ok: true });
          return;
      }
    });

    // Refresh/navigation kills this script — abort in-flight requests so we
    // don't keep translating a page that no longer exists.
    window.addEventListener('pagehide', () => {
      if (status === 'working' || pumping) {
        browser.runtime.sendMessage({ type: 'cancel-batches' }).catch(() => {});
      }
    });

    // Auto-translate on load when this tab is flagged (per-tab toggle in popup).
    void (async () => {
      try {
        const res = await browser.runtime.sendMessage({ type: 'auto-translate-check' });
        if (res?.auto) {
          // Small delay so late-rendering content is included.
          setTimeout(() => void startSession(res.targetLang), 800);
        }
      } catch {
        // background unavailable — skip
      }
    })();

    const HAS_LETTER = /\p{L}/u;
    const ASCII_ONLY = /^[\x00-\x7F]*$/;
    // sessionTarget is empty before a run; fall back to the popup's target so
    // cache stats are meaningful on a page that hasn't been translated yet.
    let statsTarget = '';

    // Strings the model can't improve: no letters at all (prices, counts,
    // "•", "©"), or — when translating to English — already plain ASCII.
    // Skipping them saves a large share of tokens on listing-style pages.
    function needsTranslation(text: string): boolean {
      if (!HAS_LETTER.test(text)) return false;
      if ((sessionTarget || statsTarget) === 'EN' && ASCII_ONLY.test(text)) return false;
      return true;
    }

    function acceptText(node: Text): boolean {
      if (!node.nodeValue?.trim()) return false;
      const el = node.parentElement;
      return !!el && !el.closest(SKIP_SELECTOR);
    }

    function makeEntry(node: Text): Entry {
      tracked.add(node);
      return { node, original: node.nodeValue!, queued: false, translated: false };
    }

    function collectFrom(root: Node): Entry[] {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          !tracked.has(n as Text) && acceptText(n as Text)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      });
      const out: Entry[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(makeEntry(n as Text));
      return out;
    }

    function observeEntries(newEntries: Entry[]) {
      for (const e of newEntries) {
        const el = e.node.parentElement;
        if (!el) continue;
        let list = parentMap.get(el);
        if (!list) {
          parentMap.set(el, (list = []));
          io?.observe(el);
        }
        list.push(e);
      }
    }

    // Pulsing highlight on text that's queued or in-flight, so the user sees
    // what's in the translation pipeline. Refcounted per parent element.
    const MARK_CLASS = 'pt-translating-mark';
    const markCounts = new Map<Element, number>();

    function ensureStyle() {
      if (document.getElementById('pt-translate-style')) return;
      const s = document.createElement('style');
      s.id = 'pt-translate-style';
      s.textContent = `
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .${MARK_CLASS} {
    /* currentColor base + a gradient whose both ends are currentColor, tiled:
       every glyph pixel is always painted, so text never blanks out —
       only the blue band travels. */
    background-color: currentColor !important;
    background-image: linear-gradient(100deg, currentColor 42%, #7fa8ff 50%, currentColor 58%) !important;
    /* Tile width (200%) must equal the animation's travel distance, or the
       next tile's band cuts in mid-cycle and the loop stutters. */
    background-size: 200% 100% !important;
    background-repeat: repeat !important;
    background-clip: text !important;
    -webkit-background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
    animation: pt-translate-sweep 1.3s linear infinite !important;
  }
  @keyframes pt-translate-sweep {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }
}
@supports not ((-webkit-background-clip: text) or (background-clip: text)) {
  .${MARK_CLASS} { animation: pt-translate-pulse 1.2s ease-in-out infinite; }
  @keyframes pt-translate-pulse {
    0%, 100% { background-color: rgba(53, 103, 196, 0); }
    50% { background-color: rgba(53, 103, 196, 0.22); }
  }
}`;
      (document.head ?? document.documentElement).appendChild(s);
    }

    function markEntry(e: Entry) {
      const el = e.node.parentElement;
      if (!el) return;
      const n = markCounts.get(el) ?? 0;
      markCounts.set(el, n + 1);
      if (n === 0) el.classList.add(MARK_CLASS);
    }

    function unmarkEntry(e: Entry) {
      const el = e.node.parentElement;
      if (!el) return;
      const n = markCounts.get(el);
      if (!n) return;
      if (n <= 1) {
        markCounts.delete(el);
        el.classList.remove(MARK_CLASS);
      } else {
        markCounts.set(el, n - 1);
      }
    }

    function clearMarks() {
      for (const el of markCounts.keys()) el.classList.remove(MARK_CLASS);
      markCounts.clear();
    }

    // IO only sees geometry — CSS-hidden elements (visibility:hidden,
    // opacity:0, zero-size) can still "intersect". checkVisibility() closes
    // that gap.
    function isRendered(el: Element): boolean {
      const check = (el as HTMLElement).checkVisibility;
      if (typeof check === 'function') {
        const visible = check.call(el, {
          checkOpacity: true,
          checkVisibilityCSS: true,
          opacityProperty: true,
          visibilityProperty: true,
        } as CheckVisibilityOptions);
        if (!visible) return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function enqueueElement(el: Element) {
      const list = parentMap.get(el);
      parentMap.delete(el);
      hiddenPending.delete(el);
      io?.unobserve(el);
      if (!list) return;
      for (const e of list) {
        if (e.queued || e.translated) continue;
        if (!needsTranslation(e.original.trim())) {
          e.translated = true; // nothing to do — never send it to a model
          continue;
        }
        e.queued = true;
        queue.push(e);
        markEntry(e);
      }
    }

    // Visible elements enqueue their text; hidden ones (closed menus,
    // below-the-fold content) wait until they actually appear.
    function onIntersect(ioEntries: IntersectionObserverEntry[]) {
      for (const ie of ioEntries) {
        if (!ie.isIntersecting) continue;
        const hasArea = ie.intersectionRect.width > 0 && ie.intersectionRect.height > 0;
        if (!hasArea || !isRendered(ie.target)) {
          // In viewport area but CSS-hidden. Revealing it changes no geometry,
          // so IO stays silent — recheck on reveal-ish events instead.
          hiddenPending.add(ie.target);
          continue;
        }
        enqueueElement(ie.target);
      }
      schedulePump();
    }

    function recheckHidden() {
      if (hiddenPending.size === 0) return;
      let found = false;
      for (const el of [...hiddenPending]) {
        if (!parentMap.has(el)) {
          hiddenPending.delete(el);
          continue;
        }
        const r = el.getBoundingClientRect();
        const inView = r.bottom > -200 && r.top < window.innerHeight + 200;
        if (inView && isRendered(el)) {
          enqueueElement(el);
          found = true;
        }
      }
      if (found) schedulePump();
    }

    function scheduleRecheck() {
      if (recheckTimer) return;
      recheckTimer = setTimeout(() => {
        recheckTimer = undefined;
        recheckHidden();
      }, 250);
    }

    const REVEAL_EVENTS = ['click', 'mouseover', 'focusin', 'transitionend', 'animationend'];

    // SPA re-renders and dynamically injected content join the session too.
    function onMutations(muts: MutationRecord[]) {
      if (!sessionTarget || cancelled) return;
      const added: Entry[] = [];
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === Node.ELEMENT_NODE) added.push(...collectFrom(n));
          else if (n.nodeType === Node.TEXT_NODE && !tracked.has(n as Text) && acceptText(n as Text))
            added.push(makeEntry(n as Text));
        });
      }
      if (added.length) {
        entries.push(...added);
        observeEntries(added);
      }
    }

    function emitProgress() {
      safeSend({ type: 'progress', done, total: totalEstimate() });
    }

    function schedulePump() {
      clearTimeout(pumpTimer);
      const id = sessionId;
      pumpTimer = setTimeout(() => {
        // Tell the popup there's pending work before the first batch returns,
        // otherwise the bar stays hidden for the whole first request.
        if (queue.length > 0 && !cancelled && id === sessionId) emitProgress();
        void pump(id);
      }, 150);
    }

    function totalEstimate(): number {
      const per = LIMITS.maxTexts;
      return done + Math.ceil(queue.length / per) + (pumping ? 1 : 0);
    }

    // Translation only runs while the tab is actually in focus.
    function waitVisible(): Promise<void> {
      if (!document.hidden) return Promise.resolve();
      return new Promise((resolve) => {
        const handler = () => {
          if (!document.hidden) {
            document.removeEventListener('visibilitychange', handler);
            resolve();
          }
        };
        document.addEventListener('visibilitychange', handler);
      });
    }

    async function startSession(targetLang: string) {
      sessionId++;
      const id = sessionId;
      stopObservers();
      queue = [];
      if (entries.length) restore();
      cancelled = false;
      done = 0;
      lastError = null;
      lastElapsedMs = null;
      sessionTarget = targetLang;
      startedAt = performance.now();
      status = 'working';
      ensureStyle();

      entries = collectFrom(document.body);
      srcIso = await detectSourceIso();
      if (id !== sessionId) return;

      io = new IntersectionObserver(onIntersect, { rootMargin: '200px' });
      observeEntries(entries);
      mo = new MutationObserver(onMutations);
      mo.observe(document.body, { childList: true, subtree: true });
      for (const ev of REVEAL_EVENTS) document.addEventListener(ev, scheduleRecheck, true);
    }

    const VIEW_MARGIN = 200;

    function isVisibleNow(e: Entry): boolean {
      const el = e.node.parentElement;
      if (!el || !el.isConnected) return false;
      if (!isRendered(el)) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > -VIEW_MARGIN && r.top < window.innerHeight + VIEW_MARGIN;
    }

    // Put an entry back under observation: it was queued while visible, but
    // the page reflowed it out of view before we got to it.
    function deferEntry(e: Entry) {
      e.queued = false;
      unmarkEntry(e);
      const el = e.node.parentElement;
      if (!el) return;
      let list = parentMap.get(el);
      if (!list) {
        parentMap.set(el, (list = []));
        io?.observe(el);
      }
      if (!list.includes(e)) list.push(e);
    }

    function takeBatch(): Entry[] {
      const limits = LIMITS;
      const batch: Entry[] = [];
      let chars = 0;
      let deferred = 0;
      while (queue.length > 0 && batch.length < limits.maxTexts) {
        const next = queue[0]!;
        // Layout may have moved this out of view since it was queued
        // (SPA reflow, images loading, sticky headers settling).
        if (!isVisibleNow(next)) {
          queue.shift();
          deferEntry(next);
          deferred++;
          continue;
        }
        const len = next.original.trim().length;
        if (batch.length > 0 && chars + len > limits.maxChars) break;
        batch.push(queue.shift()!);
        chars += len;
      }
      if (deferred > 0) {
        console.debug(`[translator] deferred ${deferred} strings that scrolled out of view`);
      }
      return batch;
    }

    async function pump(id: number) {
      if (pumping || id !== sessionId) return;
      pumping = true;
      let failed = false;
      // Requests are network-bound, so several can be in flight at once.
      const maxInflight = 4;
      const inflight = new Set<Promise<void>>();

      const runBatch = (batch: Entry[]): Promise<void> =>
        (async () => {
          const texts = batch.map((e) => e.original.trim());
          const res = await browser.runtime
            .sendMessage({
              type: 'translate-batch',
              texts,
              targetLang: sessionTarget,
              srcIso,
            })
            .catch((err) => ({ ok: false, error: String(err) }));

          if (id !== sessionId) return;
          if (!res?.ok) {
            if (res?.error !== 'Cancelled' && !failed) {
              lastError = res?.error ?? 'Unknown error';
              failed = true;
              safeSend({ type: 'translate-error', message: lastError, done, total: totalEstimate() });
            }
            cancelled = true;
            return;
          }

          batch.forEach((e, j) => {
            applyTranslation(e, res.translations[j]);
            e.translated = true;
            unmarkEntry(e);
          });
          done++;
          console.debug(
            `[translator] batch ${done}: ${batch.length} texts | queued: ${queue.length} | not yet visible: ${parentMap.size} elements`,
          );
          emitProgress();
        })();

      while (!cancelled && id === sessionId) {
        if (queue.length === 0 || inflight.size >= maxInflight) {
          if (inflight.size === 0) break;
          await Promise.race(inflight);
          continue;
        }
        await waitVisible();
        if (cancelled || id !== sessionId) break;
        status = 'working';

        const batch = takeBatch();
        // Everything left in the queue was deferred as off-screen.
        if (batch.length === 0) {
          if (inflight.size === 0) break;
          await Promise.race(inflight);
          continue;
        }
        const p = runBatch(batch);
        inflight.add(p);
        void p.finally(() => inflight.delete(p));
      }
      if (inflight.size > 0) await Promise.allSettled([...inflight]);

      pumping = false;
      if (id !== sessionId) return;
      if (failed || cancelled) {
        clearMarks();
        status = done > 0 ? 'translated' : 'idle';
        if (cancelled && !failed) safeSend({ type: 'cancelled', done, total: totalEstimate() });
        return;
      }
      if (queue.length === 0 && done > 0) {
        status = 'translated';
        lastElapsedMs = Math.round(performance.now() - startedAt);
        safeSend({ type: 'complete', elapsedMs: lastElapsedMs });
      }
    }

    function applyTranslation(entry: Entry, translated: string | undefined) {
      if (typeof translated !== 'string' || translated.length === 0) return;
      const lead = entry.original.match(/^\s*/)![0];
      const trail = entry.original.match(/\s*$/)![0];
      entry.node.nodeValue = lead + translated + trail;
    }

    function restore() {
      clearMarks();
      for (const e of entries) e.node.nodeValue = e.original;
      entries = [];
      tracked = new WeakSet<Text>();
      status = 'idle';
      done = 0;
      lastElapsedMs = null;
      lastError = null;
    }

    function stopObservers() {
      io?.disconnect();
      io = null;
      mo?.disconnect();
      mo = null;
      parentMap.clear();
      hiddenPending.clear();
      clearTimeout(pumpTimer);
      clearTimeout(recheckTimer);
      recheckTimer = undefined;
      for (const ev of REVEAL_EVENTS) document.removeEventListener(ev, scheduleRecheck, true);
    }

    // Side-effect-free scan of the page's translatable strings.
    function scanTexts(): string[] {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          acceptText(n as Text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      const out: string[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        out.push(n.nodeValue!.trim());
      }
      return out;
    }

    // In-browser MT models (NLLB) need an explicit source language.
    async function detectSourceIso(texts?: string[]): Promise<string> {
      const sample = (texts ?? entries.map((e) => e.original.trim()))
        .slice(0, 80)
        .join(' ')
        .slice(0, 2000);
      try {
        const det = await browser.i18n.detectLanguage(sample);
        const top = det?.languages?.[0];
        if (top?.language && top.language !== 'und') return top.language;
      } catch {
        // i18n API unavailable — fall through
      }
      return '';
    }

    // Popup may be closed mid-run; a message with no receiver must not throw.
    function safeSend(message: unknown) {
      browser.runtime.sendMessage(message).catch(() => {});
    }
  },
});
