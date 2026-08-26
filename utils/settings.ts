import { browser } from 'wxt/browser';
import { engineAcceptsTarget, engineTargets, type Engine } from './languages';

export interface Settings {
  /** Which backend translates: Google's endpoint, or the local OPUS-MT model. */
  engine: Engine;
  targetLang: string;
  /**
   * Auto-translate any page detected as this language, on every site.
   * Holds a LANGUAGES code ('HE'), or '' when the rule is off.
   */
  autoSourceLang: string;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'google',
  targetLang: 'EN',
  autoSourceLang: '',
};

/**
 * Force the settings into a shape the chosen engine can honour. OPUS-MT only
 * goes to English, so selecting it while the target is French has to move the
 * target rather than fail at translate time.
 */
export function reconcile(settings: Settings): Settings {
  if (engineAcceptsTarget(settings.engine, settings.targetLang)) return settings;
  const fallback = engineTargets(settings.engine)[0];
  return { ...settings, targetLang: fallback?.code ?? DEFAULT_SETTINGS.targetLang };
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  return reconcile({ ...DEFAULT_SETTINGS, ...(settings ?? {}) });
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ settings });
}
