import type { Request, Response } from 'express';
import { z } from 'zod';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { type ExpandableType, expandObjects, parseExpand } from '../../lib/expand';
import { sendError, sendValidationError } from '../../lib/http';

/** Shared request pieces of the billing engine's routes (ADR 0018). */

export const queryUnixSeconds = z.coerce.number().int().min(0).max(253_402_300_799);
export const idString = z.string().min(1).max(255);
export const shortText = (max: number) => z.string().min(1).max(max);

export function idParam(req: Request, res: Response, name = 'id'): string | null {
  const value = req.params[name];
  if (!value) {
    sendError(res, 400, 'invalid_request_error', `${name} is required`);
    return null;
  }
  return value;
}

export function parseBody<T>(req: Request, res: Response, schema: z.ZodType<T, unknown>): T | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return null;
  }
  return parsed.data;
}

/** Answer one object, expanded as asked (validated against `type`). */
export async function answerObject(
  res: Response,
  merchant: MerchantRow,
  type: ExpandableType,
  dto: object,
  expand: readonly string[] | undefined,
  status = 200,
): Promise<void> {
  const tree = parseExpand(res, type, expand, { list: false });
  if (!tree) return;
  await expandObjects([dto], type, tree, merchant.id);
  res.status(status).json(dto);
}

/** `""` → `null`, absent → `undefined`. */
export function cleared<T>(value: T | '' | undefined): T | null | undefined {
  if (value === undefined) return undefined;
  return value === '' ? null : value;
}

/**
 * A contract's query on both surfaces of a shared core: the contract's own
 * schema on the API, plus the Test/Live toggle on the dashboard.
 */
