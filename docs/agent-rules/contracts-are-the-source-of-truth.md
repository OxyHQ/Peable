<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Contracts are the source of truth (ADR 0014 D5)

Every public route — merchant API, payer routes, user-session routes — is ONE
`defineRoute({...})` in `packages/contracts/src/resources/<group>/<resource>.ts`:
method, path, auth, scope, the request schemas (`params`, `query`, `body`, with
their transforms: the SDK sends `z.input`, the handler receives `z.output`) and
the response schema. Dashboard routes (`/v1/dashboard/…`) are Orbit's private
surface and are not contracts.

- **The backend validates with the contract objects** (`import { createCustomerParams } from '@peable.to/contracts'`); a route file
  never declares a public request schema of its own. A dashboard variant is the contract's schema plus
  `environment` (`surfaceQuery` / `dashboardQuery` in `lib/list.ts`).
- **Every route test answer is checked against its contract**: `packages/backend/bunfig.toml`
  preloads `src/__tests__/setup/contractCheck.ts`, which fails the test whose 2xx body does not parse
  with the route's response schema or whose 4xx body is not the error envelope. A violation means the
  contract does not describe the API — fix the contract (or the serializer), never the check.
- **`contractCoverage.test.ts` proves the mounted Express routes and the contracts are the same set.**
  A new route without a contract fails it.
- **Objects are registered once** (`defineObject('<object>', '<Component>', schema)`), with an
  `ObjectMap` entry by declaration merging. An expandable reference is `expandable('<type>')`, an
  always-embedded one `embedded('<type>')`; the wire type is `Expand<z.output<…>>`, which resolves
  references without the schemas referencing each other at the type level. A reference to an
  unregistered type throws.
- **Error codes are a closed list** (`contracts/src/vocabulary/errors.ts`, each with its description):
  `sendError` takes an `ErrorCode` and answers `doc_url`; a scope refusal goes through
  `requireScope` (`lib/http.ts`), never the bare Oxy middleware, whose body no contract describes.
- **`docs/openapi.json` is generated** (`bun run generate:openapi`) and served at `/openapi.json`;
  CI's `check:openapi` fails when it drifts. It is plain JSON outside Biome (2 MiB).
- **`shared-types` never imports the contracts root at runtime** — only `export type` from it and
  values from `@peable.to/contracts/vocabulary`, so the wallet and the hosted checkout do not bundle
  every schema. A closed value set a schema needs lives in `contracts/src/vocabulary/`.
- **The SDK's browser entries import a vocabulary MODULE, never the barrel**
  (`@peable.to/contracts/vocabulary/errors`, not `…/vocabulary`): Metro does not tree-shake, so
  an app pays for every module behind a barrel.
- **No browser or React Native entry reaches a Node-only module** (`node:*` or a bare builtin, or
  `webhookSigner`, anywhere in its graph, third-party dependencies included): `@peable.to/sdk`
  1.0.0's `./checkout/ui` reached `node:crypto` through the `shared-types` barrel and broke
  Mention's Android bundle. `scripts/browser-entries.test.ts` (`bun run test:browser-entries`, CI)
  lists every such entry — `sdk/checkout`, `sdk/checkout/ui`, `sdk/display`, `pay/ui`,
  `shared-types/tax` and `/reporting` — with the vocabulary modules each may reach; a new browser
  entry is a new row there.
- **`sdk`** on a route is its server-SDK method path; every `service` route has one and no other route
  does (`openapi.test.ts`). Renaming it renames a published method.
