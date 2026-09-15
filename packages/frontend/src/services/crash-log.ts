/**
 * Crash capture for FAIRWallet.
 *
 * The app had no error boundary and no global handler: a throw during render
 * left a black screen with no recovery path and no record of what happened.
 * This module is the record-keeping half — `ErrorBoundary` is the recovery
 * half, and `crash-policy.ts` holds the pure redaction/trimming rules.
 *
 * Two sources feed it:
 *
 *  1. `ErrorBoundary.componentDidCatch` — render/lifecycle throws.
 *  2. `ErrorUtils.setGlobalHandler` — everything else on the JS thread
 *     (uncaught promise rejections surfaced by the runtime, native-module
 *     callbacks, timers). The previous handler is always chained so the red
 *     box still appears in development.
 */

import { getItemAsync, setItemAsync, deleteItemAsync } from "../storage/kv-store";
import {
  appendCrashEntry,
  toCrashEntry,
  type CrashEntry,
} from "./crash-policy";

const CRASH_LOG_KEY = "fairwallet_crash_log";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function parseCrashLog(raw: string | null): CrashEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CrashEntry => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as Partial<CrashEntry>;
      return (
        typeof candidate.at === "number" &&
        typeof candidate.name === "string" &&
        typeof candidate.message === "string"
      );
    });
  } catch {
    // A corrupt log must never block the app or the next crash write.
    return [];
  }
}

export async function getCrashLog(): Promise<CrashEntry[]> {
  return parseCrashLog(await getItemAsync(CRASH_LOG_KEY));
}

export async function clearCrashLog(): Promise<void> {
  await deleteItemAsync(CRASH_LOG_KEY);
}

/**
 * Record a crash. Never throws: it runs from an error path, so a storage
 * failure here must not mask the original error.
 */
export async function recordCrash(
  error: unknown,
  fatal: boolean,
): Promise<void> {
  try {
    const entry = toCrashEntry(error, fatal, Math.floor(Date.now() / 1000));
    const existing = await getCrashLog();
    await setItemAsync(
      CRASH_LOG_KEY,
      JSON.stringify(appendCrashEntry(existing, entry)),
    );
  } catch {
    // Best effort by design.
  }
}

// ---------------------------------------------------------------------------
// Global handler
// ---------------------------------------------------------------------------

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface GlobalErrorUtils {
  setGlobalHandler(callback: ErrorHandler): void;
  getGlobalHandler(): ErrorHandler | undefined;
}

/** React Native installs `ErrorUtils` on the global object; web has none. */
function getErrorUtils(): GlobalErrorUtils | null {
  const holder = globalThis as { ErrorUtils?: GlobalErrorUtils };
  return holder.ErrorUtils ?? null;
}

let installed = false;

/**
 * Install the global JS error handler. Idempotent, and a no-op on platforms
 * that do not expose `ErrorUtils` (web / Electron renderer).
 */
export function installCrashHandler(): void {
  if (installed) return;
  const errorUtils = getErrorUtils();
  if (!errorUtils) return;
  installed = true;

  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    void recordCrash(error, isFatal ?? true);
    // Chain so the dev red box / default fatal handling still happens.
    previous?.(error, isFatal);
  });
}
