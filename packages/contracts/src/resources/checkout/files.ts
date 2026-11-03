import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import { emptyQuery, expandOnlyQuery, listQuery } from '../../common/params';
import { livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  FILE_PURPOSES,
  FILE_STATUSES,
  FILE_TYPES,
  FILE_UPLOAD_PURPOSES,
} from '../../vocabulary/files';

/**
 * Files (`file_…`) — bytes a merchant gives Orbit for one stated purpose
 * (ADR 0016: Orbit owns the object; the storage is Oxy Files, a binding that
 * never reaches the wire). Stripe's Files API, with Oxy Files underneath.
 */
export const fileSchema = defineObject(
  'file',
  'File',
  z
    .object({
      id: z.string(),
      object: z.literal('file'),
      livemode,
      purpose: z.enum(FILE_PURPOSES),
      filename: z
        .string()
        .nullable()
        .describe('The name it was uploaded with, if it had a printable one.'),
      size: z.number().int().nonnegative().describe('Bytes.'),
      type: z.enum(FILE_TYPES),
      status: z.enum(FILE_STATUSES),
      url: z
        .string()
        .nullable()
        .describe(
          'Where the bytes can be read while the file is `available`: a public URL for a `business_logo`, `GET /v1/files/{id}/contents` for a `finance_report_run`. `null` for every other purpose — evidence and identity documents are never addressable by URL.',
        ),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'file_0193b8f2c1a87d3e9f4a',
        object: 'file',
        livemode: false,
        purpose: 'business_logo',
        filename: 'logo.png',
        size: 18_432,
        type: 'png',
        status: 'available',
        url: 'https://cloud.oxy.so/assets/0193b8f2c1a87d3e9f4b',
        created: 1793750400,
      },
    ],
  },
);
/** The API's `file` object; `FileObject` so it never shadows the DOM's `File`. */
export type FileObject = Expand<z.output<typeof fileSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    file: FileObject;
  }
}

/**
 * `POST /v1/files` as `multipart/form-data`: a `purpose` field and a `file`
 * part. The gateway reads the form itself, bounded by the largest purpose's
 * ceiling, and checks each part with these schemas.
 */
export const createFileUploadParams = z
  .object({
    purpose: z.enum(FILE_UPLOAD_PURPOSES, {
      error: `purpose must be one of ${FILE_UPLOAD_PURPOSES.join(', ')}`,
    }),
    file: z.file({ error: 'file is required' }).describe('The bytes, with their filename.'),
  })
  .strict();

/**
 * `POST /v1/files` as JSON: an Oxy file the caller already owns (their
 * application's, or an account they are or act for). Its ownership is checked
 * once, here, and never again.
 */
export const createFileFromOxyParams = z
  .object({
    purpose: z.enum(FILE_UPLOAD_PURPOSES),
    oxy_file: z.string().min(1).max(128).describe('The Oxy file id.'),
  })
  .strict();
export type CreateFileFromOxyParams = z.input<typeof createFileFromOxyParams>;

export const listFilesQuery = listQuery({ purpose: z.enum(FILE_PURPOSES).optional() });
export type ListFilesParams = Pick<z.input<typeof listFilesQuery>, 'purpose'>;

export const fileRoutes = [
  defineRoute({
    operationId: 'createFile',
    method: 'post',
    path: '/v1/files',
    tag: 'Files',
    summary: 'Upload a file',
    description:
      'The bytes as `multipart/form-data` (`purpose`, `file`), or — as JSON — `{ purpose, oxy_file }` to import an Oxy file you own. The type is recognised from the bytes, never from a `Content-Type`; each purpose has its own formats and size ceiling.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createFileUploadParams,
    bodyEncoding: 'multipart',
    response: fileSchema,
    sdk: 'files.create',
  }),
  defineRoute({
    operationId: 'listFiles',
    method: 'get',
    path: '/v1/files',
    tag: 'Files',
    summary: 'List files',
    auth: 'service',
    scope: 'payments:read',
    query: listFilesQuery,
    response: listOf(fileSchema),
    sdk: 'files.list',
    expandable: 'file',
  }),
  defineRoute({
    operationId: 'retrieveFile',
    method: 'get',
    path: '/v1/files/{id}',
    tag: 'Files',
    summary: 'Retrieve a file',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The file (`file_…`).' },
    query: expandOnlyQuery,
    response: fileSchema,
    sdk: 'files.retrieve',
    expandable: 'file',
  }),
  defineRoute({
    operationId: 'retrieveFileContents',
    method: 'get',
    path: '/v1/files/{id}/contents',
    tag: 'Files',
    summary: "Download a file's contents",
    description:
      "The bytes of a file you read back — a report run's CSV — as an attachment. Any other purpose answers 404: evidence and identity documents leave Peable only to their provider.",
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The file (`file_…`).' },
    query: emptyQuery,
    response: { kind: 'binary', contentType: 'text/csv' },
    sdk: 'files.contents',
  }),
] as const;
