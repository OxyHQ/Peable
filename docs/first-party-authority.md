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

The adoption release pins registry core7.0.0/contracts6.0.0/services13.0.0 and
protocol1.5.1; SDK0.5.0 adds the own factory while preserving customer credential
minting. The SDK remains structurally typed and does not load Oxy in its root.
Contracts0.2.1 sets Zod4.6.7 as its minimum; shared-types0.5.1 follows that
contract pin. Backend and frontend types, 191 SDK tests and 9 real HTTP receiver
tests passed against the published dependencies. The tax UI consumes complete
Peable list envelopes through shared authenticated raw transport. Workload
binding/environment registration must already be active before deployment.
