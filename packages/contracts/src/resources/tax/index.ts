// Peable Tax (ADR 0011) and its business compliance (ADR 0020): one module per
// resource, re-exported here, and their routes concatenated into `taxRoutes`.
import { taxAssessmentRoutes } from './assessments';
import { taxBusinessProfileRoutes } from './businessProfile';
import { taxCalculationRoutes } from './calculations';
import { taxCapabilityRoutes } from './capabilities';
import { taxCodeRoutes } from './codes';
import { taxComplianceActionRoutes } from './complianceActions';
import { taxDeadlineRoutes } from './deadlines';
import { taxDocumentRoutes } from './documents';
import { taxLocationEvidenceRoutes } from './locationEvidence';
import { taxOperatingLocationRoutes } from './operatingLocations';
import { taxProductRoutes } from './products';
import { taxRegistrationDeclarationRoutes } from './registrationDeclarations';
import { taxRegistrationRoutes } from './registrations';
import { taxReportRoutes } from './reports';
import { taxReviewItemRoutes } from './reviewItems';
import { taxRuleSetRoutes } from './ruleSet';
import { taxSalesDestinationRoutes } from './salesDestinations';
import { taxSettingsRoutes } from './settings';
import { taxTransactionRoutes } from './transactions';

export * from './assessments';
export * from './businessProfile';
export * from './calculations';
export * from './capabilities';
export * from './codes';
export * from './complianceActions';
export * from './deadlines';
export * from './documents';
export * from './locationEvidence';
export * from './operatingLocations';
export * from './products';
export * from './registrationDeclarations';
export * from './registrations';
export * from './reports';
export * from './reviewItems';
export * from './ruleSet';
export * from './salesDestinations';
export * from './settings';
export * from './shared';
export * from './transactions';

/** Peable Tax: collection (settings, evidence, calculations, transactions, reports) and business compliance. */
export const taxRoutes = [
  ...taxCodeRoutes,
  ...taxSettingsRoutes,
  ...taxRegistrationRoutes,
  ...taxProductRoutes,
  ...taxLocationEvidenceRoutes,
  ...taxCalculationRoutes,
  ...taxTransactionRoutes,
  ...taxReportRoutes,
  ...taxBusinessProfileRoutes,
  ...taxOperatingLocationRoutes,
  ...taxSalesDestinationRoutes,
  ...taxRegistrationDeclarationRoutes,
  ...taxDocumentRoutes,
  ...taxRuleSetRoutes,
  ...taxCapabilityRoutes,
  ...taxDeadlineRoutes,
  ...taxAssessmentRoutes,
  ...taxReviewItemRoutes,
  ...taxComplianceActionRoutes,
] as const;
