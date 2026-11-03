/**
 * Files (`file_…`): `POST /v1/files` (multipart bytes, or JSON `oxy_file`),
 * `GET /v1/files/:id`, `GET /v1/files`, and `GET /v1/files/:id/contents` for
 * the files whose bytes the merchant reads back (a report run's CSV). Cores
 * shared with the dashboard.
 *
 * ## The multipart body is read here, bounded, and never logged
 *
 * `express.json()` leaves a `multipart/form-data` stream unread, so
 * `parseFileUpload` reads it — refusing more than the largest purpose takes
 * before it has buffered more than that — and parses it with the platform's
 * own `FormData`. It then sets `req.body` to the request's IDENTITY: the
 * purpose, the name, the size and the SHA-256 of the bytes. That is what the
 * generic idempotency layer hashes, so a retry with the same key and the same
 * file replays, and the same key with a different file is refused — without
 * the bytes ever entering a stored request hash, a log line or an error.
 */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import {
  createFileFromOxyParams,
  createFileUploadParams,
  emptyQuery,
  expandOnlyQuery,
  listFilesQuery as listFilesContractQuery,
} from '@peable.to/contracts';
import type { FilePurpose } from '@peable.to/shared-types';
import {
  type DashboardAction,
  FILE_UPLOAD_ACTION,
  FILE_UPLOAD_PURPOSES,
  type FileUploadPurpose,
} from '@peable.to/contracts/vocabulary';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findFileByPublicId, listFilesForMerchant } from '../db/files/fileRepository';
import {
  createImportedFile,
  createUploadedFile,
  FILE_UPLOAD_MAX_BYTES,
  FileRequestError,
  FileStorageUnavailableError,
  hasReadableContents,
  readFileBytes,
  toFileDTO,
} from '../services/files';
import { type OxyFilesClient, oxyFilesClient } from '../services/oxyFiles/client';
import type { FileActor } from '../services/oxyFiles/fileOwnership';
import {
  requireAuthenticated,
  sendError,
  sendValidationError,
  wrap,
  requireScope,
} from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { answerList, dashboardQuery, parseQuery, type QuerySurface } from '../lib/list';
import { resolveMerchant } from './paymentIntents';
import { serviceFileActor } from './merchants';

// The contract's queries on the API; the dashboard's twin adds its environment.
const listFilesQuery = {
  api: listFilesContractQuery,
  dashboard: dashboardQuery(listFilesContractQuery),
} as const;
const retrieveFileQuery = { api: expandOnlyQuery, dashboard: dashboardQuery(expandOnlyQuery) };
const contentsQuery = { api: emptyQuery, dashboard: dashboardQuery(emptyQuery) };

/** Room for the form's boundaries and its `purpose` field beside the largest file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** The upload `parseFileUpload` read, kept off `req.body` so nothing serializes it. */
interface ParsedUpload {
  readonly purpose: FilePurpose;
  readonly bytes: Uint8Array;
  readonly filename?: string;
}

const UPLOAD = Symbol('peable.fileUpload');
type WithUpload = Request & { [UPLOAD]?: ParsedUpload };

function isMultipart(req: Request): boolean {
  return (req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data');
}

async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) return null;
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read a `multipart/form-data` upload into a {@link ParsedUpload}, or answer
 * the 4xx. A JSON request (`oxy_file`) passes through untouched.
 */
export const parseFileUpload: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!isMultipart(req)) {
    next();
    return;
  }
  void (async () => {
    const raw = await readBounded(req, FILE_UPLOAD_MAX_BYTES + MULTIPART_OVERHEAD_BYTES);
    if (raw === null) {
      sendError(
        res,
        413,
        'invalid_request_error',
        `a file is at most ${String(FILE_UPLOAD_MAX_BYTES)} bytes`,
        'file_too_large',
        'file',
      );
      return;
    }
    let form: Awaited<ReturnType<globalThis.Request['formData']>>;
    try {
      form = await new globalThis.Request('http://upload.invalid/', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? '' },
        body: raw,
      }).formData();
    } catch {
      sendError(res, 400, 'invalid_request_error', 'the multipart body could not be read');
      return;
    }
    const keys = [...new Set(form.keys())];
    const unknown = keys.filter((key) => key !== 'purpose' && key !== 'file');
    if (unknown.length > 0) {
      sendError(
        res,
        400,
        'invalid_request_error',
        `unknown field(s): ${unknown.join(', ')}`,
        'parameter_unknown',
        unknown[0],
      );
      return;
    }
    // Each part is checked with the contract's schema of that part, so the
    // refusal keeps naming the part and why (a missing file is a missing
    // parameter, not an invalid one).
    const purposeParsed = createFileUploadParams.shape.purpose.safeParse(form.get('purpose'));
    if (!purposeParsed.success) {
      sendError(
        res,
        400,
        'invalid_request_error',
        purposeParsed.error.issues[0]?.message ?? 'purpose is invalid',
        'parameter_invalid',
        'purpose',
      );
      return;
    }
    const purpose = purposeParsed.data;
    const fileParsed = createFileUploadParams.shape.file.safeParse(form.get('file'));
    if (!fileParsed.success) {
      sendError(
        res,
        400,
        'invalid_request_error',
        fileParsed.error.issues[0]?.message ?? 'file is required',
        'parameter_missing',
        'file',
      );
      return;
    }
    const file = fileParsed.data;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = file.name && file.name !== 'blob' ? file.name : undefined;
    (req as WithUpload)[UPLOAD] = {
      purpose,
      bytes,
      ...(filename !== undefined ? { filename } : {}),
    };
    // The request's identity for the idempotency layer — never the bytes.
    req.body = {
      purpose,
      file: {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength,
        filename: filename ?? null,
      },
    };
    next();
  })().catch(next);
};

/**
 * The dashboard action an upload or import needs: whatever its purpose is used
 * for. Read off the body `parseFileUpload` left (or the JSON import's), BEFORE
 * the core validates it — so a purpose that is not one of ours needs the
 * strictest action, and the core then refuses it.
 */
export function fileUploadAction(req: Request): DashboardAction {
  const purpose: unknown = (req.body as { purpose?: unknown } | undefined)?.purpose;
  return (FILE_UPLOAD_PURPOSES as readonly unknown[]).includes(purpose)
    ? FILE_UPLOAD_ACTION[purpose as FileUploadPurpose]
    : 'money';
}

/** `POST /v1/files`. */
export async function createFile(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  deps: { readonly files: OxyFilesClient; readonly actor: FileActor },
): Promise<void> {
  try {
    const upload = (req as WithUpload)[UPLOAD];
    if (upload !== undefined) {
      const row = await createUploadedFile({
        files: deps.files,
        merchant,
        purpose: upload.purpose,
        bytes: upload.bytes,
        ...(upload.filename !== undefined ? { filename: upload.filename } : {}),
      });
      res.status(200).json(toFileDTO(row));
      return;
    }
    const parsed = createFileFromOxyParams.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const row = await createImportedFile({
      files: deps.files,
      merchant,
      purpose: parsed.data.purpose,
      oxyFileId: parsed.data.oxy_file,
      actor: deps.actor,
    });
    res.status(200).json(toFileDTO(row));
  } catch (error) {
    if (error instanceof FileRequestError) {
      sendError(res, 400, 'invalid_request_error', error.message, 'parameter_invalid', error.param);
      return;
    }
    if (error instanceof FileStorageUnavailableError) {
      sendError(res, 503, 'api_error', error.message);
      return;
    }
    throw error;
  }
}

export async function retrieveFile(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  if (!parseQuery(req, res, retrieveFileQuery[surface])) return;
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return;
  }
  const row = await findFileByPublicId(getDb(), merchant.id, id);
  if (!row) {
    sendError(res, 404, 'invalid_request_error', 'file not found', 'resource_missing', 'id');
    return;
  }
  res.status(200).json(toFileDTO(row));
}

/**
 * `GET /v1/files/:id/contents` — the bytes of a file the merchant reads back:
 * a report run's CSV. Read from Oxy through Peable's own binding and answered
 * as an attachment; never logged, never cached. Any other purpose is a 404 —
 * evidence and identity documents leave Peable only to their provider.
 */
export async function answerFileContents(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  deps: { readonly files: OxyFilesClient; readonly surface?: QuerySurface },
): Promise<void> {
  if (!parseQuery(req, res, contentsQuery[deps.surface ?? 'api'])) return;
  const { id } = req.params;
  if (!id) {
    sendError(res, 400, 'invalid_request_error', 'id is required');
    return;
  }
  const row = await findFileByPublicId(getDb(), merchant.id, id);
  if (!row || !hasReadableContents(row)) {
    sendError(res, 404, 'invalid_request_error', 'file not found', 'resource_missing', 'id');
    return;
  }
  try {
    const { bytes, mime } = await readFileBytes(deps.files, row, 'id');
    res
      .status(200)
      .type(mime)
      .setHeader('Cache-Control', 'no-store')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="${row.filename ?? `${row.publicId}.${row.type}`}"`,
      )
      .send(Buffer.from(bytes));
  } catch (error) {
    if (error instanceof FileRequestError) {
      sendError(res, 400, 'invalid_request_error', error.message, 'file_unavailable', 'id');
      return;
    }
    if (error instanceof FileStorageUnavailableError) {
      sendError(res, 503, 'api_error', error.message);
      return;
    }
    throw error;
  }
}

export async function answerFileList(
  req: Request,
  res: Response,
  merchant: MerchantRow,
  surface: QuerySurface = 'api',
): Promise<void> {
  const query = parseQuery(req, res, listFilesQuery[surface]);
  if (!query) return;
  const db = getDb();
  await answerList(req, res, {
    query,
    type: 'file',
    merchantId: merchant.id,
    cursor: async (publicId) => (await findFileByPublicId(db, merchant.id, publicId))?.id ?? null,
    fetch: (page) =>
      listFilesForMerchant(db, { merchantId: merchant.id, purpose: query.purpose, page }),
    serialize: toFileDTO,
  });
}

export function createFilesRouter(deps: {
  requireMerchant: RequestHandler;
  files?: OxyFilesClient;
}): Router {
  const router = Router();
  const { requireMerchant } = deps;
  const files = deps.files ?? oxyFilesClient;
  const read = [requireMerchant, requireAuthenticated, requireScope('payments:read')];
  const withMerchant = (
    handler: (req: Request, res: Response, merchant: MerchantRow) => Promise<void>,
  ) =>
    wrap(async (req, res) => {
      const merchant = await resolveMerchant(req, res);
      if (!merchant) return;
      await handler(req, res, merchant);
    });

  router.post(
    '/v1/files',
    requireMerchant,
    requireAuthenticated,
    requireScope('payments:write'),
    parseFileUpload,
    idempotent,
    withMerchant((req, res, merchant) =>
      createFile(req, res, merchant, {
        files,
        actor: serviceFileActor(req as OxyAuthRequest, merchant.oxyAppId),
      }),
    ),
  );
  router.get('/v1/files', ...read, withMerchant(answerFileList));
  router.get('/v1/files/:id', ...read, withMerchant(retrieveFile));
  router.get(
    '/v1/files/:id/contents',
    ...read,
    withMerchant((req, res, merchant) => answerFileContents(req, res, merchant, { files })),
  );
  return router;
}
