/**
 * Pockets — BIP44 sub-accounts within a single FairCoin wallet.
 *
 * A Pocket is one BIP44 `account` index under the wallet's HD seed, giving it
 * its own address space, UTXO set, and SQLite database (see
 * `../storage/db-name.ts`). Account 0 is the implicit "main" Pocket every
 * wallet already has — pre-Pockets wallets need no migration.
 *
 * Kept pure (no expo-sqlite / storage imports) so it is unit-testable on its
 * own and safe to import from both `../storage/pockets-store.ts`
 * (persistence) and any UI layer.
 */

/** BIP44 account index of the implicit main Pocket every wallet has. */
export const MAIN_POCKET_ACCOUNT = 0;

/**
 * Fixed palette of Pocket accent colors (hex), matching the approved
 * Revolut-style Pockets design. `defaultColorFor` cycles through this list so
 * every Pocket — including ones created before this palette existed — always
 * resolves to one of these values.
 */
export const POCKET_COLORS = [
  "#0064b3", // blue (Main's default)
  "#12a46b", // emerald
  "#e29316", // amber
  "#6c5ce7", // violet
  "#e5588a", // rose
  "#0ea5a5", // teal
  "#f9897b", // coral
] as const;

/** Deterministic default color for a Pocket missing one (backward compat). */
function defaultColorFor(account: number): string {
  return POCKET_COLORS[account % POCKET_COLORS.length];
}

/** A Pocket's registry entry: name + presentation + creation metadata for a BIP44 account. */
export interface PocketInfo {
  /** BIP44 account index. 0 is the main Pocket and can never be deleted. */
  account: number;
  name: string;
  createdAt: number;
  /**
   * Optional image URI (photo library / camera) shown as the Pocket's circular
   * avatar. Omitted = fall back to the name's initial on the accent color.
   */
  image?: string;
  /** Hex accent color, normally one of {@link POCKET_COLORS}. */
  color: string;
  /** Optional target FAIR amount for a savings goal; omitted = no goal. */
  goal?: number;
}

/**
 * Normalize a Pocket registry: always includes the main Pocket (account 0,
 * synthesized if missing), drops duplicate account indices (first occurrence
 * wins), defaults `color` for any entry missing one and drops the legacy
 * `emoji` field (pre-image stored data), and sorts by account ascending so
 * callers get a stable order.
 */
export function normalizePockets(pockets: PocketInfo[]): PocketInfo[] {
  const byAccount = new Map<number, PocketInfo>();
  for (const pocket of pockets) {
    if (!Number.isInteger(pocket.account) || pocket.account < 0) continue;
    if (!byAccount.has(pocket.account)) {
      // Rebuilt field by field rather than spread so persisted entries written
      // before Pocket images existed shed their now-unknown `emoji` key.
      byAccount.set(pocket.account, {
        account: pocket.account,
        name: pocket.name,
        createdAt: pocket.createdAt,
        color: pocket.color ?? defaultColorFor(pocket.account),
        ...(pocket.image !== undefined ? { image: pocket.image } : {}),
        ...(pocket.goal !== undefined ? { goal: pocket.goal } : {}),
      });
    }
  }
  if (!byAccount.has(MAIN_POCKET_ACCOUNT)) {
    byAccount.set(MAIN_POCKET_ACCOUNT, {
      account: MAIN_POCKET_ACCOUNT,
      name: "Main",
      createdAt: 0,
      color: defaultColorFor(MAIN_POCKET_ACCOUNT),
    });
  }
  return Array.from(byAccount.values()).sort((a, b) => a.account - b.account);
}

/** The account index a newly-created Pocket should use: max(account) + 1. */
export function nextAccountIndex(list: PocketInfo[]): number {
  return list.reduce((max, p) => Math.max(max, p.account), 0) + 1;
}

/** Find a Pocket by account index. */
export function findPocket(
  list: PocketInfo[],
  account: number,
): PocketInfo | undefined {
  return list.find((p) => p.account === account);
}

/** Append a new Pocket at the next free account index. */
export function addPocket(
  list: PocketInfo[],
  name: string,
  image: string | undefined,
  color: string,
  goal: number | undefined,
  now: number,
): PocketInfo[] {
  const account = nextAccountIndex(list);
  return normalizePockets([
    ...list,
    { account, name, createdAt: now, color, image, goal },
  ]);
}

/** Rename the Pocket at `account`, leaving all other fields untouched. */
export function renamePocket(
  list: PocketInfo[],
  account: number,
  name: string,
): PocketInfo[] {
  return normalizePockets(
    list.map((p) => (p.account === account ? { ...p, name } : p)),
  );
}

/**
 * Update a Pocket's presentation metadata (image/color/goal), leaving all
 * other fields — including `name`, updated separately via {@link renamePocket}
 * — untouched. Any field omitted from `updates` is left unchanged; pass
 * `image: null` to clear a custom image (falling back to the name's initial)
 * or `goal: null` to explicitly clear an existing goal (vs. omitting either,
 * which leaves the current value as-is).
 */
export function updatePocketMeta(
  list: PocketInfo[],
  account: number,
  updates: { image?: string | null; color?: string; goal?: number | null },
): PocketInfo[] {
  return normalizePockets(
    list.map((p) => {
      if (p.account !== account) return p;
      const next: PocketInfo = { ...p };
      if (updates.image !== undefined) {
        if (updates.image === null) {
          delete next.image;
        } else {
          next.image = updates.image;
        }
      }
      if (updates.color !== undefined) next.color = updates.color;
      if (updates.goal !== undefined) {
        if (updates.goal === null) {
          delete next.goal;
        } else {
          next.goal = updates.goal;
        }
      }
      return next;
    }),
  );
}

/** Remove the Pocket at `account`. The main Pocket can never be removed. */
export function removePocket(
  list: PocketInfo[],
  account: number,
): PocketInfo[] {
  if (account === MAIN_POCKET_ACCOUNT) return normalizePockets(list);
  return normalizePockets(list.filter((p) => p.account !== account));
}

/** Whether a Pocket may be deleted: it exists and is not the main Pocket. */
export function canDeletePocket(list: PocketInfo[], account: number): boolean {
  return account !== MAIN_POCKET_ACCOUNT && findPocket(list, account) !== undefined;
}
