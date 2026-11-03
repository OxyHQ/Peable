/**
 * Orbit's app-wide keys. Pure: `useShellShortcuts` listens, this decides.
 *
 * - Mod+K (⌘K / Ctrl+K)  the command palette (pages and actions), from
 *                        anywhere — a text field included, as everywhere
 *                        else that key means it
 * - /                    the search over the application's objects (Stripe's
 *                        search key), but never while typing: a slash in a
 *                        field is a slash
 * - Mod+\                collapse or expand the sidebar
 */

export type ShellShortcut = 'palette' | 'search' | 'sidebar';

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function shellShortcutFor(event: ShortcutKeyEvent, typing: boolean): ShellShortcut | null {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && !event.altKey && !event.shiftKey) {
    const key = event.key.toLowerCase();
    if (key === 'k') return 'palette';
    if (key === '\\') return 'sidebar';
    return null;
  }
  if (!mod && !event.altKey && event.key === '/' && !typing) return 'search';
  return null;
}

/** The command modifier as the platform spells it. */
export function modifierLabel(platform: string | undefined): string {
  return platform && /mac|iphone|ipad|ipod/i.test(platform) ? '⌘' : 'Ctrl';
}
