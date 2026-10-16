import type {
  ServiceAssetMetadata,
  ServiceFileReference,
  ServiceFileReferenceResult,
  ServiceReferenceInventoryItem,
  ServiceReferenceReconcileResult,
} from '@oxy.so/core';
import { ServiceAssetMetadataError } from '@oxy.so/core';
import type { OxyFilesClient } from '../../services/oxyFiles/client';

/** One file the fake Oxy knows. */
export interface FakeOxyFile {
  readonly id: string;
  /** The owning account, or `null` for an application- or platform-owned file. */
  readonly ownerUserId?: string | null;
  readonly ownerApplicationId?: string;
  readonly status?: 'active' | 'trash';
  /** False: Oxy refuses Peable's reference (e.g. a private file nobody attached). Default true. */
  readonly referenceable?: boolean;
}

export interface FakeOxyFilesOptions {
  /** Answer as Oxy does for a non-`internal` caller: no owner fields at all. */
  hideOwner?: boolean;
  failMetadata?: boolean;
  failReferences?: boolean;
  failReconcile?: boolean;
}

export interface FakeOxyFiles extends OxyFilesClient {
  readonly added: ServiceFileReference[];
  readonly removed: ServiceFileReference[];
  /** Every reconciliation: its entity type, inventory and dry-run flag. */
  readonly reconciliations: {
    entityType: string;
    items: ServiceReferenceInventoryItem[];
    dryRun: boolean;
  }[];
  /** The references the fake Oxy currently holds, as `file|type|entity`. */
  readonly held: Set<string>;
  readonly options: FakeOxyFilesOptions;
}

export const referenceKey = (ref: ServiceFileReference): string =>
  `${ref.fileId}|${ref.entityType}|${ref.entityId}`;

/**
 * An in-memory Oxy Files: answers `metadataByIds` from `files`, and keeps the
 * references Peable adds and removes, so a suite can assert what Oxy was told
 * without any network.
 */
export function createFakeOxyFiles(
  files: readonly FakeOxyFile[] = [],
  options: FakeOxyFilesOptions = {},
): FakeOxyFiles {
  const byId = new Map(files.map((file) => [file.id, file]));
  const added: ServiceFileReference[] = [];
  const removed: ServiceFileReference[] = [];
  const reconciliations: FakeOxyFiles['reconciliations'] = [];
  const held = new Set<string>();

  return {
    added,
    removed,
    reconciliations,
    held,
    options,
    async metadataByIds(ids) {
      if (options.failMetadata) throw new ServiceAssetMetadataError(ids, [503]);
      return ids.flatMap((id): ServiceAssetMetadata[] => {
        const file = byId.get(id);
        if (!file) return [];
        return [
          {
            id,
            sha256: 'a'.repeat(64),
            mime: 'image/png',
            size: 1,
            status: file.status ?? 'active',
            ...(options.hideOwner
              ? {}
              : {
                  ownerUserId: file.ownerUserId ?? null,
                  ...(file.ownerApplicationId
                    ? { ownerApplicationId: file.ownerApplicationId }
                    : {}),
                }),
          },
        ];
      });
    },
    async addReferences(references): Promise<ServiceFileReferenceResult[]> {
      if (options.failReferences) throw new Error('Oxy is unreachable');
      return references.map((ref) => {
        added.push(ref);
        const file = byId.get(ref.fileId);
        if (!file || file.referenceable === false) return { ...ref, result: 'not_found' };
        const key = referenceKey(ref);
        if (held.has(key)) return { ...ref, result: 'exists' };
        held.add(key);
        return { ...ref, result: 'created' };
      });
    },
    async removeReferences(references): Promise<ServiceFileReferenceResult[]> {
      if (options.failReferences) throw new Error('Oxy is unreachable');
      return references.map((ref) => {
        removed.push(ref);
        return { ...ref, result: held.delete(referenceKey(ref)) ? 'removed' : 'not_found' };
      });
    },
    async reconcile(entityType, items, { dryRun }): Promise<ServiceReferenceReconcileResult> {
      const inventory: ServiceReferenceInventoryItem[] = [];
      for await (const item of items) inventory.push(item);
      reconciliations.push({ entityType, items: inventory, dryRun });
      if (options.failReconcile) throw new Error('reconciliation refused');
      const wanted = new Set(
        inventory.map((item) =>
          referenceKey({ fileId: item.fileId, entityType, entityId: item.entityId }),
        ),
      );
      const existing = [...held].filter((key) => key.split('|')[1] === entityType);
      const added = [...wanted].filter((key) => !held.has(key)).length;
      const removedKeys = existing.filter((key) => !wanted.has(key));
      if (!dryRun) {
        for (const key of wanted) held.add(key);
        for (const key of removedKeys) held.delete(key);
      }
      return {
        sessionId: 'rec_fake',
        entityType,
        dryRun,
        added,
        removed: removedKeys.length,
        unchanged: wanted.size - added,
        refused: 0,
      };
    },
  };
}
