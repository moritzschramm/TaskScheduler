import { computed, ref, type ComputedRef, type Ref } from 'vue';

/**
 * Which surface the application is drawn on (spec §13).
 *
 * **Kept in this browser, not on the user.** Every other display setting —
 * locale, time zone, first day of week — is a fact about the person and travels
 * with their account, which is why those three are a command and this is not.
 * Dark mode is a fact about the *screen*: the same person wants light on an
 * office monitor at eleven and dark on a laptop at eleven at night, and a
 * preference synced between them would be wrong on one of the two by
 * construction. It joins the day range, the row height and the visible weekdays
 * in `workspace.ts` — the settings that answer "make this readable here".
 *
 * There is a second reason, and it decides the matter on its own: this has to
 * work with no session. The sign-in page, the reset-password page and the first
 * paint of every reload happen before `/api/me` has answered, and a theme that
 * arrives with the session is a white flash on every one of them.
 *
 * **Three states, not two.** "System" is the default and a real choice rather
 * than the absence of one: it is the only setting that keeps following the
 * operating system's own schedule, which is how most people actually get dark
 * mode at dusk. Choosing light or dark is choosing to stop following it.
 */

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** What is actually drawn, once "system" has been resolved. */
export type Surface = 'light' | 'dark';

/**
 * Shared with the inline script in `index.html`, which cannot import it.
 *
 * That duplication is deliberate and is the price of a first paint on the right
 * surface: a module runs after the document has been painted at least once, so
 * reading this here and only here means a dark-mode user watches their
 * application flash white on every reload. **Both sides must change together.**
 */
const KEY = 'ambitime.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

export function readStoredTheme(): ThemeChoice {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return isThemeChoice(raw) ? raw : 'system';
  } catch {
    // Private browsing, or storage switched off. Following the system is the
    // right answer for somebody whose choice cannot be remembered anyway.
    return 'system';
  }
}

/**
 * What the operating system is asking for, right now.
 *
 * Guarded because `matchMedia` is not everywhere: jsdom has had it only
 * recently, and a test environment without it must not take the application
 * down on import. Absent, the answer is light — the same default a browser that
 * has never heard of the query gives.
 */
function systemQuery(): MediaQueryList | null {
  try {
    return globalThis.matchMedia?.(DARK_QUERY) ?? null;
  } catch {
    return null;
  }
}

const choice = ref<ThemeChoice>(readStoredTheme());
const systemSurface = ref<Surface>(systemQuery()?.matches === true ? 'dark' : 'light');

const surface = computed<Surface>(() =>
  choice.value === 'system' ? systemSurface.value : choice.value,
);

/**
 * The class the stylesheet keys off (`@custom-variant dark`), on `<html>`.
 *
 * On the root element rather than on the shell, because portals render at the
 * end of `body` and a variant scoped to a component would leave every dropdown,
 * dialog and toast on the other surface.
 */
function paint(): void {
  globalThis.document?.documentElement.classList.toggle('dark', surface.value === 'dark');
}

export function setTheme(next: ThemeChoice): void {
  choice.value = next;
  paint();

  try {
    globalThis.localStorage?.setItem(KEY, next);
  } catch {
    // Same as the day range: it applies to this tab either way.
  }
}

/**
 * The header's gesture: flip whatever is on screen to the other one.
 *
 * Deliberately lands on an explicit choice rather than cycling back through
 * "system". A person reaching for this button wants the other surface *now*;
 * three states under one button means the second press of two is a coin toss.
 * Following the system again is a decision, and decisions live in settings.
 */
export function toggleTheme(): void {
  setTheme(surface.value === 'dark' ? 'light' : 'dark');
}

/**
 * Starts following the system, and paints once.
 *
 * Called from the app root rather than at import, so that a test importing this
 * module does not acquire a listener it never asked for. Idempotent: mounting
 * twice attaches one listener, because the second call finds the first still
 * attached — and the shell does mount twice, once per sign-in without a reload.
 *
 * The pair is kept rather than the flag alone so that `resetTheme` can actually
 * undo this. A boolean would leave the listener on a query object the test that
 * attached it has already thrown away, and the next one would silently get no
 * listener at all.
 */
let attached: { query: MediaQueryList; listener: (event: MediaQueryListEvent) => void } | null =
  null;

export function startTheme(): void {
  paint();
  if (attached !== null) return;

  const query = systemQuery();
  if (query === null) return;

  const listener = (event: MediaQueryListEvent): void => {
    systemSurface.value = event.matches ? 'dark' : 'light';
    // Only moves the screen while the choice is "system"; `surface` decides.
    paint();
  };

  query.addEventListener('change', listener);
  attached = { query, listener };
}

export function useTheme(): {
  theme: Ref<ThemeChoice>;
  surface: ComputedRef<Surface>;
} {
  return { theme: choice, surface };
}

/** Back to the default, for tests. Does not touch what is stored. */
export function resetTheme(): void {
  attached?.query.removeEventListener('change', attached.listener);
  attached = null;
  choice.value = 'system';
  systemSurface.value = 'light';
  paint();
}
