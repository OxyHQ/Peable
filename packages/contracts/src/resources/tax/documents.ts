import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery, listQuery, metadataCreateParam } from '../../common/params';
import { livemode, metadata, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TAX_DOCUMENT_CHECKLIST_STATUSES, TAX_DOCUMENT_KINDS } from '../../vocabulary/tax';
import {
  complianceCountryParam,
  complianceIdParam,
  complianceStateParam,
  complianceTextParam,
  taxState,
} from './shared';

/**
 * A supporting document (`taxdoc_…`): a `file_…` of purpose `tax_document`
 * (private, never addressable by URL) with what it is for. Attaching a
 * document proves nothing by itself; it is what a reviewer reads.
 */
export const taxDocumentSchema = defineObject(
  'tax.document',
  'TaxDocument',
  z
    .object({
      object: z.literal('tax.document'),
      id: z.string().describe('`taxdoc_…`.'),
      livemode,
      file: z.string().describe('The file (`file_…`, purpose `tax_document`).'),
      // The file's `status` vocabulary (`available` / `withheld` / `removed`).
      file_status: z
        .enum(['available', 'withheld', 'removed'])
        .describe("The file's standing now: a `removed` file is a document that is gone."),
      filename: nullableString,
      kind: z.enum(TAX_DOCUMENT_KINDS),
      country: nullableString.describe('ISO 3166-1 alpha-2.'),
      state: taxState,
      registration_declaration: nullableString.describe(
        'The declaration (`taxrd_…`) it supports, when it names one.',
      ),
      description: nullableString,
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'tax.document',
        id: 'taxdoc_0193b8f2c1a87d3e9f4a',
        livemode: false,
        file: 'file_0193b8f2c1a87d3e9f4a',
        file_status: 'available',
        filename: 'oss-registration.pdf',
        kind: 'registration_certificate',
        country: 'ES',
        state: null,
        registration_declaration: 'taxrd_0193b8f2c1a87d3e9f4a',
        description: null,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type TaxDocument = Expand<z.output<typeof taxDocumentSchema>>;

export const taxDocumentChecklistItemSchema = defineComponent(
  'TaxDocumentChecklistItem',
  z
    .object({
      key: z.string(),
      kind: z.enum(TAX_DOCUMENT_KINDS),
      country: nullableString,
      state: taxState,
      status: z
        .enum(TAX_DOCUMENT_CHECKLIST_STATUSES)
        .describe(
          '`provided`: an available document is attached; `unavailable`: only removed ones are.',
        ),
      documents: z.array(z.string()).describe('The attached documents (`taxdoc_…`).'),
      reason: z.string(),
    })
    .strict(),
);
export type TaxDocumentChecklistItem = z.output<typeof taxDocumentChecklistItemSchema>;

/** The documents the recorded facts call for, and which are attached. */
export const taxDocumentChecklistSchema = defineObject(
  'tax.document_checklist',
  'TaxDocumentChecklist',
  z
    .object({
      object: z.literal('tax.document_checklist'),
      livemode,
      items: z.array(taxDocumentChecklistItemSchema),
    })
    .strict(),
);
export type TaxDocumentChecklist = Expand<z.output<typeof taxDocumentChecklistSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.document': TaxDocument;
    'tax.document_checklist': TaxDocumentChecklist;
  }
}

/** Orbit's attachment of a document (the owner's). Attaching the same file again answers the same document. */
export const createTaxDocumentParams = z
  .object({
    file: complianceIdParam.describe('A `file_…` of purpose `tax_document`.'),
    kind: z.enum(TAX_DOCUMENT_KINDS),
    country: complianceCountryParam.nullable().optional(),
    state: complianceStateParam.optional(),
    registration_declaration: complianceIdParam.nullable().optional(),
    description: complianceTextParam(500).optional(),
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreateTaxDocumentParams = z.input<typeof createTaxDocumentParams>;

export const listTaxDocumentsQuery = listQuery({});
export type ListTaxDocumentsParams = z.input<typeof listTaxDocumentsQuery>;

export const taxDocumentRoutes = [
  defineRoute({
    operationId: 'listTaxDocuments',
    method: 'get',
    path: '/v1/tax/documents',
    tag: 'Tax compliance',
    summary: 'List tax documents',
    auth: 'service',
    scope: 'payments:read',
    query: listTaxDocumentsQuery,
    response: listOf(taxDocumentSchema),
    sdk: 'tax.compliance.listDocuments',
    expandable: 'tax.document',
  }),
  defineRoute({
    operationId: 'retrieveTaxDocument',
    method: 'get',
    path: '/v1/tax/documents/{id}',
    tag: 'Tax compliance',
    summary: 'Retrieve a tax document',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The document (`taxdoc_…`).' },
    query: expandOnlyQuery,
    response: taxDocumentSchema,
    sdk: 'tax.compliance.retrieveDocument',
    expandable: 'tax.document',
  }),
  defineRoute({
    operationId: 'retrieveTaxDocumentChecklist',
    method: 'get',
    path: '/v1/tax/document_checklist',
    tag: 'Tax compliance',
    summary: 'Retrieve the document checklist',
    auth: 'service',
    scope: 'payments:read',
    response: taxDocumentChecklistSchema,
    sdk: 'tax.compliance.retrieveDocumentChecklist',
  }),
] as const;
