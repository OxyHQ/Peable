// `@peable.to/contracts/vocabulary` — the zod-free half of the contract: the
// closed value sets (currencies, statuses, event types, error codes) a schema
// is built from. A bundle that must stay small imports this subpath, never the
// package root, which constructs every schema at load.
export * from './errors';
export * from './money';
export * from './version';
