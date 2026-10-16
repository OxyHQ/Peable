/**
 * What Peable does when Oxy says something happened to a file it uses
 * (ADR 0043 D9). Peable uses exactly one kind of file — a merchant's avatar —
 * so every event is about avatars:
 *
 *  - `file.deleted`, `file.blocked`: the file is gone for good (its owner
 *    deleted it, or it was taken down on a rights or privacy claim). The avatar
 *    is CLEARED on every merchant using it, an audit row says which event did
 *    it, and the reference sync tells Oxy the use ended.
 *  - every other event (`file.trashed`, `file.restored`, `file.unblocked`,
 *    `file.visibility_changed`): the file still exists and its owner may bring
 *    it back. The avatar is kept and WITHHELD from payers while Oxy would not
 *    serve it (`status` not `active`, or `visibility` `private`), and shown
 *    again when it would.
 *
 * Delivery is at least once and unordered. The event row's primary key makes a
 * redelivery a no-op (same transaction as the effect), and
 * `merchants.avatar_file_event_at` makes an older event lose to a newer one.
 */
import type { FileEvent } from '@oxy.so/core/server';
import { getDb } from '../../db/postgres';
import { oxyFileEvents } from '../../db/schema';
import type { MerchantAvatarWithheldReason } from '../../db/schema/valueSets';
import {
  type AvatarEventChange,
  clearMerchantAvatarsForFile,
  setMerchantAvatarWithheldForFile,
} from '../../db/merchants/merchantRepository';
import { kickReferenceSync } from './referenceSync';

export type FileEventOutcome =
  | { readonly kind: 'applied'; readonly changes: readonly AvatarEventChange[] }
  | { readonly kind: 'duplicate' };

/** Whether Oxy would serve the file as described, and if not, why. */
export function withheldReasonFor(file: FileEvent['file']): MerchantAvatarWithheldReason | null {
  if (file.status !== 'active') return 'unavailable';
  if (file.visibility === 'private') return 'private';
  return null;
}

/** Record `event` as received and apply it, in one transaction. */
export async function applyFileEvent(
  event: FileEvent,
  receivedAt: Date = new Date(),
): Promise<FileEventOutcome> {
  const parsed = new Date(event.occurredAt);
  // Signed by Oxy, so a bad timestamp is Oxy's bug; ordering by the receipt
  // time is the honest fallback, and refusing would only make Oxy retry the
  // same bytes sixteen times.
  const occurredAt = Number.isNaN(parsed.getTime()) ? receivedAt : parsed;

  const outcome = await getDb().transaction(async (tx): Promise<FileEventOutcome> => {
    const inserted = await tx
      .insert(oxyFileEvents)
      .values({ eventId: event.id, eventType: event.type, fileId: event.file.id, occurredAt })
      .onConflictDoNothing()
      .returning({ eventId: oxyFileEvents.eventId });
    if (inserted.length === 0) return { kind: 'duplicate' };

    const avatarEvent = {
      eventId: event.id,
      eventType: event.type,
      fileId: event.file.id,
      occurredAt,
    };
    switch (event.type) {
      case 'file.deleted':
      case 'file.blocked':
        return { kind: 'applied', changes: await clearMerchantAvatarsForFile(tx, avatarEvent) };
      case 'file.trashed':
      case 'file.restored':
      case 'file.unblocked':
      case 'file.visibility_changed':
        return {
          kind: 'applied',
          changes: await setMerchantAvatarWithheldForFile(
            tx,
            avatarEvent,
            withheldReasonFor(event.file),
          ),
        };
      default: {
        const unhandled: never = event.type;
        throw new Error(`unhandled file event type ${String(unhandled)}`);
      }
    }
  });

  if (outcome.kind === 'applied' && outcome.changes.some((change) => change.action === 'cleared')) {
    kickReferenceSync();
  }
  return outcome;
}
