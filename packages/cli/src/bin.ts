#!/usr/bin/env node
import { processIo } from './io.js';
import { main } from './main.js';

main(process.argv.slice(2), processIo()).then(
  (code) => {
    process.exitCode = code;
    // `listen` / `logs tail` end on Ctrl-C with sockets still closing.
    process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
