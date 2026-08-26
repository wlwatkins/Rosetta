// code: our internal target code. name: used in LLM prompts.
// iso: language code sent to Google Translate (legacy "iw" for Hebrew).
export const LANGUAGES = [
  { code: 'EN', name: 'English', iso: 'en' },
  { code: 'HE', name: 'Hebrew', iso: 'iw' },
  { code: 'CS', name: 'Czech', iso: 'cs' },
  { code: 'DE', name: 'German', iso: 'de' },
  { code: 'FR', name: 'French', iso: 'fr' },
  { code: 'ES', name: 'Spanish', iso: 'es' },
  { code: 'IT', name: 'Italian', iso: 'it' },
  { code: 'PL', name: 'Polish', iso: 'pl' },
  { code: 'NL', name: 'Dutch', iso: 'nl' },
  { code: 'PT-PT', name: 'Portuguese', iso: 'pt' },
  { code: 'JA', name: 'Japanese', iso: 'ja' },
  { code: 'ZH', name: 'Chinese (simplified)', iso: 'zh-CN' },
] as const;

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

export function isoFromCode(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.iso ?? code.toLowerCase();
}

/**
 * Compare language codes from different sources: Chrome's detector reports
 * Hebrew as "iw" or "he" and Chinese as "zh-CN"/"zh-Hans" depending on API.
 */
export function sameLanguage(a: string, b: string): boolean {
  const norm = (x: string) => {
    const s = x.toLowerCase().replace('_', '-');
    if (s === 'iw' || s.startsWith('he')) return 'he';
    if (s.startsWith('zh')) return 'zh';
    return s.split('-')[0]!;
  };
  return !!a && !!b && norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

export type Engine = 'google' | 'opus';

/**
 * What each engine can actually do. `null` means "no restriction" — Google
 * translates any pair in LANGUAGES. OPUS-MT is a single-pair Marian model:
 * Hebrew in, English out, and nothing else. Keeping that here means the popup
 * and the content script agree without either hard-coding 'HE'.
 */
export const ENGINES: {
  id: Engine;
  label: string;
  /** Offline engines say so in the UI; online ones warn about leaving the machine. */
  offline: boolean;
  sources: string[] | null;
  targets: string[] | null;
}[] = [
  {
    id: 'google',
    label: 'Google Translate (online)',
    offline: false,
    sources: null,
    targets: null,
  },
  {
    id: 'opus',
    label: 'OPUS-MT (offline)',
    offline: true,
    sources: ['he'],
    targets: ['EN'],
  },
];

export function engineInfo(engine: string) {
  return ENGINES.find((e) => e.id === engine) ?? ENGINES[0]!;
}

/** Target languages this engine can produce, in LANGUAGES order. */
export function engineTargets(engine: string) {
  const allowed = engineInfo(engine).targets;
  return allowed ? LANGUAGES.filter((l) => allowed.includes(l.code)) : [...LANGUAGES];
}

/** Source languages this engine accepts, in LANGUAGES order. */
export function engineSources(engine: string) {
  const allowed = engineInfo(engine).sources;
  return allowed
    ? LANGUAGES.filter((l) => allowed.some((iso) => sameLanguage(iso, l.iso)))
    : [...LANGUAGES];
}

/**
 * Can this engine translate this page? An empty `srcIso` means detection was
 * inconclusive — treated as acceptable, because refusing to translate a page
 * we merely failed to identify is worse than trying.
 */
export function engineAcceptsSource(engine: string, srcIso: string): boolean {
  const allowed = engineInfo(engine).sources;
  if (!allowed || !srcIso) return true;
  return allowed.some((iso) => sameLanguage(iso, srcIso));
}

export function engineAcceptsTarget(engine: string, targetCode: string): boolean {
  const allowed = engineInfo(engine).targets;
  return !allowed || allowed.includes(targetCode);
}
