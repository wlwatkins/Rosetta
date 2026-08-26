import { buildCachePrefix, withCache } from './cache';
import { isoFromCode, type Engine } from './languages';
import { opusCancel, opusTranslate } from './opus';

// In-flight requests, so a user cancel can abort them mid-request.
const activeControllers = new Set<AbortController>();

export function cancelActive(): void {
  for (const c of activeControllers) c.abort();
  activeControllers.clear();
  // The offline engine has no request to abort — it stops between sequences.
  opusCancel();
}

async function trackedFetch(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  activeControllers.add(controller);
  try {
    return await fetch(url, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Cancelled');
    }
    throw err;
  } finally {
    activeControllers.delete(controller);
  }
}

/**
 * Google's public translate endpoint — the one their own site and app use.
 * No API key; callers are identified by the `client` parameter and IP, so it
 * is rate-limited and undocumented. Failures are expected, not exceptional.
 */
async function translateGoogle(
  texts: string[],
  targetLang: string,
  srcIso: string,
): Promise<string[]> {
  const tl = isoFromCode(targetLang);
  // Auto-detect misfires on short strings ("נדל״ן" was read as English), so
  // pin the source language whenever the page gave us one.
  const sl = srcIso ? (srcIso === 'he' ? 'iw' : srcIso) : 'auto';
  const qs = texts.map((t) => `q=${encodeURIComponent(t)}`).join('&');
  const url =
    `https://translate.googleapis.com/translate_a/t?client=gtx&sl=${sl}&tl=${tl}&format=text&${qs}`;

  for (let attempt = 0; ; attempt++) {
    const res = await trackedFetch(url, 30_000);
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (res.status === 429) {
      throw new Error('Google is rate-limiting this IP. Wait a moment and try again.');
    }
    if (!res.ok) throw new Error(`Google translate returned ${res.status}.`);

    const data = await res.json();
    // One q -> ["translation","lang"]; many q -> [["translation","lang"], ...]
    const rows: unknown[] = texts.length === 1 ? [data] : data;
    return texts.map((t, i) => {
      const row = rows[i];
      if (Array.isArray(row) && typeof row[0] === 'string') return row[0];
      return typeof row === 'string' ? row : t;
    });
  }
}

export async function translateBatch(
  texts: string[],
  targetLang: string,
  srcIso = '',
  engine: Engine = 'google',
): Promise<string[]> {
  return withCache(buildCachePrefix(targetLang, engine), texts, (missing) =>
    engine === 'opus'
      ? // Runs in the offscreen document; nothing here touches the network.
        opusTranslate(missing)
      : translateGoogle(missing, targetLang, srcIso),
  );
}
