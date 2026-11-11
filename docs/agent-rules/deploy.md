<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Deploy

Production runs the card rail in LIVE mode only (no test key); ADR 0017's
"Production configuration" lists the variables and provider endpoints.

`.github/workflows/deploy-aws.yml` is the only deployment: native `linux/arm64`
build on an arm64 runner, pushed to ECR `oxy/peable`, rolling the `peable` ECS
service on `oxy-cluster`. AWS SSM SecureString is the sole source of truth for backend credentials.
Deployments never synchronize credentials from GitHub. Peable uses its own
`/oxy/peable/*` references; another app's processor key must never configure it.
Provision and rotate real values in AWS, then review their task-definition
references with the matching provider account and mode.

It and the three Pages deploys (`deploy-frontend.yml`, `deploy-checkout.yml`,
`deploy-orbit.yml` → Pages project `peable-orbit`, orbit.peable.to)
start on `workflow_run` after CI succeeds on a push to main, never beside it.
A `scope` job runs `.github/scripts/deploy-scope.sh`: it holds an older commit
only while a newer main commit has a live or green CI run (a bot push starts
none), and releases only when a path that target ships changed since the last
commit it released (an Actions cache marker; when unsure, it releases).
`workflow_dispatch` redeploys main's head, after a one-shot check that CI passed
for it.
