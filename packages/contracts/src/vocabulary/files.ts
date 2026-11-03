// Files vocabulary (`file_…`): what a file is for, the formats it is stored
// in, and whether its bytes are being served. Zod-free.

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
  'finance_report_run',
  'tax_document',
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * The purposes a merchant may upload or import. `finance_report_run` is not
 * among them: a report's CSV is written by Peable's report runs
 * (`/v1/reporting/report_runs`) and nobody else, so a file of that purpose is
 * always a report Peable produced.
 */
export const FILE_UPLOAD_PURPOSES = [
  'dispute_evidence',
  'business_logo',
  'identity_document',
  'additional_verification',
  'tax_document',
] as const satisfies readonly FilePurpose[];
export type FileUploadPurpose = (typeof FILE_UPLOAD_PURPOSES)[number];

/** The stored format, by its conventional extension (Stripe's `type`). */
export const FILE_TYPES = ['pdf', 'png', 'jpg', 'csv'] as const;
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
