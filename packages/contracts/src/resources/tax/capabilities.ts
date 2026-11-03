import { z } from 'zod';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { livemode } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  TAX_COMPLIANCE_CAPABILITY_CATEGORIES,
  TAX_COMPLIANCE_CAPABILITY_STATUSES,
} from '../../vocabulary/tax';

/** What Peable Tax compliance can and cannot do, each stated rather than simulated. */
export const taxComplianceCapabilitySchema = defineComponent(
  'TaxComplianceCapability',
  z
    .object({
      id: z.string(),
      category: z
        .enum(TAX_COMPLIANCE_CAPABILITY_CATEGORIES)
        .describe(
          'VAT/sales tax, corporate income tax and annual company filings are different obligations.',
        ),
      status: z.enum(TAX_COMPLIANCE_CAPABILITY_STATUSES),
      reason: z.string(),
    })
    .strict(),
);
export type TaxComplianceCapability = z.output<typeof taxComplianceCapabilitySchema>;

export const taxComplianceCapabilitiesSchema = defineObject(
  'tax.compliance_capabilities',
  'TaxComplianceCapabilities',
  z
    .object({
      object: z.literal('tax.compliance_capabilities'),
      livemode,
      rule_set_version: z.string(),
      supported_rules: z.array(z.string()).describe('The ids of the rules assessed.'),
      capabilities: z.array(taxComplianceCapabilitySchema),
    })
    .strict(),
);
export type TaxComplianceCapabilities = Expand<z.output<typeof taxComplianceCapabilitiesSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'tax.compliance_capabilities': TaxComplianceCapabilities;
  }
}

export const taxCapabilityRoutes = [
  defineRoute({
    operationId: 'retrieveTaxComplianceCapabilities',
    method: 'get',
    path: '/v1/tax/capabilities',
    tag: 'Tax compliance',
    summary: 'Retrieve compliance capabilities',
    description:
      'What is available, limited, not available or out of scope — Peable submits, files and pays nothing with any authority.',
    auth: 'service',
    scope: 'payments:read',
    response: taxComplianceCapabilitiesSchema,
    sdk: 'tax.compliance.retrieveCapabilities',
  }),
] as const;
