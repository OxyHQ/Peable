/**
 * Orbit Files (`file_…`) over Oxy Files.
 *
 * ## Two sources, one row
 *
 *  - An UPLOAD (`multipart/form-data`): the bytes are checked against their
 *    purpose's policy — the TYPE is recognised from the bytes, never from the
 *    client's `Content-Type` — and stored as PEABLE's own application file
 *    (private, or public for a `business_logo`), its `file` reference
 *    registered in the same Oxy call. Ownership is Peable's by construction.
 *  - An IMPORT (`oxy_file`, `business_logo` only): an Oxy file the caller owns,
 *    accepted by `oxyFiles/fileOwnership.ts` — the one ownership check. Only a
 *    logo can be imported: evidence and identity documents must be bytes
 *    Peable holds, because Peable must be able to read them to forward them.
 *
 * Either way `insertFile` writes the row and queues the reference sync in one
 * transaction; a failed insert queues the pair outside it, and the sync, finding
 * no row, releases the reference (the avatar's `releaseUnusedAvatar` rule).
 *
 * ## Bytes are never logged
 *
 * Nothing here formats, logs or echoes file content: errors name the purpose,
 * the size or the type, never a byte. `readFileBytes` hands the bytes straight
 * to the provider upload that needs them and keeps nothing.
 */
import {
  FILE_PURPOSE_POLICIES,
  type FileObject,
  type FilePurpose,
  type FileType,
} from '@peable.to/shared-types';
import { newId } from '../lib/ids';
import { toUnix } from '../lib/time';
import { getDb } from '../db/postgres';
import { fileStatusOf, insertFile, type FileRow } from '../db/files/fileRepository';
import { enqueueReferenceSync } from '../db/oxyFiles/referenceSyncRepository';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { oxy } from '../oxy';
import type { OxyFilesClient } from './oxyFiles/client';
import { acceptOxyFile, type FileActor } from './oxyFiles/fileOwnership';
import { kickReferenceSync } from './oxyFiles/referenceSync';

/** The largest upload any purpose takes — the body cap of `POST /v1/files`. */
export const FILE_UPLOAD_MAX_BYTES = Math.max(
  ...Object.values(FILE_PURPOSE_POLICIES).map((policy) => policy.max_bytes),
);

const MIME_FOR: Readonly<Record<FileType, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
};

/** The type the BYTES are, by their signature; `null` for anything else. */
export function sniffFileType(bytes: Uint8Array): FileType | null {
  const starts = (signature: readonly number[]) =>
    bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts([0xff, 0xd8, 0xff])) return 'jpg';
  return null;
}

function typeOfMime(mime: string): FileType | null {
  const entry = Object.entries(MIME_FOR).find(([, value]) => value === mime.toLowerCase());
  return entry ? (entry[0] as FileType) : null;
}

/** A request the caller can fix: a 400 naming the parameter. */
export class FileRequestError extends Error {
  constructor(
    message: string,
    readonly param: string,
  ) {
    super(message);
    this.name = 'FileRequestError';
  }
}

/** Oxy Files could not be reached or refused to store: a 503 to retry. */
export class FileStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileStorageUnavailableError';
  }
}

/** Refuse a file its purpose does not take, before anything is stored. */
function checkPolicy(purpose: FilePurpose, type: FileType | null, size: number): FileType {
  const policy = FILE_PURPOSE_POLICIES[purpose];
  if (type === null || !policy.types.includes(type)) {
    throw new FileRequestError(
      `a ${purpose} file must be ${policy.types.join(', ')}; this one is not`,
      'file',
    );
  }
  if (size < 1 || size > policy.max_bytes) {
    throw new FileRequestError(
      `a ${purpose} file is at most ${String(policy.max_bytes)} bytes; this one is ${String(size)}`,
      'file',
    );
  }
  return type;
}

/** Only printable ASCII survives as a name (Oxy's header rule), at most 255 characters. */
function printableName(filename: string | undefined): string | null {
  if (filename === undefined) return null;
  const name = filename.trim();
  if (name.length === 0 || name.length > 255 || !/^[\x20-\x7e]+$/.test(name)) return null;
  return name;
}

/** A row that could not be written after Oxy accepted the reference: release it. */
async function releaseReference(oxyFileId: string, publicId: string): Promise<void> {
  try {
    await enqueueReferenceSync(getDb(), {
      fileId: oxyFileId,
      entityType: 'file',
      entityId: publicId,
    });
    kickReferenceSync();
  } catch (error) {
    process.emitWarning(
      `Peable could not queue the release of an unused file reference for ${publicId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function record(
  oxyFileId: string,
  params: Omit<Parameters<typeof insertFile>[1], 'oxyFileId'>,
): Promise<FileRow> {
  try {
    return await insertFile(getDb(), { ...params, oxyFileId });
  } catch (error) {
    await releaseReference(oxyFileId, params.publicId);
    throw error;
  }
}

/**
 * Store uploaded bytes as a File of `merchant`.
 *
 * @throws {FileRequestError} the purpose does not take these bytes.
 * @throws {FileStorageUnavailableError} Oxy Files did not store them.
 */
export async function createUploadedFile(input: {
  readonly files: OxyFilesClient;
  readonly merchant: MerchantRow;
  readonly purpose: FilePurpose;
  readonly bytes: Uint8Array;
  readonly filename?: string;
}): Promise<FileRow> {
  const type = checkPolicy(input.purpose, sniffFileType(input.bytes), input.bytes.byteLength);
  const filename = printableName(input.filename);
  const publicId = newId('file');

  let stored: Awaited<ReturnType<OxyFilesClient['storeAppFile']>>;
  try {
    stored = await input.files.storeAppFile({
      bytes: input.bytes,
      mime: MIME_FOR[type],
      ...(filename !== null ? { filename } : {}),
      // A logo is shown to every payer; everything else is readable by Peable alone.
      visibility: input.purpose === 'business_logo' ? 'public' : 'private',
      reference: { entityType: 'file', entityId: publicId },
    });
  } catch (error) {
    process.emitWarning(
      `Peable file storage failed for a ${input.purpose} upload: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw new FileStorageUnavailableError('the file could not be stored right now; try again');
  }
  if (!stored.referenced) {
    throw new FileStorageUnavailableError('the file could not be stored right now; try again');
  }

  return record(stored.id, {
    publicId,
    merchantId: input.merchant.id,
    purpose: input.purpose,
    filename,
    size: input.bytes.byteLength,
    type,
  });
}

/**
 * Make an Oxy file the caller owns a File of `merchant` — `business_logo` only.
 *
 * @returns the row, or a refusal with the status the route answers.
 */
export async function createImportedFile(input: {
  readonly files: OxyFilesClient;
  readonly merchant: MerchantRow;
  readonly purpose: FilePurpose;
  readonly oxyFileId: string;
  readonly actor: FileActor;
}): Promise<FileRow> {
  if (input.purpose !== 'business_logo') {
    throw new FileRequestError(
      'only a business_logo can be imported from Oxy; upload the bytes for any other purpose',
      'purpose',
    );
  }
  const publicId = newId('file');
  const accepted = await acceptOxyFile(
    input.files,
    input.oxyFileId,
    { entityType: 'file', entityId: publicId, param: 'oxy_file' },
    input.actor,
  );
  if (!accepted.ok) {
    if (accepted.status === 503) throw new FileStorageUnavailableError(accepted.message);
    throw new FileRequestError(accepted.message, 'oxy_file');
  }
  const metadata = accepted.metadata;
  const type = metadata ? typeOfMime(metadata.mime) : null;
  let checked: FileType;
  try {
    checked = checkPolicy(input.purpose, type, metadata?.size ?? 0);
  } catch (error) {
    // Accepted at Oxy and refused here: the reference must not outlive the refusal.
    await releaseReference(input.oxyFileId, publicId);
    if (error instanceof FileRequestError) throw new FileRequestError(error.message, 'oxy_file');
    throw error;
  }
  return record(input.oxyFileId, {
    publicId,
    merchantId: input.merchant.id,
    purpose: input.purpose,
    filename: null,
    size: metadata?.size ?? 0,
    type: checked,
  });
}

/** A File on the wire. Only an available logo has a URL. */
export function toFileDTO(row: FileRow): FileObject {
  const status = fileStatusOf(row);
  return {
    id: row.publicId,
    object: 'file',
    livemode: row.livemode,
    purpose: row.purpose,
    filename: row.filename,
    size: row.size,
    type: row.type,
    status,
    url:
      row.purpose === 'business_logo' && status === 'available'
        ? oxy.assets.publicUrl(row.oxyFileId)
        : null,
    created: toUnix(row.createdAt),
  };
}

/** How long a read of one file's bytes may take before it is abandoned. */
const READ_TIMEOUT_MS = 30_000;

/**
 * The bytes of a File Peable stored, for the one call that forwards them.
 *
 * @throws {FileRequestError} the File cannot be read (withheld, removed, or
 *   Oxy will not hand out its bytes) — the merchant must attach another.
 */
export async function readFileBytes(
  files: OxyFilesClient,
  row: FileRow,
  param: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  if (fileStatusOf(row) !== 'available') {
    throw new FileRequestError(`${row.publicId} is ${fileStatusOf(row)} and cannot be sent`, param);
  }
  const [link] = await files.linkedDownloadUrls([row.oxyFileId]);
  if (!link) {
    throw new FileRequestError(`${row.publicId} cannot be read and cannot be sent`, param);
  }
  const response = await fetch(link.url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  if (!response.ok) {
    throw new FileStorageUnavailableError(
      'an evidence file could not be read right now; try again',
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== row.size) {
    // The bytes are not the ones this File recorded: never forward them.
    throw new FileStorageUnavailableError(
      'an evidence file could not be read right now; try again',
    );
  }
  return { bytes, mime: MIME_FOR[row.type] };
}
