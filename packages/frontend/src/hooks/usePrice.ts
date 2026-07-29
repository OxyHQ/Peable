/**
 * The single way a component reads the FAIR price.
 *
 * The price cache lives outside React, so reading it directly during render is
 * invisible to the renderer — and with the React Compiler enabled that read
 * gets memoised and frozen at its first value. Subscribing makes it reactive,
 * and holding the polling reference here means any screen that shows a price
 * keeps it fresh, instead of depending on another screen being focused.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  acquirePricePolling,
  getCachedPrice,
  subscribeToPrice,
  type PriceData,
} from "../services/price";

export function usePrice(): PriceData | null {
  useEffect(() => acquirePricePolling(), []);
  return useSyncExternalStore(
    subscribeToPrice,
    getCachedPrice,
    getCachedPrice,
  );
}
