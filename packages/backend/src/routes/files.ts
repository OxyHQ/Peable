/**
 * Files (`file_…`): `POST /v1/files` (multipart bytes, or JSON `oxy_file`),
 * `GET /v1/files/:id`, `GET /v1/files`. Cores shared with the dashboard.
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
import { z } from 'zod';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { FILE_PURPOSES, type FilePurpose } from '@peable.to/shared-types';
import { oxy } from '../oxy';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { findFileByPublicId, listFilesForMerchant } from '../db/files/fileRepository';
import {
  createImportedFile,
  createUploadedFile,
  FILE_UPLOAD_MAX_BYTES,
  FileRequestError,
  FileStorageUnavailableError,
  toFileDTO,
} from '../services/files';
import { type OxyFilesClient, oxyFilesClient } from '../services/oxyFiles/client';
import type { FileActor } from '../services/oxyFiles/fileOwnership';
import { requireAuthenticated, sendError, sendValidationError, wrap } from '../lib/http';
import { idempotent } from '../lib/idempotency';
import {
  answerList,
  parseQuery,
  type QuerySurface,
  surfaceListQuery,
  surfaceRetrieveQuery,
} from '../lib/list';
import { resolveMerchant } from './paymentIntents';
import { serviceFileActor } from './merchants';

const listFilesQuery = surfaceListQuery({ purpose: z.enum(FILE_PURPOSES).optional() });
const retrieveFileQuery = surfaceRetrieveQuery();

/** Room for the form's boundaries and its `purpose` field beside the largest file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const importBodySchema = z
  .object({ purpose: z.enum(FILE_PURPOSES), oxy_file: z.string().min(1).max(128) })
  .strict();

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
    const purpose = form.get('purpose');
    if (typeof purpose !== 'string' || !(FILE_PURPOSES as readonly string[]).includes(purpose)) {
      sendError(
        res,
        400,
        'invalid_request_error',
        `purpose must be one of ${FILE_PURPOSES.join(', ')}`,
        'parameter_invalid',
        'purpose',
      );
      return;
    }
    const file = form.get('file');
    if (file === null || typeof file === 'string') {
      sendError(res, 400, 'invalid_request_error', 'file is required', 'parameter_missing', 'file');
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = file.name && file.name !== 'blob' ? file.name : undefined;
    (req as WithUpload)[UPLOAD] = {
      purpose: purpose as FilePurpose,
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
    const parsed = importBodySchema.safeParse(req.body ?? {});
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
  const read = [
    requireMerchant,
    requireAuthenticated,
    oxy.middleware.requireScope('payments:read'),
  ];
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
    oxy.middleware.requireScope('payments:write'),
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
  return router;
}
