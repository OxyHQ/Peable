import { useAuth } from "@oxy.so/services";
import { useWalletStore } from "./wallet-store";
import { hasIdentityKeystore } from "./keystore";
import { decideWalletCapability, type WalletCapability } from "./capability";

/** The current host's {@link WalletCapability}. See `capability.ts`. */
export function useWalletCapability(): WalletCapability {
  const walletInitialized = useWalletStore((s) => s.initialized);
  const { isAuthResolved, isAuthenticated } = useAuth();
  return decideWalletCapability({
    walletInitialized,
    hasIdentityKeystore: hasIdentityKeystore(),
    isAuthResolved,
    isAuthenticated,
  });
}
