// Files (`file_…`) — bytes a merchant gives Orbit for one stated purpose
// (ADR 0016: Orbit owns the object; the storage is Oxy Files, a binding that
// never reaches the wire). The wire types are the contract's
// (`@peable.to/contracts` `fileSchema`); the closed sets are its vocabulary.
import type { FilePurpose, FileType } from '@peable.to/contracts/vocabulary';

export {
  FILE_PURPOSES,
  FILE_STATUSES,
  FILE_TYPES,
  FILE_UPLOAD_PURPOSES,
  type FilePurpose,
  type FileStatus,
  type FileType,
  type FileUploadPurpose,
} from '@peable.to/contracts/vocabulary';
export type { CreateFileFromOxyParams, FileObject, ListFilesParams } from '@peable.to/contracts';

/**
 * The policy of each purpose: the formats it takes, recognised from the bytes
 * and never from a client's `Content-Type`, and the largest file.
 *
 * The provider's own ceilings, restated where the upload is parsed, so a file
 * the card network would refuse is refused at upload — not at the one-shot
 * dispute submission it was meant for. `finance_report_run` is Peable's own
 * output (see `FILE_UPLOAD_PURPOSES`); its ceiling bounds a report.
 */
export const FILE_PURPOSE_POLICIES: Readonly<
  Record<FilePurpose, { readonly types: readonly FileType[]; readonly max_bytes: number }>
> = Object.freeze({
  dispute_evidence: { types: ['pdf', 'png', 'jpg'], max_bytes: 5 * 1024 * 1024 },
  business_logo: { types: ['png', 'jpg'], max_bytes: 512 * 1024 },
  identity_document: { types: ['pdf', 'png', 'jpg'], max_bytes: 10 * 1024 * 1024 },
  additional_verification: { types: ['pdf', 'png', 'jpg'], max_bytes: 10 * 1024 * 1024 },
  finance_report_run: { types: ['csv'], max_bytes: 64 * 1024 * 1024 },
  // A business's own tax records (ADR 0020): private, attachable only to its
  // own `tax.document`s, never forwarded to a provider.
  tax_document: { types: ['pdf', 'png', 'jpg'], max_bytes: 10 * 1024 * 1024 },
});
