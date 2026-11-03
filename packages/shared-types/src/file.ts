// Files (`file_…`) — bytes a merchant gives Orbit for one stated purpose
// (ADR 0016: Orbit owns the object; the storage is Oxy Files, a binding that
// never reaches the wire). Stripe's Files API, with Oxy Files underneath.

/**
 * What a file is FOR. Decided at upload and never changed: the purpose is what
 * sets the type and size policy, who may see the bytes, and which objects may
 * reference the file — a `business_logo` is public, a `dispute_evidence` file
 * is private and can only be attached to the merchant's own disputes.
 */
export const FILE_PURPOSES = [
  'dispute_evidence',
  'business_logo',
  'identity_document',
  'additional_verification',
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/** The stored format, by its conventional extension (Stripe's `type`). */
export const FILE_TYPES = ['pdf', 'png', 'jpg'] as const;
export type FileType = (typeof FILE_TYPES)[number];

/**
 * Whether the bytes can be used right now.
 *
 *  - `available` — Oxy serves the file; it can be shown or forwarded.
 *  - `withheld` — the file still exists and is not being served (its owner
 *    trashed it or made it private); it can come back.
 *  - `removed` — Oxy said the file is gone for good (deleted, taken down, lost).
 *    The object stays so whatever referenced it can say why it stopped working.
 */
export const FILE_STATUSES = ['available', 'withheld', 'removed'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * The upload policy of each purpose: the formats it takes, recognised from the
 * bytes and never from a client's `Content-Type`, and the largest file.
 *
 * The provider's own ceilings, restated where the upload is parsed, so a file
 * the card network would refuse is refused at upload — not at the one-shot
 * dispute submission it was meant for.
 */
export const FILE_PURPOSE_POLICIES: Readonly<
  Record<FilePurpose, { readonly types: readonly FileType[]; readonly max_bytes: number }>
> = Object.freeze({
  dispute_evidence: { types: ['pdf', 'png', 'jpg'], max_bytes: 5 * 1024 * 1024 },
  business_logo: { types: ['png', 'jpg'], max_bytes: 512 * 1024 },
  identity_document: { types: ['pdf', 'png', 'jpg'], max_bytes: 10 * 1024 * 1024 },
  additional_verification: { types: ['pdf', 'png', 'jpg'], max_bytes: 10 * 1024 * 1024 },
});

/**
 * The API's `file` object. Named `FileObject` rather than `File` so it never
 * shadows the DOM's `File` in a browser that imports both.
 */
export interface FileObject {
  /** `file_…`. */
  id: string;
  object: 'file';
  /** The mode of the merchant that uploaded it (ADR 0017). */
  livemode: boolean;
  purpose: FilePurpose;
  /** The name it was uploaded with, if it had a printable one. */
  filename: string | null;
  /** Bytes. */
  size: number;
  type: FileType;
  status: FileStatus;
  /**
   * A public URL for a `business_logo` that is `available` — what a payer
   * surface renders. `null` for every other purpose: evidence and identity
   * documents are never addressable by URL, and their bytes leave Peable only
   * to the provider they are submitted to.
   */
  url: string | null;
  created: number;
}

/**
 * `POST /v1/files` — exactly one source:
 *
 *  - the bytes, as `multipart/form-data` with a `purpose` field and a `file`
 *    part (the SDK's `files.create({ purpose, file })` builds it);
 *  - `oxy_file`: as JSON, an Oxy file the caller already owns (their
 *    application's, or an account they are or act for). Its ownership is
 *    checked once, here, and never again.
 */
export interface CreateFileFromOxyParams {
  purpose: FilePurpose;
  /** Oxy file id. */
  oxy_file: string;
}

/** `GET /v1/files`. */
export interface ListFilesParams {
  purpose?: FilePurpose;
}
