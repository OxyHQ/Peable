# ECS empty-tag registration recovery

Source `93f3d3e` follows merged main `d8f26546`. Root authenticated CloudTrail for readiness run [37100580836](https://github.com/OxyHQ/Peable/actions/runs/37100580836): the first rollback definition registration failed with ClientException (empty tags). No migration or rollout occurred; root rechecked TD5 steady. This was not an IAM denial. Private CloudTrail remains in root's promotion evidence.

The helper omits an empty tags field, preserves nonempty tags, and reports only a bounded AWS error code and CLI exit status. CLI validation/local errors use `unknown`; stderr, request fields, messages, token URLs and secrets are never printed. No retries, permission changes or runtime changes.

Executed AWS CLI fixtures: untagged baseline now registers both pinned copies; tagged baseline preserves tags exactly. AWS/local failures invoke one registration only, do not deregister unowned definitions, and suppress secret canaries. Existing rollback, digest, ownership and migration controls remain green.

Commands:

- `DATABASE_URL=postgres://fixture@127.0.0.1:1/unused bun run --cwd packages/backend test --test-name-pattern 'pinned ECS release|the deploy workflow and the migrator agree'`: RED 26 pass / 3 fail, GREEN 29 pass / 0 fail (347 filtered). No PostgreSQL connection or AWS request.
- `bun run --cwd packages/backend typecheck`: pass.
- Python AST parse and `git diff --check`: pass.

The initial two invocations used a positional path / unsupported extglob exclusion against the package's `bun test src` script, discovered unrelated files, and failed their missing DATABASE_URL imports (60 errors). They also reproduced the three intended failures; retained as harness mistakes, not product regressions or full-suite evidence. Correctly filtered RED/GREEN are separate.

This patch still needs exact-head CI and a coordinated real readiness retry. It does not certify deployment, published SDK or activated cohort.
