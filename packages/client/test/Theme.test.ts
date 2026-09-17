import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeToggle from '@/components/ThemeToggle.vue';
import {
  readStoredTheme,
  resetTheme,
  setTheme,
  startTheme,
  toggleTheme,
  useTheme,
} from '@/lib/theme';

/**
 * Light and dark (spec §13).
 *
 * The rules worth pinning are the three that would be invisible until somebody
 * complained: that "follow my system" keeps following it, that a choice is
 * remembered in *this* browser rather than on the account, and that the class
 * everything is drawn against lands on the document root — because a variant
 * scoped any lower leaves every portalled dropdown on the other surface.
 */

/** A `matchMedia` whose answer the test controls, and can change. */
function system(dark: boolean) {
  const listeners: ((event: MediaQueryListEvent) => void)[] = [];

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.push(listener),
    removeEventListener: () => {},
  }));

  return {
    /** The operating system going dark under a tab that is already open. */
    change(next: boolean) {
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
    get watchers() {
      return listeners.length;
    },
  };
}

const isDark = () => document.documentElement.classList.contains('dark');

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  resetTheme();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('choosing a surface', () => {
  it('follows the system until somebody says otherwise', () => {
    expect(readStoredTheme()).toBe('system');
  });

  it('paints the root element, not the shell', () => {
    // Reka portals its menus and dialogs to the end of `body`, outside every
    // component. A `.dark` anywhere below `<html>` would leave them light.
    setTheme('dark');
    expect(isDark()).toBe(true);

    setTheme('light');
    expect(isDark()).toBe(false);
  });

  it('remembers the choice in this browser', () => {
    setTheme('dark');
    expect(localStorage.getItem('ambitime.theme')).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('ignores a stored value that is not a surface', () => {
    // Hand-edited, or left by a version that spelled it differently.
    localStorage.setItem('ambitime.theme', 'midnight');
    expect(readStoredTheme()).toBe('system');
  });
});

describe('following the system', () => {
  it('paints on start, so nothing can leave the class behind', () => {
    // `index.html` painted the first frame; this is the one the application
    // owns. If the two disagreed, a reload would look different from a
    // navigation, which is the kind of bug nobody can reproduce on demand.
    system(false);
    setTheme('dark');
    document.documentElement.classList.remove('dark');

    startTheme();

    expect(isDark()).toBe(true);
  });

  it('moves with the system when the choice is to follow it', () => {
    const os = system(false);
    startTheme();
    setTheme('system');

    os.change(true);

    expect(useTheme().surface.value).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('stays put once somebody has chosen', () => {
    const os = system(false);
    startTheme();
    setTheme('light');

    // Dusk arrives. Somebody who asked for light asked for light.
    os.change(true);

    expect(useTheme().surface.value).toBe('light');
    expect(isDark()).toBe(false);
  });

  it('survives a second mount without collecting a second listener', () => {
    // The shell mounts again on every sign-in that does not reload the page.
    const os = system(false);
    startTheme();
    startTheme();

    expect(os.watchers).toBe(1);
  });
});

describe('the header button', () => {
  it('offers the other surface rather than naming this one', () => {
    // An icon that labels where you already are tells nobody what will happen.
    setTheme('light');
    const wrapper = mount(ThemeToggle);

    expect(wrapper.attributes('aria-label')).toBe('Switch to the dark theme');
    expect(wrapper.attributes('data-surface')).toBe('light');
  });

  it('flips what is on screen, and lands on a choice', async () => {
    setTheme('system');
    const wrapper = mount(ThemeToggle);

    await wrapper.trigger('click');

    // Not back to 'system' — the second press of two should not be a coin toss.
    expect(readStoredTheme()).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('takes a dark screen back to light', async () => {
    setTheme('dark');
    const wrapper = mount(ThemeToggle);

    expect(wrapper.attributes('aria-label')).toBe('Switch to the light theme');
    await wrapper.trigger('click');

    expect(readStoredTheme()).toBe('light');
    expect(isDark()).toBe(false);
  });
});

describe('when the browser will not help', () => {
  it('comes up light rather than not at all', () => {
    // No `matchMedia` — an old browser, or a test environment. The application
    // has to render, and light is what a browser that never heard of the query
    // would have shown anyway.
    vi.stubGlobal('matchMedia', undefined);
    resetTheme();

    expect(() => startTheme()).not.toThrow();
    expect(useTheme().surface.value).toBe('light');
  });

  it('applies a choice it cannot store', () => {
    // Private browsing. The setting still has to work for this tab.
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(() => setTheme('dark')).not.toThrow();
    expect(isDark()).toBe(true);

    setItem.mockRestore();
  });
});

describe('what it is not', () => {
  it('is not sent to the server', async () => {
    // The other three display settings are an `UpdateSettings` command; this
    // one is a fact about the screen, not about the person. A theme that synced
    // would be wrong on one of somebody's two machines by construction.
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);

    toggleTheme();
    await Promise.resolve();

    expect(fetched).not.toHaveBeenCalled();
  });
});
