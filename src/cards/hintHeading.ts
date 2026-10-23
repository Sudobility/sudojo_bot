/**
 * Per-step hint headings.
 *
 * Every step key the solver emits (`hints.hiddenSingle.row.scan`) has a short
 * English heading at the same path in the `headings` namespace
 * (`src/i18n/locales/en.headings.json`, a copy of the `headings` tree in
 * sudojo_app's `public/locales/en/hints.json`). The heading is interpolated
 * with the step's own values: values[0] → {{value1}}, values[1] → {{value2}}.
 */

import type { LocalizedHint, SolverHintStep } from '@sudobility/sudojo_types';
import i18next, { HEADINGS_NS, t } from '../i18n/index.js';

const STEP_KEY_PREFIX = 'hints.';

/** Read a step's text localization, tolerating the legacy flat shape. */
function textLocalization(step: SolverHintStep): LocalizedHint | undefined {
  const loc = step.localization as
    { text?: LocalizedHint; title?: LocalizedHint } | Partial<LocalizedHint> | undefined;
  if (!loc) return undefined;
  if ('text' in loc && loc.text?.stringKey) return loc.text;
  if ('stringKey' in loc && loc.stringKey) {
    return { stringKey: loc.stringKey, values: loc.values ?? [] };
  }
  return undefined;
}

/**
 * English heading for ONE hint step, or '' when the step has no `hints.*` key
 * or its key has no heading (never a raw key).
 */
export function getStepHeading(step: SolverHintStep | null | undefined): string {
  if (!step) return '';
  const loc = textLocalization(step);
  if (!loc?.stringKey.startsWith(STEP_KEY_PREFIX)) return '';
  const key = loc.stringKey.slice(STEP_KEY_PREFIX.length);
  // Only leaf strings count; a missing key or a subtree has no heading.
  const template: unknown = i18next.getResource('en', HEADINGS_NS, key);
  if (typeof template !== 'string') return '';
  // Pass every {{valueN}} the heading uses. A value the step lacks becomes ''
  // (i18next would otherwise leave the raw placeholder in the card).
  const values = loc.values ?? [];
  const vars: Record<string, string> = {};
  for (const [, n] of template.matchAll(/\{\{\s*value(\d+)\s*\}\}/g)) {
    vars[`value${n}`] = values[Number(n) - 1] ?? '';
  }
  return t(key, { ns: HEADINGS_NS, ...vars });
}
