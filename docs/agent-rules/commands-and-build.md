<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Commands

npm releases: merging a version bump to main publishes it (`release-packages.yml`, Oxy's
shared workflow, OIDC, once CI passed on that commit); a package's gates are CI. Never publish
from a laptop — <https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md>.

```bash
bun run dev:frontend    # expo start --clear
bun run dev:backend     # bun --watch src/server.ts
bun run build:frontend  # expo export --platform web
bun run dev:orbit       # Orbit, expo start --web on :8082
bun run build:orbit     # Orbit, expo export --platform web
bun run build:backend   # tsc
bun run build:shared-types
```

The named root shortcuts only cover `frontend`, `orbit`, `backend` and `shared-types`.
**`checkout` has no root shortcut and `sdk` only `build:sdk`**: reach them with
`bun run --filter @peable.to/checkout <script>` (`dev` is `vite`, `build` is
`vite build`) and `bun run --filter @peable.to/sdk <script>`, or run the script from
inside the package. The unnamed root scripts (`dev`, `build`, `test`) use
`--filter '*'` and do cover all five.

**Formatting and linting are Biome** (root `biome.json`, Biome pinned in the
root `devDependencies`). `bun run lint` = `biome check .` over every package plus
`expo lint` in `packages/frontend`, whose `eslint.config.js` keeps ONLY the
`eslint-plugin-expo` rules Biome has no equivalent for (`EXPO_PUBLIC_*` reads
Metro would silently fail to inline). `bun run format` / `bun run lint:fix`
write Biome's fixes; CI runs `biome ci --error-on-warnings .`, so a warning
fails the build: the preset reports `noNonNullAssertion`, `noExplicitAny` and
the unused-code rules as warnings, and the count is zero. In tests, write
`must(x)` (`__tests__/helpers/must.ts`), not `x!`. Type errors are `typecheck`
(`tsc --noEmit`) per package, not lint. `docs/audits/` (recorded evidence) and
`packages/backend/src/db/migrations/` (drizzle-kit output, checked by CI's
regenerate-and-diff gate) are excluded from Biome on purpose.

Root `postinstall` builds `contracts`, `shared-types`, `sdk` and `pay` — every workspace package
the wallet bundles: `shared-types` and `pay` directly, `sdk` (and the `contracts` it compiles
against) through `@oxy.so/services`' `@peable.to/sdk/display` — so a fresh `bun install` leaves
each `dist/` present. Metro bundles those `dist/`s, the same output `tsc` checks the wallet
against, so a package missing from that chain fails the Android release bundle (`Unable to
resolve "@peable.to/sdk/…"` when `sdk` was not in it). The wallet has no Tax or Contributions
screen: those are Orbit's (`packages/orbit`). The builds are `incremental: false`, so each install rewrites them whole. Both published packages build cjs + esm + types separately;
`shared-types` also runs `scripts/fix-esm-imports.mjs` after the esm pass.

