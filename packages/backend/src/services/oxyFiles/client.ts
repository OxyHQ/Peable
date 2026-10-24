/**
 * The four Oxy Files calls Peable makes, behind one interface.
 *
 * Every caller takes an `OxyFilesClient` rather than reaching for `oxy`
 * itself, so a suite hands in a fake and no test can reach the real Oxy API.
 * The default forwards to `oxy.assets` — authenticated as Peable by the
 * process's verified workload identity (`oxy.ts`), including temporary
 * development roles. Oxy validates its live registration; merchant ownership
 * and Files reference semantics remain independent resource checks.
 */
import type {
  ServiceAssetMetadata,
  ServiceFileReference,
  ServiceFileReferenceResult,
  ServiceReferenceInventoryItem,
  ServiceReferenceReconcileResult,
} from '@oxy.so/core';
import { oxy } from '../../oxy';

export interface OxyFilesClient {
  /** Owner, status and size of each file; an unknown or deleted id is absent. Throws on failure. */
  metadataByIds(ids: string[]): Promise<ServiceAssetMetadata[]>;
  addReferences(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
  removeReferences(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
  reconcile(
    entityType: string,
    items: AsyncIterable<ServiceReferenceInventoryItem>,
    options: { dryRun: boolean },
  ): Promise<ServiceReferenceReconcileResult>;
}

export const oxyFilesClient: OxyFilesClient = {
  metadataByIds: (ids) => oxy.assets.metadataByIds(ids),
  addReferences: (references) => oxy.assets.references.add(references),
  removeReferences: (references) => oxy.assets.references.remove(references),
  reconcile: (entityType, items, options) =>
    oxy.assets.references.reconcile(entityType, items, options),
};
