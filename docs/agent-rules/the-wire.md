<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# The wire (ADR 0014)

One Stripe-style wire, changed at the root — there is no legacy shape and no
translation layer. Request bodies, query strings, responses, socket frames and
webhook payloads are `snake_case`; every instant is integer Unix seconds
(`lib/time.ts` `toUnix`); every amount is a base-unit string — Peable Tax
calculations, transactions and the report, and the signed billing documents
(tax quotes and final invoice authorities, `schema_version: 3`) included — and
currencies are uppercase. Arithmetic on an amount is `bigint`, never a float;
a provider's JS-number amount is converted at its boundary, exactly or refused.
Errors are `{error:{type, code?, decline_code?, param?, message, doc_url?, request_id}}`
through `lib/http.ts` `sendError` / `sendValidationError` (`code` is an `ErrorCode`,
`doc_url` its entry on the published errors page); 422 is never used. Request
body schemas are strict: an unknown field is a 400 naming it. Internal
TypeScript, repositories and columns stay camelCase; a jsonb column that stores
a wire object stores the wire shape (migration `0036` converted them).

