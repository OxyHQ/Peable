# Interrupted HTTP body followup

Review [5965526108](https://github.com/OxyHQ/Peable/pull/92#issuecomment-5965526108)
identified a body read outside the fetch error boundary. Source `2b1c645` catches
that read failure and returns `PeableApiError` with the known HTTP status,
`invalid_response`, and an explicit unknown remote outcome. It does not infer a
failed remote effect, refresh authority or retry a POST automatically.

Three real local HTTP cases flush 200/201/503 headers, write an incomplete body,
and destroy the socket. Before the fix: 120 passed, three failed with raw
`TypeError`. After: 123 passed, no failures, strict typecheck passed. Each case
asserts exactly one initial POST and no token refresh, then an explicit retry
with the same key returns the same synthetic committed result with one effect.
Existing valid JSON, explicit 204 and ordinary non-success mappings remain green.
The server's effect and token are synthetic; no Stripe calls or sandbox reruns.

The first fixture attempt had a separate cleanup error: Bun's
`closeAllConnections()` stopped the server, so a subsequent `close()` raised
`ERR_SERVER_NOT_RUNNING`. The fixture now checks `listening` before closing.
That first log is retained as a fixture failure; the separate RED log demonstrates
the actual product defect after cleanup was corrected.

Commands: `bun run --cwd packages/sdk test`, then
`bun run --cwd packages/sdk typecheck`. Source and evidence hashes are in
`proof.json`. This followup supersedes the previously packed SDK candidate;
release packaging must rebuild it in the same command as packing/publication.
