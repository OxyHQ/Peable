/**
 * Platform-agnostic key-value storage adapter.
 *
 * On native (iOS/Android), uses expo-secure-store (Keychain /
 * EncryptedSharedPreferences).
 *
 * On web/Electron, uses `localStorage` for the at-rest container. Under
 * Electron the renderer's preload bridge exposes the OS keychain via
 * `window.electronAPI.secure` (safeStorage); when that bridge reports
 * encryption as available, values are encrypted with it BEFORE being written to
 * `localStorage` and decrypted on read. In a plain browser (or an Electron
 * build where the OS keychain is unavailable) there is no such facility, so
 * values are stored as plaintext and a one-time runtime warning is emitted —
 * the JSDoc does not claim encryption that isn't happening.
 *
 * This module is the ONLY place that directly imports expo-secure-store.
 * All other modules use this adapter instead.
 */

import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Native adapter (iOS / Android)
// ---------------------------------------------------------------------------

function createNativeAdapter(): StorageAdapter {
  // Dynamic import to avoid web bundling issues
  const SecureStore = require('expo-secure-store') as typeof import('expo-secure-store');
  return {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    deleteItem: (key) => SecureStore.deleteItemAsync(key),
  };
}

// ---------------------------------------------------------------------------
// Electron safeStorage bridge (exposed by electron/preload.js)
// ---------------------------------------------------------------------------

/**
 * The secure-storage surface the Electron preload bridge exposes on
 * `window.electronAPI.secure`. `encrypt` returns OS-keychain-protected bytes
 * for the given plaintext; `decrypt` reverses it; `isAvailable` reports whether
 * the OS actually provides encryption (false on some Linux setups).
 */
interface ElectronSecureBridge {
  encrypt(plaintext: string): Promise<Uint8Array>;
  decrypt(encrypted: Uint8Array): Promise<string>;
  isAvailable(): Promise<boolean>;
}

function getElectronSecure(): ElectronSecureBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const win = window as unknown as Record<string, unknown>;
  const api = win.electronAPI as { secure?: ElectronSecureBridge } | undefined;
  if (api?.secure == null) return undefined;
  return api.secure;
}

// Values encrypted via the Electron bridge are stored as this marker followed
// by the base64 of the ciphertext, so reads can tell an encrypted entry from a
// legacy/plaintext one and migrate transparently.
const ENC_PREFIX = 'enc:v1:';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Web adapter (Electron / Browser)
// ---------------------------------------------------------------------------

let warnedUnencrypted = false;

/**
 * Warn exactly once that values are being persisted without encryption, so the
 * unencrypted-storage fact is visible without spamming the console on every
 * write. Used only on the plaintext fallback path.
 */
function warnUnencryptedOnce(): void {
  if (warnedUnencrypted) return;
  warnedUnencrypted = true;
  console.warn(
    '[kv-store] Persisting wallet data UNENCRYPTED in localStorage: the ' +
      'Electron safeStorage bridge is unavailable (plain browser, or OS ' +
      'keychain not available). Sensitive data is not protected at rest.',
  );
}

function createWebAdapter(): StorageAdapter {
  const secure = getElectronSecure();

  // Whether the Electron bridge can actually encrypt. Resolved lazily and
  // cached: the answer is stable for the lifetime of the process.
  let encryptionAvailable: Promise<boolean> | null = null;
  function isEncryptionAvailable(): Promise<boolean> {
    if (!secure) return Promise.resolve(false);
    if (!encryptionAvailable) {
      encryptionAvailable = secure.isAvailable().catch(() => false);
    }
    return encryptionAvailable;
  }

  return {
    getItem: async (key) => {
      let raw: string | null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        // localStorage may throw in private browsing mode or when storage quota
        // is exceeded. Return null as if the key doesn't exist.
        return null;
      }
      if (raw === null) return null;

      // A value written by the encrypted path carries the marker. Decrypt it via
      // the bridge; anything else is a legacy/plaintext value, returned as-is.
      if (raw.startsWith(ENC_PREFIX) && secure) {
        try {
          const cipher = base64ToBytes(raw.slice(ENC_PREFIX.length));
          return await secure.decrypt(cipher);
        } catch {
          // The bridge could not decrypt (e.g. keychain changed). Surface "no
          // value" rather than returning the ciphertext marker as plaintext.
          return null;
        }
      }
      return raw;
    },

    setItem: async (key, value) => {
      if (await isEncryptionAvailable()) {
        // `secure` is non-null whenever isEncryptionAvailable() resolves true.
        const bridge = secure;
        if (bridge) {
          const cipher = await bridge.encrypt(value);
          localStorage.setItem(key, `${ENC_PREFIX}${bytesToBase64(cipher)}`);
          return;
        }
      }
      warnUnencryptedOnce();
      localStorage.setItem(key, value);
    },

    deleteItem: async (key) => {
      localStorage.removeItem(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton adapter based on platform
// ---------------------------------------------------------------------------

let _adapter: StorageAdapter | null = null;

function getAdapter(): StorageAdapter {
  if (_adapter) return _adapter;
  _adapter = Platform.OS === 'web' ? createWebAdapter() : createNativeAdapter();
  return _adapter;
}

// ---------------------------------------------------------------------------
// Public API (matches expo-secure-store interface)
// ---------------------------------------------------------------------------

export async function getItemAsync(key: string): Promise<string | null> {
  return getAdapter().getItem(key);
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  return getAdapter().setItem(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  return getAdapter().deleteItem(key);
}
