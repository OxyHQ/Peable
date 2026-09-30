import { Platform } from "react-native";

/**
 * Whether this host can reach the on-device holder of the Oxy identity key
 * (iOS: the keychain group via `@oxy.so/core`'s KeyManager; Android: Commons,
 * over signature-protected IPC), and so can derive the identity wallet's seed
 * and sign. A browser has none.
 *
 * `Platform.OS` is the proxy for that one question. Keep it answered HERE so
 * the store's identity probe and the shell's capability gate cannot disagree.
 */
export function hasIdentityKeystore(): boolean {
  return Platform.OS !== "web";
}
