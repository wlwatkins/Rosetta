import { browser } from 'wxt/browser';

export interface Settings {
  targetLang: string;
  /**
   * Auto-translate any page detected as this language, on every site.
   * Holds a LANGUAGES code ('HE'), or '' when the rule is off.
   */
  autoSourceLang: string;
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'EN',
  autoSourceLang: '',
};

export async function loadSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ settings });
}
