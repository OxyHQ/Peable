import { verificationReportRoutes } from './verificationReports';
import { verificationSessionRoutes } from './verificationSessions';

export * from './verificationReports';
export * from './verificationSessions';

/** Identity verification (ADR 0023): verification sessions and their reports. */
export const identityRoutes = [...verificationSessionRoutes, ...verificationReportRoutes] as const;
