import { DATABASE_CASING } from '@oxy.so/db';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit's half of the schema: it GENERATES the SQL that `db/migrate.ts`
 * later applies. It never applies anything itself — `drizzle-kit migrate` is a
 * devDependency command that cannot reach the production image.
 *
 * `casing` is read from `@oxy.so/db` rather than spelled out, because the same
 * setting decides the column names the runtime handle REFERENCES
 * (`db/postgres.ts`) and the column names these migrations CREATE. Two copies
 * of that decision produce queries against columns that do not exist.
 *
 * Migrations live under `src/` on purpose: the runtime image runs TypeScript
 * source directly under Bun and copies `packages/backend/src/` wholesale, so a
 * migration placed anywhere else would have to be remembered in the Dockerfile.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  casing: DATABASE_CASING,
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
