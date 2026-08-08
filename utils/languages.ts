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
