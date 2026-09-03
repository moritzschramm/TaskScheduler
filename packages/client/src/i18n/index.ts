import { computed, type ComputedRef } from 'vue';
import { displayLocale } from '@/lib/session';
import { en } from './en';
import { de } from './de';

/**
 * The interface in the reader's language (spec §13).
 *
 * §13 already made locale a user setting, but only for *formatting* — dates,
 * times, the first day of the week. Every word on screen was English, which
 * meant a German user could set `de-DE`, get German dates, and read English
 * around them. This closes that half.
 *
 * **Derived from the locale rather than set beside it.** A second "language"
 * setting next to "language and formats" would be two controls for one idea,
 * and the first thing anyone would do is set them differently. So the locale
 * decides both: `de-*` gives a German interface, anything else English. The
 * setting is already "use my browser's" by default, which is exactly the
 * requirement — the browser's preferred language, falling back to English.
 *
 * **Hand-rolled rather than vue-i18n.** Two languages, both with the trivial
 * plural rule (one, or not one), no gendered forms and no message syntax beyond
 * named substitution. The library solves problems this application does not
 * have, at a cost — a message compiler and a runtime — that the bundle has just
 * been trimmed to avoid. If a third language arrives, or one needing real
 * plural categories (Polish, Russian, Arabic), this should be replaced rather
 * than extended: `t` is the only surface the rest of the app touches, so that
 * swap is contained.
 */

export type Language = 'en' | 'de';

/** The catalogues, keyed by the language tag their keys are written for. */
const catalogues: Record<Language, Messages> = { en, de };

/**
 * The message tree, taken from English.
 *
 * German is checked *against* this type, so a key added to one and forgotten in
 * the other is a compile error rather than a word that silently comes out in
 * the wrong language. English is the source of truth because it is the language
 * the keys are named in.
 */
export type Messages = typeof en;

/** Every message key, as a dotted path — `tasks.title`, `calendar.blockDay`. */
export type MessageKey = Paths<Messages>;

/**
 * The keys `plural` takes: the stems that have `one` and `other` beneath them.
 *
 * Derived from the `.one` leaves rather than listed, so a new counted message
 * becomes available to `plural` by existing, and a stem with no plural forms
 * cannot be passed to it by mistake.
 */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Stem}.one` ? Stem : never;
}[MessageKey];

type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`;
}[keyof T & string];

/** What a message can be given to substitute into `{name}` placeholders. */
export type Params = Record<string, string | number>;

/**
 * The language in force, from the locale in force.
 *
 * `de-AT` and `de-CH` are German too — the region decides how a date is
 * written, not which words the interface uses — so the match is on the primary
 * subtag alone.
 */
export function languageOf(locale: string): Language {
  return locale.toLowerCase().startsWith('de') ? 'de' : 'en';
}

/** The current language, reactive to the setting and to signing in and out. */
export const language: ComputedRef<Language> = computed(() => languageOf(displayLocale()));

/**
 * Looks a message up, substituting `{named}` parameters.
 *
 * A missing key returns the key itself rather than an empty string or a throw.
 * An empty string is an invisible failure — a button with no label — and a
 * throw takes down a screen over a caption; the key is ugly, obvious, and
 * greppable, which is what you want from something that should never happen and
 * is checked at compile time anyway.
 */
export function translate(lang: Language, key: MessageKey, params?: Params): string {
  const message = resolve(catalogues[lang], key) ?? resolve(catalogues.en, key);
  if (message === undefined) return key;

  return params === undefined
    ? message
    : message.replaceAll(/\{(\w+)\}/g, (whole, name: string) =>
        name in params ? String(params[name]) : whole,
      );
}

function resolve(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * The translator a component uses.
 *
 * Returned as a plain function that reads a computed, so a template calling
 * `t('...')` re-renders when the language changes — the same way it re-renders
 * when any other reactive value it reads does. There is no plugin, no
 * `app.use`, and nothing to install in a test: mounting a component is enough.
 */
export function useI18n(): {
  t: (key: MessageKey, params?: Params) => string;
  plural: (key: PluralKey, count: number, params?: Params) => string;
  language: ComputedRef<Language>;
} {
  const t = (key: MessageKey, params?: Params): string => translate(language.value, key, params);

  /**
   * Picks `<key>.one` or `<key>.other` on the count, and passes it in.
   *
   * Both languages here distinguish exactly one from everything else, including
   * zero — "0 Aufgaben", "0 tasks" — which is the rule for English and German
   * alike. It is *not* the rule everywhere, which is the note in the class
   * comment about when to reach for a real library instead.
   */
  const plural = (key: PluralKey, count: number, params?: Params): string =>
    translate(language.value, `${key}.${count === 1 ? 'one' : 'other'}` as MessageKey, {
      count,
      ...params,
    });

  return { t, plural, language };
}
