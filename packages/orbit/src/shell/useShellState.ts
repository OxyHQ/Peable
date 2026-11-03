import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useWindowKeys } from '@oxy.so/bloom/kbd';
import { shellShortcutFor, type ShellShortcut } from './shortcuts';

const COLLAPSED_KEY = 'orbit:sidebar-collapsed:v1';

/**
 * Whether the person collapsed the sidebar, remembered on this device. A
 * per-viewer convenience: an unreadable store reads as expanded.
 */
export function usePersistedCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(COLLAPSED_KEY)
      .catch(() => null)
      .then((raw) => {
        if (active && raw === '1') setCollapsed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const update = useCallback((next: boolean) => {
    setCollapsed(next);
    AsyncStorage.setItem(COLLAPSED_KEY, next ? '1' : '0').catch(() => undefined);
  }, []);
  return [collapsed, update];
}

/**
 * Binds `shortcuts.ts`'s keys through Bloom's `useWindowKeys` (the window's
 * key source on every platform). Two listeners because the keys differ on
 * fields: Mod+K and Mod+\ work while typing, `/` never does — a slash in a
 * field is a slash. A key the first one takes goes no further.
 */
export function useShellShortcuts(onShortcut: (shortcut: ShellShortcut) => void): void {
  useWindowKeys(
    (event) => {
      const shortcut = shellShortcutFor(event, true);
      if (shortcut) onShortcut(shortcut);
      return shortcut !== null;
    },
    { whileTyping: true },
  );
  useWindowKeys((event) => {
    const shortcut = shellShortcutFor(event, false);
    if (shortcut) onShortcut(shortcut);
    return shortcut !== null;
  });
}
