/**
 * The glyph of every destination and group in `destinations.ts`. Keyed by the
 * registry's own key types, so a destination added there without a glyph here
 * does not compile. (Bloom's icons cannot load under `bun test`, which is why
 * the registry itself carries none.)
 */

import { RiAlarmWarningLine } from '@oxy.so/bloom/icons/RiAlarmWarningLine';
import { RiArrowLeftRightLine } from '@oxy.so/bloom/icons/RiArrowLeftRightLine';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiBankLine } from '@oxy.so/bloom/icons/RiBankLine';
import { RiBarChartBoxLine } from '@oxy.so/bloom/icons/RiBarChartBoxLine';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { RiCalendarScheduleLine } from '@oxy.so/bloom/icons/RiCalendarScheduleLine';
import { RiCommunityLine } from '@oxy.so/bloom/icons/RiCommunityLine';
import { RiEqualizerLine } from '@oxy.so/bloom/icons/RiEqualizerLine';
import { RiFileList3Line } from '@oxy.so/bloom/icons/RiFileList3Line';
import { RiHandHeartLine } from '@oxy.so/bloom/icons/RiHandHeartLine';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiLinksLine } from '@oxy.so/bloom/icons/RiLinksLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiRepeatLine } from '@oxy.so/bloom/icons/RiRepeatLine';
import { RiReceiptLine } from '@oxy.so/bloom/icons/RiReceiptLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { RiTerminalBoxLine } from '@oxy.so/bloom/icons/RiTerminalBoxLine';
import { RiWallet3Line } from '@oxy.so/bloom/icons/RiWallet3Line';
import type { OrbitDestinationKey, OrbitNavGroupKey } from './destinations';

/** A Remix glyph as Bloom ships it: what the sidebar AND the command palette both accept. */
export type OrbitGlyph = typeof RiHome5Line;

export const ORBIT_ICONS: Record<OrbitDestinationKey | OrbitNavGroupKey, OrbitGlyph> = {
  home: RiHome5Line,
  balances: RiWallet3Line,
  payouts: RiBankLine,
  payments: RiArrowLeftRightLine,
  customers: RiGroupLine,
  products: RiBox3Line,
  disputes: RiAlarmWarningLine,
  links: RiLinksLine,
  subscriptions: RiRepeatLine,
  invoices: RiFileList3Line,
  'billing-settings': RiEqualizerLine,
  connect: RiCommunityLine,
  reports: RiBarChartBoxLine,
  tax: RiReceiptLine,
  contributions: RiHandHeartLine,
  account: RiStore2Line,
  branding: RiPaletteLine,
  developers: RiTerminalBoxLine,
  settings: RiSettings3Line,
  'payments-group': RiBankCardLine,
  billing: RiCalendarScheduleLine,
};

export function orbitIcon(key: string): OrbitGlyph {
  return ORBIT_ICONS[key as keyof typeof ORBIT_ICONS] ?? RiHome5Line;
}
