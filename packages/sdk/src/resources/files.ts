import type {
  CreateFileFromOxyParams,
  ExpandParams,
  FileObject,
  FilePurpose,
  List,
  ListFilesParams,
  ListParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

export type FileList = List<FileObject>;

export interface FileListParams extends ListParams, ListFilesParams {}

/** Upload bytes: they are sent as `multipart/form-data`. */
export interface CreateFileUploadParams {
  purpose: FilePurpose;
  file: Blob | Uint8Array | ArrayBuffer;
  /** The name the file is stored with. A `File`'s own name is used when omitted. */
  filename?: string;
}

export type CreateFileParams = CreateFileUploadParams | CreateFileFromOxyParams;

function toBlob(file: Blob | Uint8Array | ArrayBuffer): Blob {
  if (file instanceof Blob) return file;
  // Copied into a plain ArrayBuffer: a view over a SharedArrayBuffer is not a BlobPart.
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

function filenameOf(params: CreateFileUploadParams): string {
  if (params.filename !== undefined) return params.filename;
  const named = params.file as { name?: unknown };
  return typeof named.name === 'string' && named.name.length > 0 ? named.name : 'upload';
}

/**
 * Files (`file_…`): bytes given to Orbit for ONE purpose, stored in Oxy Files.
 *
 * The purpose sets the policy: `dispute_evidence` (PDF, PNG, JPEG ≤ 5 MiB,
 * private — attach it to a dispute with `disputes.update`), `business_logo`
 * (PNG, JPEG ≤ 512 KiB, public — set it with `merchants.update({ business_logo })`),
 * `identity_document` and `additional_verification` (PDF, PNG, JPEG ≤ 10 MiB,
 * private). The format is recognised from the bytes, not from a content type.
 *
 * `create({ purpose, oxy_file })` makes a file from an Oxy file you already own
 * instead of uploading it again; its ownership is checked once, there.
 */
export class FilesResource {
  constructor(private readonly client: RestClient) {}

  create(params: CreateFileParams, options: { idempotencyKey?: string } = {}): Promise<FileObject> {
    if ('oxy_file' in params) {
      return this.client.request<FileObject>('POST', '/v1/files', {
        body: { purpose: params.purpose, oxy_file: params.oxy_file },
        idempotencyKey: options.idempotencyKey,
      });
    }
    const form = new FormData();
    form.append('purpose', params.purpose);
    form.append('file', toBlob(params.file), filenameOf(params));
    return this.client.request<FileObject>('POST', '/v1/files', {
      form,
      idempotencyKey: options.idempotencyKey,
    });
  }

  retrieve(id: string, params: ExpandParams = {}): Promise<FileObject> {
    return this.client.request<FileObject>('GET', `/v1/files/${encodeURIComponent(id)}`, {
      query: { expand: params.expand },
    });
  }

  /** Your files, newest first — or one purpose's. */
  list(params: FileListParams = {}): ApiListPromise<FileObject> {
    return listPromise(
      (page: FileListParams) =>
        this.client.request<FileList>('GET', '/v1/files', {
          query: listQuery(page, { purpose: page.purpose }),
        }),
      params,
    );
  }
}
