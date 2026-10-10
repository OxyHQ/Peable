/**
 * Crypto polyfill for React Native - runs before ANY module evaluation.
 *
 * This file is loaded by Metro as a setup module (via metro.config.js serializer)
 * which means it executes before the bundle's module system evaluates any imports.
 *
 * This is critical because @noble/hashes/crypto.js captures globalThis.crypto
 * at module evaluation time. If crypto doesn't exist then, it's permanently undefined.
 */

import { getRandomValues } from 'expo-crypto';

if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues },
    writable: true,
    configurable: true,
    enumerable: true,
  });
} else if (typeof globalThis.crypto.getRandomValues !== 'function') {
  const existing = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: Object.assign(existing, { getRandomValues }),
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
