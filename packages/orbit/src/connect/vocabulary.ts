import type {
  ConnectedAccountRail,
  TransferReversalStatus,
  TransferStatus,
} from '@peable.to/shared-types';
import { labelFor } from '../i18n';
import type { StatusTone } from '../payments/status';
import type { SellerReadiness } from './forms';

/** Connect's words and badge tones, keyed by the wire's own values. */

const TRANSFER_TONES: Record<TransferStatus, StatusTone> = {
  pending: 'info',
  paid: 'success',
  partially_reversed: 'warning',
  reversed: 'neutral',
  failed: 'danger',
};

const REVERSAL_TONES: Record<TransferReversalStatus, StatusTone> = {
  pending: 'info',
  succeeded: 'success',
  failed: 'danger',
};

const READINESS_TONES: Record<SellerReadiness, StatusTone> = {
  ready: 'success',
  pending: 'warning',
  restricted: 'danger',
};

export const transferStatusTone = (status: TransferStatus) => TRANSFER_TONES[status] ?? 'neutral';
export const transferStatusLabel = (status: TransferStatus) =>
  labelFor('connect.transferStatus', status);

export const reversalStatusTone = (status: TransferReversalStatus) =>
  REVERSAL_TONES[status] ?? 'neutral';
export const reversalStatusLabel = (status: TransferReversalStatus) =>
  labelFor('connect.reversalStatus', status);

export const readinessTone = (readiness: SellerReadiness) => READINESS_TONES[readiness];
export const readinessLabel = (readiness: SellerReadiness) =>
  labelFor('connect.readiness', readiness);

export const railLabel = (rail: ConnectedAccountRail) => labelFor('connect.rail', rail);
