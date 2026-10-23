# Oxy workload authority

Own products call `peableForOxyService({ oxy })` with the shared OxyServer instance.
The transport attests the registered workload for
`oxy-service:6a2f851751b784a86fd0e958`. The receiver uses shared middleware and
live introspection. No application OAuth scopes or key pair configures own authority.
Merchant registration, active state, environment, ownership and all finance rules
still apply. Account-specific calls carry a verified requester session, task or
forwarded requester context; a naked account header is rejected.

External customers retain ApplicationCredential and tokenProvider clients. Their
published service-token mint uses `oxy-api`; this remains supported with live
credential verification and bounded scopes. An official application's customer key
is external. Revocation takes effect on the next call.

Canonical platform contract: Oxy ADR 0049. No changes to anonymous checkout,
non-custody, ledger accounting or Stripe settlement are part of this migration.

## Validation and release gate

Validated with core 7/contracts 6 candidate (central external live verification
included): backend 988 tests across 98 files, SDK 191 tests across 21 files,
backend and SDK builds/typechecks, changed TypeScript Biome checks. HTTP tests
exercise both authorities, merchant/environment/audience mismatch, scoped external
writes, revocation and unproven account headers against real PostgreSQL.

The file.lost event in the new core requires migration 0035 before the receiver
starts. It expands only the event/audit CHECK vocabulary and clears permanently
lost avatars with the existing audit and reference-release transaction.

Source commits intentionally retain registry dependency versions until the shared
release is published. The dependency adoption commit must pin the released core,
contracts and this SDK before deployment; local candidate tarball paths are not
committed. Workload binding/environment registration must already be active.
