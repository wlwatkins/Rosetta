<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { ENGINES, engineInfo, engineSources, engineTargets } from '@/utils/languages';
  import type { OpusStatus } from '@/utils/opus-types';
  import {
    DEFAULT_SETTINGS,
    loadSettings,
    reconcile,
    saveSettings,
    type Settings,
  } from '@/utils/settings';

  type PageStatus = 'idle' | 'working' | 'translated' | 'unavailable';

  let settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  let loaded = $state(false);
  let pageStatus = $state<PageStatus>('idle');
  let progress = $state({ done: 0, total: 0 });
  let elapsedMs = $state<number | null>(null);
  let error = $state<string | null>(null);
  let autoTab = $state(false);
  let cacheStats = $state<{ cached: number; total: number } | null>(null);
  let model = $state<OpusStatus | null>(null);
  let modelError = $state<string | null>(null);
  const targets = $derived(engineTargets(settings.engine));
  const isOffline = $derived(engineInfo(settings.engine).offline);
  let tabId: number | undefined;
  const version = browser.runtime.getManifest().version;
  const REPO_URL = 'https://github.com/wlwatkins/Rosetta';

  onMount(() => {
    void init();
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  });

  async function init() {
    settings = await loadSettings();
    loaded = true;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    if (tabId == null) {
      pageStatus = 'unavailable';
      return;
    }
    try {
      // frameId 0 = main frame. Without it, any iframe could answer first.
      const res = await browser.tabs.sendMessage(tabId, { type: 'get-status' }, { frameId: 0 });
      pageStatus = res?.status ?? 'unavailable';
      progress = { done: res?.done ?? 0, total: res?.total ?? 0 };
      elapsedMs = res?.elapsedMs ?? null;
      error = res?.error ?? null;
    } catch {
      pageStatus = 'unavailable';
    }
    const at = await browser.runtime.sendMessage({ type: 'get-auto-tab', tabId }).catch(() => null);
    autoTab = !!at?.enabled;
    void refreshCacheStats();
    void refreshModel();
  }

  // Persist settings on any change. reconcile() keeps the target legal for the
  // engine — picking the offline one while the target is French moves the
  // target to English rather than saving a combination nothing can serve.
  $effect(() => {
    const snapshot = reconcile($state.snapshot(settings));
    if (snapshot.targetLang !== settings.targetLang) settings.targetLang = snapshot.targetLang;
    if (loaded) void saveSettings(snapshot);
  });

  // Switching engine invalidates the cache figure (separate namespaces), the
  // model status, and any run in flight.
  let prevEngine = '';
  $effect(() => {
    const engine = settings.engine;
    if (loaded && prevEngine && engine !== prevEngine) {
      if (pageStatus === 'working') void cancel();
      modelError = null;
      void refreshCacheStats();
      void refreshModel();
    }
    prevEngine = engine;
  });

  // Changing the target language mid-run aborts it — the output would be for
  // the wrong language.
  let prevTarget = '';
  $effect(() => {
    const target = settings.targetLang;
    if (loaded && prevTarget && target !== prevTarget) {
      if (pageStatus === 'working') void cancel();
      void refreshCacheStats();
    }
    prevTarget = target;
  });

  function onMessage(message: any) {
    if (message?.type === 'progress') {
      pageStatus = 'working';
      progress = { done: message.done, total: message.total };
      scheduleCacheRefresh();
    } else if (message?.type === 'complete') {
      pageStatus = 'translated';
      elapsedMs = message.elapsedMs;
      void refreshCacheStats();
    } else if (message?.type === 'translate-error') {
      error = message.message;
      pageStatus = message.done > 0 ? 'translated' : 'idle';
    } else if (message?.type === 'cancelled') {
      pageStatus = message.done > 0 ? 'translated' : 'idle';
    } else if (message?.type === 'restored') {
      pageStatus = 'idle';
      elapsedMs = null;
      error = null;
    } else if (message?.type === 'opus-progress') {
      model = message.status;
    }
  }

  // Keep the cache figure live during a run without re-scanning on every batch.
  let cacheRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleCacheRefresh() {
    if (cacheRefreshTimer) return;
    cacheRefreshTimer = setTimeout(() => {
      cacheRefreshTimer = undefined;
      void refreshCacheStats();
    }, 1500);
  }

  async function refreshModel() {
    if (!isOffline) {
      model = null;
      return;
    }
    const res = await browser.runtime.sendMessage({ type: 'opus-status' }).catch(() => null);
    if (res?.ok) {
      model = res.value;
      modelError = null;
    } else {
      model = null;
      modelError = res?.error ?? 'Could not reach the offline engine.';
    }
  }

  async function downloadModel() {
    modelError = null;
    // Optimistic placeholder so the bar appears immediately; the real status
    // arrives on the first opus-progress message.
    model = {
      ...(model ?? { modelId: '', approxMb: 0 }),
      state: 'loading',
      progress: 0,
      device: null,
      error: null,
    };
    const res = await browser.runtime.sendMessage({ type: 'opus-load' }).catch(() => null);
    if (res?.ok) model = res.value;
    else {
      model = null;
      modelError = res?.error ?? 'The model failed to load.';
    }
  }

  async function removeModel() {
    await browser.runtime.sendMessage({ type: 'opus-remove' }).catch(() => {});
    void refreshModel();
  }

  async function refreshCacheStats() {
    if (tabId == null) return;
    try {
      const page = await browser.tabs.sendMessage(
        tabId,
        { type: 'get-cache-stats', targetLang: settings.targetLang, engine: settings.engine },
        { frameId: 0 },
      );
      if (!page?.texts?.length) {
        cacheStats = null;
        return;
      }
      const res = await browser.runtime.sendMessage({
        type: 'count-cache',
        texts: page.texts,
        srcIso: page.srcIso ?? '',
        targetLang: settings.targetLang,
        engine: settings.engine,
      });
      cacheStats = { cached: res?.cached ?? 0, total: page.texts.length };
    } catch {
      cacheStats = null;
    }
  }

  async function clearCache() {
    await browser.runtime.sendMessage({ type: 'clear-cache' }).catch(() => {});
    await refreshCacheStats();
  }

  async function saveAutoTab() {
    if (tabId == null) return;
    await browser.runtime.sendMessage({ type: 'set-auto-tab', tabId, enabled: autoTab });
    // Turning it on acts on the page you're looking at, not just future loads.
    if (autoTab && pageStatus === 'idle') void translate();
  }

  async function translate() {
    if (tabId == null) return;
    error = null;
    elapsedMs = null;
    progress = { done: 0, total: 0 };
    pageStatus = 'working';
    await browser.tabs.sendMessage(tabId, {
      type: 'translate',
      targetLang: settings.targetLang,
      engine: settings.engine,
    });
  }

  async function cancel() {
    if (tabId == null) return;
    await browser.tabs.sendMessage(tabId, { type: 'cancel' });
  }

  async function restore() {
    if (tabId == null) return;
    await browser.tabs.sendMessage(tabId, { type: 'restore' });
    pageStatus = 'idle';
    elapsedMs = null;
    error = null;
  }
</script>

<main>
  <header>
    <h1>Rosetta</h1>
    <span class="he" lang="he" dir="rtl">רוזטה</span>
  </header>

  {#if pageStatus === 'unavailable'}
    <p class="error">
      Can't access this page. Content scripts don't run on browser pages — and pages open from
      before the extension loaded need a reload.
    </p>
  {:else}
    <label class="field">
      Engine
      <select bind:value={settings.engine}>
        {#each ENGINES as e}
          <option value={e.id}>{e.label}</option>
        {/each}
      </select>
    </label>

    {#if isOffline}
      {#if modelError}
        <p class="error">{modelError}</p>
      {:else if model?.state === 'ready'}
        <p class="hint">
          Model ready ({model?.device === 'webgpu' ? 'GPU' : 'CPU'})
          <button class="link" onclick={removeModel}>remove</button>
        </p>
      {:else if model?.state === 'loading'}
        <progress value={model?.progress ?? 0} max="100"></progress>
        <p class="hint">Downloading model… {model?.progress ?? 0}%</p>
      {:else if model?.state === 'error'}
        <p class="error">{model?.error}</p>
        <button onclick={downloadModel}>Retry</button>
      {:else}
        <p class="hint">
          Runs on this machine once downloaded — page text is never sent anywhere.
          {#if model?.approxMb}One-time download, ~{model.approxMb}&nbsp;MB.{/if}
        </p>
        <button onclick={downloadModel}>Download model</button>
      {/if}
    {/if}

    <label class="field">
      Translate to
      <select bind:value={settings.targetLang} disabled={targets.length < 2}>
        {#each targets as lang}
          <option value={lang.code}>{lang.name}</option>
        {/each}
      </select>
      {#if targets.length < 2}
        <span class="hint">{engineInfo(settings.engine).label} only translates Hebrew to English.</span>
      {/if}
    </label>

    <div class="row">
      <button
        class="primary"
        onclick={translate}
        disabled={pageStatus === 'working' || (isOffline && model?.state !== 'ready')}
      >
        {pageStatus === 'working' ? 'Translating…' : 'Translate page'}
      </button>
      {#if pageStatus === 'working'}
        <button onclick={cancel}>Cancel</button>
      {:else}
        <button onclick={restore} disabled={pageStatus !== 'translated'}>Restore</button>
      {/if}
    </div>

    <label class="row">
      <input type="checkbox" bind:checked={autoTab} onchange={saveAutoTab} />
      Auto-translate this tab on load
    </label>

    <label class="field">
      Always translate pages written in
      <select bind:value={settings.autoSourceLang}>
        <option value="">Never — ask me each time</option>
        {#each engineSources(settings.engine).filter((l) => l.code !== settings.targetLang) as lang}
          <option value={lang.code}>{lang.name}</option>
        {/each}
      </select>
    </label>

    {#if pageStatus === 'working' && progress.total > 0}
      <progress value={progress.done} max={progress.total}></progress>
      <p class="hint">{progress.done} / {progress.total} batches</p>
    {/if}

    {#if elapsedMs != null}
      <p class="hint">Done in {(elapsedMs / 1000).toFixed(1)}s</p>
    {/if}

    {#if error}
      <p class="error">{error}</p>
    {/if}

    {#if cacheStats}
      <p class="hint">
        Cache: {cacheStats.cached} / {cacheStats.total} page strings
        <button class="link" onclick={clearCache}>clear</button>
      </p>
    {/if}
  {/if}

  <p class="version">
    <a href={REPO_URL} target="_blank" rel="noreferrer">Rosetta v{version}</a>
  </p>
</main>

<style>
  :global(body) {
    margin: 0;
    min-width: 280px;
    font-family: system-ui, sans-serif;
    font-size: 14px;
  }
  main {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  h1 {
    font-size: 16px;
    margin: 0;
  }
  .he {
    font-size: 16px;
    font-weight: 700;
    /* Match the h1 rather than hard-coding black, so it stays legible if the
       browser renders the popup in a dark theme. */
    color: inherit;
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  button {
    padding: 6px 10px;
    cursor: pointer;
  }
  button.primary {
    flex: 1;
    font-weight: 600;
  }
  button.link {
    background: none;
    border: none;
    padding: 0;
    color: #3b6ff5;
    cursor: pointer;
  }
  progress {
    width: 100%;
  }
  .hint {
    margin: 0;
    color: #666;
    font-size: 12px;
  }
  .error {
    margin: 0;
    color: #c0392b;
    font-size: 12px;
  }
  .version {
    margin: 2px 0 0;
    padding-top: 8px;
    border-top: 1px solid rgba(128, 128, 128, 0.25);
    font-size: 11px;
    text-align: right;
  }
  .version a {
    color: #888;
    text-decoration: none;
  }
  .version a:hover {
    color: #3b6ff5;
    text-decoration: underline;
  }
</style>
