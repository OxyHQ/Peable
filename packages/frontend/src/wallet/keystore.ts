import { Platform } from "react-native";

/**
 * Whether this host has the on-device keystore the Oxy identity key lives in
 * (`@oxy.so/core` keyManager -> expo-secure-store), and so can derive the
 * identity wallet's seed and sign. A browser has none.
 *
 * `Platform.OS` is the proxy for that one question. Keep it answered HERE so
 * the store's identity probe and the shell's capability gate cannot disagree.
 */
export function hasIdentityKeystore(): boolean {
  return Platform.OS !== "web";
}
