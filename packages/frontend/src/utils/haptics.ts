/**
 * Haptic feedback utilities.
 * All functions are no-ops if the native module is unavailable.
 */

import { Platform } from 'react-native';

function isAvailable(): boolean {
  if (Platform.OS === 'web') return false;
  try {
    const mod = require('expo-haptics');
    return typeof mod?.selectionAsync === 'function';
  } catch {
    return false;
  }
}

const available = isAvailable();

function getHaptics(): typeof import('expo-haptics') | null {
  if (!available) return null;
  return require('expo-haptics');
}

export function hapticSelection(): void {
  try {
    getHaptics()?.selectionAsync();
  } catch {
    /* not linked */
  }
}

export function hapticSuccess(): void {
  try {
    const H = getHaptics();
    H?.notificationAsync(H.NotificationFeedbackType.Success);
  } catch {
    /* not linked */
  }
}

export function hapticError(): void {
  try {
    const H = getHaptics();
    H?.notificationAsync(H.NotificationFeedbackType.Error);
  } catch {
    /* not linked */
  }
}

export function hapticWarning(): void {
  try {
    const H = getHaptics();
    H?.notificationAsync(H.NotificationFeedbackType.Warning);
  } catch {
    /* not linked */
  }
}

export function hapticImpact(): void {
  try {
    const H = getHaptics();
    H?.impactAsync(H.ImpactFeedbackStyle.Medium);
  } catch {
    /* not linked */
  }
}
