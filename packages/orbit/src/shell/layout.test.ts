import { describe, expect, it } from 'bun:test';
import {
  isCompactTopBar,
  SIDEBAR_EXPANDED_FROM,
  SIDEBAR_IN_FLOW_FROM,
  shellLayout,
} from './layout';
import { modifierLabel, shellShortcutFor, type ShortcutKeyEvent } from './shortcuts';

describe('shellLayout', () => {
  it('is a drawer on a phone, never collapsed, whatever was remembered', () => {
    for (const width of [320, 390, SIDEBAR_IN_FLOW_FROM - 1]) {
      expect(shellLayout(width, true)).toEqual({
        presentation: 'drawer',
        collapsed: false,
        collapseDisabled: true,
      });
    }
  });

  it('is an icon rail on a tablet, where the width decides', () => {
    for (const width of [SIDEBAR_IN_FLOW_FROM, 900, SIDEBAR_EXPANDED_FROM - 1]) {
      expect(shellLayout(width, false)).toEqual({
        presentation: 'rail',
        collapsed: true,
        collapseDisabled: true,
      });
    }
  });

  it('is the full panel on a desktop, unless the person collapsed it', () => {
    expect(shellLayout(SIDEBAR_EXPANDED_FROM, false)).toEqual({
      presentation: 'panel',
      collapsed: false,
      collapseDisabled: false,
    });
    expect(shellLayout(1440, true).collapsed).toBe(true);
  });
});

describe('isCompactTopBar', () => {
  it('compacts the top bar at phone widths only', () => {
    expect(isCompactTopBar(375)).toBe(true);
    expect(isCompactTopBar(768)).toBe(false);
  });
});

const key = (over: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({
  key: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('shellShortcutFor', () => {
  it('opens the palette on Mod+K, typing or not', () => {
    expect(shellShortcutFor(key({ key: 'k', metaKey: true }), true)).toBe('palette');
    expect(shellShortcutFor(key({ key: 'K', ctrlKey: true }), false)).toBe('palette');
  });

  it('opens the search on / only while not typing', () => {
    expect(shellShortcutFor(key({ key: '/' }), false)).toBe('search');
    expect(shellShortcutFor(key({ key: '/' }), true)).toBeNull();
  });

  it('toggles the sidebar on Mod+\\', () => {
    expect(shellShortcutFor(key({ key: '\\', ctrlKey: true }), false)).toBe('sidebar');
  });

  it('leaves every other chord to the browser', () => {
    expect(shellShortcutFor(key({ key: 'k' }), false)).toBeNull();
    expect(shellShortcutFor(key({ key: 'k', metaKey: true, shiftKey: true }), false)).toBeNull();
    expect(shellShortcutFor(key({ key: 'p', metaKey: true }), false)).toBeNull();
  });

  it('spells the modifier as the platform does', () => {
    expect(modifierLabel('MacIntel')).toBe('⌘');
    expect(modifierLabel('Win32')).toBe('Ctrl');
    expect(modifierLabel(undefined)).toBe('Ctrl');
  });
});
