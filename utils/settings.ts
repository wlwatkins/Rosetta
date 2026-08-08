import { browser } from 'wxt/browser';

export interface Settings {
  targetLang: string;
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'EN',
};

export async function loadSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ settings });
}
