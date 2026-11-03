import type { Refund } from '@peable.to/shared-types';
import type { RefundRow } from '../db/refunds/refundRepository';

export function toRefundDTO(
  row: RefundRow,
  paymentIntentPublicId: string,
  paymentStatus: string,
): Refund {
  return {
    id: row.publicId,
    object: 'refund',
    externalRef: row.externalRef,
    origin: row.origin,
    paymentIntentId: paymentIntentPublicId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    paymentStatus,
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
