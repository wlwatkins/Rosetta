import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import {
  engineAcceptsSource,
  engineInfo,
  isoFromCode,
  sameLanguage,
  type Engine,
} from '@/utils/languages';

interface Entry {
  /** Element used for visibility decisions and the shimmer highlight. */
  el: Element;
  /** Source text, trimmed — exactly what gets sent for translation. */
  original: string;
  queued: boolean;
  translated: boolean;
  /** Text nodes shimmer; attribute values have nothing to paint. */
  markable: boolean;
  apply: (translated: string) => void;
  reset: () => void;
}

type Status = 'idle' | 'working' | 'translated';

// Elements whose text must never be translated.
const SKIP_SELECTOR =
  'script,style,noscript,code,pre,textarea,input,select,svg,iframe,canvas,[contenteditable]';

// User-visible text that lives in attributes rather than text nodes:
// search placeholders, tooltips, image alts, screen-reader labels.
const TEXT_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;
const ATTR_SELECTOR = TEXT_ATTRS.map((a) => `[${a}]`).join(',');

// Google: the network round-trip dominates, so send plenty per request while
// keeping the query string well under server limits, and keep several in
// flight. OPUS-MT is the opposite — one CPU/GPU doing the work, so four
// concurrent generations just thrash it, and smaller batches put text on the
// screen steadily instead of in lumps.
const ENGINE_LIMITS: Record<Engine, { maxTexts: number; maxChars: number; maxInflight: number }> = {
  google: { maxTexts: 40, maxChars: 2000, maxInflight: 4 },
  opus: { maxTexts: 8, maxChars: 800, maxInflight: 1 },
};

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  // Pages like madlan.co.il put content inside iframes; each frame gets its
  // own instance with its own queue.
  allFrames: true,
  main() {
    const isTopFrame = window.top === window.self;
    let entries: Entry[] = [];
    let tracked = new WeakSet<Text>();
    let trackedAttrs = new WeakMap<Element, Set<string>>();
    let status: Status = 'idle';
    let cancelled = false;
    let sessionId = 0;
    let sessionTarget = '';
    let sessionEngine: Engine = 'google';
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
          safeSend({ type: 'session-ended' });
          restore();
          safeSend({ type: 'restored' });
          sendResponse({ ok: true });
          return;
        case 'translate':
          void startSession(message.targetLang, message.engine ?? 'google');
          sendResponse({ ok: true });
          return;
        case 'get-cache-stats': {
          statsTarget = message.targetLang ?? '';
          statsEngine = message.engine ?? 'google';
          void (async () => {
            const all = entries.length ? entries.map((e) => e.original) : scanTexts();
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
          safeSend({ type: 'session-ended' });
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

    // A new top-level document retires the tab's previous session. Reported
    // from here rather than from a navigation event because a sub-frame
    // loading can also mark the tab as navigating.
    if (isTopFrame) safeSend({ type: 'page-loaded' });

    // Auto-translate on load: either this tab was flagged in the popup, or a
    // global rule says "translate every page written in <language>".
    void (async () => {
      try {
        // Sub-frames often hold too little text to language-detect reliably;
        // the top frame decides, and its 'translate' broadcast reaches them.
        // That broadcast is one-off, though: a frame created afterwards — the
        // iframe behind a modal, a lazily mounted widget — never sees it, so
        // ask whether this tab is already mid-session and join it.
        if (!isTopFrame) {
          // Let the frame's own app render before sampling its text.
          await new Promise((r) => setTimeout(r, 800));
          const active = await browser.runtime.sendMessage({ type: 'frame-session-check' });
          // sessionTarget is already set if the broadcast got here first.
          if (active?.targetLang && !sessionTarget) {
            void startSession(active.targetLang, active.engine ?? 'google');
          }
          return;
        }
        const res = await browser.runtime.sendMessage({ type: 'auto-translate-check' });
        if (!res) return;
        // Ask the background to broadcast to every frame (including this one)
        // so iframes translate as well. Small delay so late-rendering content
        // is included in the sample.
        const start = () =>
          setTimeout(() => {
            browser.runtime
              .sendMessage({
                type: 'broadcast-translate',
                targetLang: res.targetLang,
                engine: res.engine,
              })
              .catch(() => void startSession(res.targetLang, res.engine));
          }, 800);

        if (res.auto) {
          start();
          return;
        }
        if (!res.autoSourceLang || res.autoSourceLang === res.targetLang) return;

        // Language rule: only translate if the page really is in that language.
        setTimeout(async () => {
          // Require a confident match: auto-translating a misdetected page is
          // far more annoying than not translating it.
          const detected = await detectSourceIso(scanTexts(), 60);
          if (detected && sameLanguage(detected, isoFromCode(res.autoSourceLang))) {
            browser.runtime
              .sendMessage({
                type: 'broadcast-translate',
                targetLang: res.targetLang,
                engine: res.engine,
              })
              .catch(() => void startSession(res.targetLang, res.engine));
          }
        }, 800);
      } catch {
        // background unavailable — skip
      }
    })();

    const HAS_LETTER = /\p{L}/u;
    // Which script an engine's source language is written in, for the
    // per-string check above. Only languages some engine restricts to.
    const SCRIPT_OF: Record<string, RegExp> = { he: /\p{Script=Hebrew}/u };
    const ASCII_ONLY = /^[\x00-\x7F]*$/;
    // sessionTarget is empty before a run; fall back to the popup's target so
    // cache stats are meaningful on a page that hasn't been translated yet.
    let statsTarget = '';
    let statsEngine: Engine = 'google';

    // Strings the model can't improve: no letters at all (prices, counts,
    // "•", "©"), or — when translating to English — already plain ASCII.
    // Skipping them saves a large share of tokens on listing-style pages.
    function needsTranslation(text: string): boolean {
      if (!HAS_LETTER.test(text)) return false;
      if ((sessionTarget || statsTarget) === 'EN' && ASCII_ONLY.test(text)) return false;
      // A single-pair model has nothing useful to say about a string in some
      // other language, and asking it invites invented output.
      const sources = engineInfo(sessionTarget ? sessionEngine : statsEngine).sources;
      if (sources && !sources.some((iso) => SCRIPT_OF[iso]?.test(text))) return false;
      return true;
    }

    function acceptText(node: Text): boolean {
      if (!node.nodeValue?.trim()) return false;
      const el = node.parentElement;
      return !!el && !el.closest(SKIP_SELECTOR);
    }

    function makeEntry(node: Text): Entry {
      tracked.add(node);
      const raw = node.nodeValue!;
      const lead = raw.match(/^\s*/)![0];
      const trail = raw.match(/\s*$/)![0];
      return {
        el: node.parentElement!,
        original: raw.trim(),
        queued: false,
        translated: false,
        markable: true,
        apply: (v) => {
          node.nodeValue = lead + v + trail;
        },
        reset: () => {
          node.nodeValue = raw;
        },
      };
    }

    function makeAttrEntry(el: Element, attr: string): Entry {
      let seen = trackedAttrs.get(el);
      if (!seen) trackedAttrs.set(el, (seen = new Set()));
      seen.add(attr);
      const raw = el.getAttribute(attr)!;
      return {
        el,
        original: raw.trim(),
        queued: false,
        translated: false,
        markable: false,
        apply: (v) => el.setAttribute(attr, v),
        reset: () => el.setAttribute(attr, raw),
      };
    }

    // The tab title lives in <head>, which the body walker never reaches.
    // Anchor it to <html> so it queues immediately rather than waiting for
    // an element to scroll into view.
    function makeTitleEntry(): Entry | null {
      // Only the top frame's title is ever shown to the user.
      if (!isTopFrame) return null;
      const raw = document.title;
      if (!raw?.trim()) return null;
      return {
        el: document.documentElement,
        original: raw.trim(),
        queued: false,
        translated: false,
        markable: false,
        apply: (v) => {
          document.title = v;
        },
        reset: () => {
          document.title = raw;
        },
      };
    }

    function collectAttrs(root: Node): Entry[] {
      if (!(root instanceof Element) && root.nodeType !== Node.DOCUMENT_NODE) return [];
      const scope = root as Element;
      const els: Element[] = [];
      if (scope.matches?.(ATTR_SELECTOR)) els.push(scope);
      els.push(...Array.from(scope.querySelectorAll?.(ATTR_SELECTOR) ?? []));

      const out: Entry[] = [];
      for (const el of els) {
        const seen = trackedAttrs.get(el);
        for (const attr of TEXT_ATTRS) {
          if (seen?.has(attr)) continue;
          const value = el.getAttribute(attr);
          if (value && value.trim()) out.push(makeAttrEntry(el, attr));
        }
      }
      return out;
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
      out.push(...collectAttrs(root));
      return out;
    }

    function observeEntries(newEntries: Entry[]) {
      for (const e of newEntries) {
        const el = e.el;
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
      if (!e.markable) return;
      const el = e.el;
      if (!el) return;
      const n = markCounts.get(el) ?? 0;
      markCounts.set(el, n + 1);
      if (n === 0) el.classList.add(MARK_CLASS);
    }

    function unmarkEntry(e: Entry) {
      if (!e.markable) return;
      const el = e.el;
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
        if (!needsTranslation(e.original)) {
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
      const per = ENGINE_LIMITS[sessionEngine].maxTexts;
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

    async function startSession(targetLang: string, engine: Engine = 'google') {
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
      sessionEngine = engine;
      safeSend({ type: 'session-started', targetLang, engine });
      startedAt = performance.now();
      status = 'working';
      ensureStyle();

      entries = collectFrom(document.body);
      const title = makeTitleEntry();
      if (title) entries.push(title);
      srcIso = await detectSourceIso();
      if (id !== sessionId) return;

      // A single-pair engine on the wrong page produces confident nonsense, so
      // stop before anything is sent rather than translating the page badly.
      if (!engineAcceptsSource(engine, srcIso)) {
        const only = engineInfo(engine).sources?.join(', ') ?? '';
        lastError = `This page doesn't look like ${only.toUpperCase()} — ${
          engineInfo(engine).label
        } only translates ${only.toUpperCase()} to English. Switch engines for this page.`;
        status = 'idle';
        entries = [];
        safeSend({ type: 'session-ended' });
        safeSend({ type: 'translate-error', message: lastError, done: 0, total: 0 });
        return;
      }

      io = new IntersectionObserver(onIntersect, { rootMargin: '200px' });
      observeEntries(entries);
      mo = new MutationObserver(onMutations);
      mo.observe(document.body, { childList: true, subtree: true });
      for (const ev of REVEAL_EVENTS) document.addEventListener(ev, scheduleRecheck, true);
    }

    const VIEW_MARGIN = 200;

    function isVisibleNow(e: Entry): boolean {
      const el = e.el;
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
      const el = e.el;
      if (!el) return;
      let list = parentMap.get(el);
      if (!list) {
        parentMap.set(el, (list = []));
        io?.observe(el);
      }
      if (!list.includes(e)) list.push(e);
    }

    function takeBatch(): Entry[] {
      const limits = ENGINE_LIMITS[sessionEngine];
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
        const len = next.original.length;
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
      const maxInflight = ENGINE_LIMITS[sessionEngine].maxInflight;
      const inflight = new Set<Promise<void>>();

      const runBatch = (batch: Entry[]): Promise<void> =>
        (async () => {
          const texts = batch.map((e) => e.original);
          const res = await browser.runtime
            .sendMessage({
              type: 'translate-batch',
              texts,
              targetLang: sessionTarget,
              srcIso,
              engine: sessionEngine,
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
      entry.apply(translated);
    }

    function restore() {
      clearMarks();
      for (const e of entries) e.reset();
      entries = [];
      tracked = new WeakSet<Text>();
      trackedAttrs = new WeakMap<Element, Set<string>>();
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
    async function detectSourceIso(texts?: string[], minPercent = 0): Promise<string> {
      const sample = (texts ?? entries.map((e) => e.original))
        .slice(0, 80)
        .join(' ')
        .slice(0, 2000);
      // Too little text to judge — a wrong guess is worse than no guess.
      if (sample.replace(/\s+/g, '').length < 20) return '';
      try {
        const det = await browser.i18n.detectLanguage(sample);
        const top = det?.languages?.[0];
        if (top?.language && top.language !== 'und' && (top.percentage ?? 0) >= minPercent) {
          return top.language;
        }
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
