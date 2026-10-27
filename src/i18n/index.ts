/**
 * i18n setup using i18next
 * Provides translation functions for all user-facing strings
 */

import i18next from 'i18next';
import type { InitOptions } from 'i18next';
import en from './locales/en.json' with { type: 'json' };
// Per-step hint headings, synced from sudojo_app (`bun run sync:hint-headings`).
import enHeadings from './locales/en.headings.json' with { type: 'json' };

/** Namespace holding the per-step hint headings (see src/cards/hintHeading.ts). */
export const HEADINGS_NS = 'headings';

i18next.init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['translation', HEADINGS_NS],
  defaultNS: 'translation',
  interpolation: {
    escapeValue: false,
  },
  resources: {
    en: {
      translation: en,
      [HEADINGS_NS]: enHeadings,
    },
  },
} as InitOptions);

export const t = i18next.t.bind(i18next);
export default i18next;
