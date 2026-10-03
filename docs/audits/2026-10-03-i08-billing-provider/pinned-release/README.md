# Peable immutable backend readiness release

This checkpoint prepares the existing `deploy-aws.yml` release mechanism. It does
not deploy, enable a billing cohort, install Stripe credentials, alter IAM or
publish an SDK. The current live inventory supplied by root identifies task
definition `oxy-peable:5`, whose mutable `:latest` image was serving digest
`sha256:37c93d07e91cfa174eeae9d2ad699719e1da2f9a8a565795514203d9614ef0f8`.
The workflow captures live state again rather than trusting that dated inventory.

## Promotion and recovery

Both jobs require `refs/heads/main`, including manual dispatch. Successful CI on
the exact source SHA is required. GitHub-to-SSM synchronization defaults off for
both push and dispatch; only a reviewed manual `sync_secrets=true` opt-in runs it.
Readiness uses the default and leaves existing SSM values untouched. The ARM build pushes the source-SHA tag and
uses BuildKit's image digest; it never moves `latest`.

Preparation requires a steady service, its exact running revision, desired
capacity and one observed image digest. It copies the current task definition,
changing only the named application container image, and registers an immutable
rollback before the candidate. Each registration is recorded before a separate
`describe-task-definition` readback. Configuration, secret references and roles
are compared without logging their values; only known ECS defaults and tag order
are normalized. A mixed running revision/digest fails before registration. At
zero capacity the previous definition must already name a digest; no runtime
verification is claimed.

The normal order is candidate-image `pre` migration, explicit service update,
running revision/digest verification, then `post` if present. Target database
remains `oxypay`, checked by the existing migrator. The explicit `all` migration
option retains its existing special cutover semantics; it is not the default.
Before update, the helper rechecks the captured service revision, service
configuration hash and running digest. A failed rollout can restore the pinned
previous image only while the service still refers to this deployment or its
previous revision, with the same configuration. An external deployment causes
refusal rather than overwriting it. No automatic rollback runs after a `post`
migration failure.

AWS CLI subprocesses are bounded to 60 seconds. The migration waiter has an
explicit `MIGRATION_WAIT_TIMEOUT_SECONDS=660` outer deadline (configurable
1–1800 seconds), allowing the CLI waiter's normal 600-second polling budget;
rollout polling is bounded to 1200 seconds. A migration wait failure
checks the exact returned task ARN, definition and `startedBy`, stops only that
owned task if necessary, and verifies STOPPED. Definition cleanup runs even if
preparation or migration failed. It retains definitions referenced by the service,
deployments or pending/running/draining tasks. After any rollout attempt it also
retains the pinned rollback deliberately for recovery; before rollout it removes
unreferenced copies. Receipt artifacts contain ARNs, digests, counts and hashes,
not task configuration, credentials or provider URLs.

ECS has no conditional `update-service` transaction. Immediate rechecks detect
observed drift but cannot eliminate an external mutation between read and write;
all deployers must serialize this service. If AWS accepts a registration but its
response is lost, its ARN is unknown to the helper and needs read-only operator
reconciliation; cleanup never guesses ownership from a family name. Abrupt runner
termination may likewise need reconciliation from receipts and ECS history.

## Readiness and later cohort gates

The readiness image applies additive migration 0020 with `PEABLE_BILLING_COHORT`
absent; billing routes remain unavailable and no billing provider is constructed.
The existing one-off `STRIPE_ENABLED` rail is not enabled. The live Peable inventory
has no Stripe configuration; merely deploying the backend does not provision it.
A future reviewed definition may reference the authorized existing Mercaria
secret, after verifying actual deployed account/mode match. No merchant-supplied
credential, new Stripe account, Connect settlement or general MoR decision is
introduced. Executor/task roles remain unchanged in this checkpoint.

Activation additionally requires exact merchant/application/environment/platform
account/mode, verified price/customer bindings and `payments:read`/`payments:write`
service authority. Root's live Mercaria scope inventory lacks those permissions;
they must be granted through the reviewed authority mechanism before adoption.
The six empty Mercaria commercial tables imply no database historical backfill in
that snapshot, not an empty Stripe account or authorization to create a commercial
catalogue. Published shared-types 0.3.0 and SDK 0.2.0 follow backend compatibility;
consumer adoption and ingress parity remain separate acceptance work.

## Local validation

The backend package test command executes the real release Python/Bash programs
against an isolated executable AWS CLI fixture, without network or credentials.
It covers exact configuration preservation and readback, mixed revisions/digests,
rollout failure/digest mismatch and pinned rollback, external changes before and
during rollout, definition cleanup and live-reference retention, zero capacity,
migration image/exit checks, owned timeout stop/readback, foreign-task rejection,
main-only/exact-CI gates and the existing pre/post workflow contract. These are
release-control tests, not evidence of an AWS rollout or production availability.
