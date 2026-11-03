/**
 * The Oxy Files calls Peable makes, behind one interface.
 *
 * Every caller takes an `OxyFilesClient` rather than reaching for `oxy`
 * itself, so a suite hands in a fake and no test can reach the real Oxy API.
 * The default forwards to `oxy.assets` — authenticated as Peable by the
 * process's verified workload identity (`oxy.ts`), including temporary
 * development roles. Oxy validates its live registration; merchant ownership
 * and Files reference semantics remain independent resource checks.
 */
import type {
  FileVisibility,
  ServiceAssetMetadata,
  ServiceFileReference,
  ServiceFileReferenceResult,
  ServiceReferenceInventoryItem,
  ServiceReferenceReconcileResult,
} from '@oxy.so/core';
import { oxy } from '../../oxy';

/** What `storeAppFile` needs: the bytes, their type, and the reference to register with them. */
export interface StoreAppFileRequest {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly filename?: string;
  readonly visibility: FileVisibility;
  /** Registered in the same Oxy call, so the stored file is never unreferenced. */
  readonly reference: { readonly entityType: string; readonly entityId: string };
}

export interface StoredAppFile {
  readonly id: string;
  /** Whether Oxy accepted the reference (`created` or `exists`). */
  readonly referenced: boolean;
}

/** A short-lived URL to bytes Peable may read. Never logged, never stored. */
export interface LinkedDownload {
  readonly id: string;
  readonly url: string;
  readonly mime: string;
  readonly size: number;
}

export interface OxyFilesClient {
  /**
   * Store bytes as a file PEABLE owns (an Orbit upload), with its reference.
   * Any document type the policy admits — the large-upload path, which takes
   * PDFs as well as images. Idempotent per bytes at Oxy.
   */
  storeAppFile(request: StoreAppFileRequest): Promise<StoredAppFile>;
  /** Short-lived URLs to bytes Peable may read (its own files). Never logged. */
  linkedDownloadUrls(ids: string[]): Promise<LinkedDownload[]>;
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
  storeAppFile: async (request) => {
    const stored = await oxy.assets.uploadAppFileLarge(request.bytes, {
      mime: request.mime,
      visibility: request.visibility,
      reference: { ...request.reference },
      ...(request.filename !== undefined ? { filename: request.filename } : {}),
    });
    const result = stored.reference?.result;
    return { id: stored.file.id, referenced: result === 'created' || result === 'exists' };
  },
  linkedDownloadUrls: (ids) => oxy.assets.linkedDownloadUrls(ids),
  metadataByIds: (ids) => oxy.assets.metadataByIds(ids),
  addReferences: (references) => oxy.assets.references.add(references),
  removeReferences: (references) => oxy.assets.references.remove(references),
  reconcile: (entityType, items, options) =>
    oxy.assets.references.reconcile(entityType, items, options),
};
