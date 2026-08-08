import { browser } from 'wxt/browser';

// Persistent translation cache, shared across pages, tabs and browser
// restarts. Keys are `${targetLang} ${sourceText}` — the cache belongs to a
// language, not to a backend, so a string translated once is reused no matter
// which engine produced it (and switching models keeps the memory).
//
// Memory is only a fast path: an MV3 service worker can be terminated at any
// moment, so entries are written through to storage immediately. A debounced
// write loses whole runs.

const KEY = 'txCache2';
const LEGACY_KEY = 'txCache'; // provider/model-keyed; no longer meaningful
const MAX_ENTRIES = 20000;

const mem = new Map<string, string>();
let migrated = false;

async function dropLegacy(): Promise<void> {
  if (migrated) return;
  migrated = true;
  try {
    await browser.storage.local.remove(LEGACY_KEY);
  } catch {
    // nothing to clean up
  }
}

async function readDisk(): Promise<Record<string, string>> {
  void dropLegacy();
  try {
    const res = await browser.storage.local.get(KEY);
    return (res[KEY] as Record<string, string> | undefined) ?? {};
  } catch (err) {
    console.warn('[cache] read failed:', err);
    return {};
  }
}

async function writeEntries(fresh: Map<string, string>): Promise<void> {
  if (fresh.size === 0) return;
  const stored = await readDisk();
  for (const [k, v] of fresh) {
    stored[k] = v;
    mem.set(k, v);
  }
  // Trim oldest first (string keys keep insertion order).
  const keys = Object.keys(stored);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete stored[k];
      mem.delete(k);
    }
  }
  try {
    await browser.storage.local.set({ [KEY]: stored });
  } catch (err) {
    // Most likely a quota error — surface it instead of failing silently.
    console.warn('[cache] write failed:', err);
  }
}

/** Wipe the cache (this context's memory + disk). */
export async function clearCache(): Promise<void> {
  mem.clear();
  await browser.storage.local.remove([KEY, LEGACY_KEY]);
}

/**
 * Cache namespace. Only the target language matters — the source language is
 * implied by the source text itself, and the backend is irrelevant to what a
 * string means.
 */
export function buildCachePrefix(targetCode: string): string {
  return targetCode;
}

/** How many of `texts` already have a cached translation under `prefix`. */
export async function countCached(prefix: string, texts: string[]): Promise<number> {
  const stored = await readDisk();
  let n = 0;
  for (const t of texts) {
    const k = `${prefix} ${t}`;
    if (mem.has(k) || k in stored) n++;
  }
  return n;
}

/**
 * Serve texts from cache, run `translate` only for the misses, then cache
 * the fresh results. Result order matches `texts`.
 */
export async function withCache(
  prefix: string,
  texts: string[],
  translate: (missing: string[]) => Promise<string[]>,
): Promise<string[]> {
  const keyOf = (t: string) => `${prefix} ${t}`;

  const out: string[] = new Array(texts.length);
  let missing: string[] = [];
  let missingIdx: number[] = [];
  texts.forEach((t, i) => {
    const hit = mem.get(keyOf(t));
    if (hit !== undefined) out[i] = hit;
    else {
      missing.push(t);
      missingIdx.push(i);
    }
  });

  // Memory misses may still be on disk: a previous worker lifetime, or the
  // other context (background vs offscreen), could have written them.
  if (missing.length > 0) {
    const stored = await readDisk();
    const nextMissing: string[] = [];
    const nextMissingIdx: number[] = [];
    missing.forEach((t, j) => {
      const idx = missingIdx[j]!;
      const hit = stored[keyOf(t)];
      if (hit !== undefined) {
        out[idx] = hit;
        mem.set(keyOf(t), hit);
      } else {
        nextMissing.push(t);
        nextMissingIdx.push(idx);
      }
    });
    missing = nextMissing;
    missingIdx = nextMissingIdx;
  }

  const hits = texts.length - missing.length;

  if (missing.length > 0) {
    const translated = await translate(missing);
    const fresh = new Map<string, string>();
    translated.forEach((tr, j) => {
      const idx = missingIdx[j];
      const src = missing[j];
      if (idx === undefined || src === undefined) return;
      out[idx] = tr;
      // Don't cache fallbacks where translation failed and returned the input.
      if (tr && tr !== src) fresh.set(keyOf(src), tr);
    });
    // Write through before returning — the worker may die right after this.
    await writeEntries(fresh);
    console.debug(`[cache] ${hits}/${texts.length} hits, stored ${fresh.size} new`);
  } else {
    console.debug(`[cache] ${hits}/${texts.length} hits, no model call`);
  }

  return out;
}
