/** This package's version — kept equal to `package.json` by `__tests__/version.test.ts`. */
export const CLI_VERSION = '0.2.0';

/** Sent on every request the CLI forwards, so a receiver's logs can tell where it came from. */
export const USER_AGENT = `peable-cli/${CLI_VERSION}`;
