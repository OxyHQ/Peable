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
import { RiBuilding2Line } from '@oxy.so/bloom/icons/RiBuilding2Line';
import { RiCalendarEventLine } from '@oxy.so/bloom/icons/RiCalendarEventLine';
import { RiCalendarScheduleLine } from '@oxy.so/bloom/icons/RiCalendarScheduleLine';
import { RiCoinsLine } from '@oxy.so/bloom/icons/RiCoinsLine';
import { RiDashboardLine } from '@oxy.so/bloom/icons/RiDashboardLine';
import { RiDraftLine } from '@oxy.so/bloom/icons/RiDraftLine';
import { RiEyeLine } from '@oxy.so/bloom/icons/RiEyeLine';
import { RiFolder3Line } from '@oxy.so/bloom/icons/RiFolder3Line';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { RiQuestionLine } from '@oxy.so/bloom/icons/RiQuestionLine';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
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
import { RiShieldUserLine } from '@oxy.so/bloom/icons/RiShieldUserLine';
import { RiSmartphoneLine } from '@oxy.so/bloom/icons/RiSmartphoneLine';
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
  radar: RiShieldLine,
  reviews: RiEyeLine,
  links: RiLinksLine,
  terminal: RiSmartphoneLine,
  subscriptions: RiRepeatLine,
  invoices: RiFileList3Line,
  quotes: RiDraftLine,
  'billing-settings': RiEqualizerLine,
  connect: RiCommunityLine,
  reports: RiBarChartBoxLine,
  tax: RiDashboardLine,
  'tax-business': RiBuilding2Line,
  'tax-registrations': RiShieldCheckLine,
  'tax-documents': RiFolder3Line,
  'tax-review': RiQuestionLine,
  'tax-deadlines': RiCalendarEventLine,
  'tax-history': RiHistoryLine,
  'tax-collection': RiCoinsLine,
  contributions: RiHandHeartLine,
  account: RiStore2Line,
  identity: RiShieldUserLine,
  branding: RiPaletteLine,
  developers: RiTerminalBoxLine,
  settings: RiSettings3Line,
  'payments-group': RiBankCardLine,
  billing: RiCalendarScheduleLine,
  'tax-group': RiReceiptLine,
};

export function orbitIcon(key: string): OrbitGlyph {
  return ORBIT_ICONS[key as keyof typeof ORBIT_ICONS] ?? RiHome5Line;
}
