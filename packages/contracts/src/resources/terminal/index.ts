import { terminalConnectionTokenRoutes } from './connectionTokens';
import { terminalLocationRoutes } from './locations';
import { terminalReaderRoutes, terminalTestHelperRoutes } from './readers';

export * from './connectionTokens';
export * from './locations';
export * from './readers';

/** Terminal (ADR 0024): locations, readers, connection tokens and the simulated reader's helper. */
export const terminalRoutes = [
  ...terminalLocationRoutes,
  ...terminalReaderRoutes,
  ...terminalConnectionTokenRoutes,
  ...terminalTestHelperRoutes,
] as const;
