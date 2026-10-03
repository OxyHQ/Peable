# Shared contracts 0.3.0 and SDK 0.2.0 candidates

These are unpublished artifacts built from the approved I08 stack and the SDK
interrupted-body correction. Both packages were built and packed in the same
command (`bun run build && bun pm pack`), with logs, source hashes and tarball
SHA-256 values in `proof.json`. No package was published or installed in Mercaria.

Registry inspection found shared-types **0.2.0 already published** and SDK
**0.1.1** published. We reserve shared-types **0.3.0** and SDK **0.2.0**, without
replacing an existing version. The packed SDK requires shared-types **^0.3.0**,
so it cannot resolve contracts lacking billing exports.

This shared-types release includes previously unpublished changes as well as I08.
The comparison against published 0.2.0 declarations is retained in
`shared-types-published-compat.diff`. In particular, merchant network/xpub,
payment address/network and checkout network can be nullable for the card rail;
new rails/statuses and resources extend the wire contract; and `WebhookEvent<T>`
changes from a payload generic to an event-type discriminated union. Consumers
must narrow the event type and handle nullable rail fields. These are breaking
pre-1.0 contracts, justifying 0.3.0 rather than a patch. The five new recurring
methods preserve consumer-owned store/plan semantics and entitlement decisions.

An isolated fixture installs both tarballs and checks Node 24 CJS and ESM loads,
five billing methods, strict NodeNext declarations and the SDK minimum dependency.
Because shared-types 0.3.0 is unpublished, that fixture uses an explicit local
shared-types tarball override; this proves local package composition, **not**
registry resolution or published-consumer adoption. The script records the exact
fixture path and makes no Oxy, Peable or Stripe request.

## Coordinated order

1. Root pauses automatic deployment and promotes one reviewed composite of
   PRs 88–92, retargeting draft 92 to main. All source/proof history remains in the
   composite; no intermediate backend promotion is needed. Exact final CI must
   pass, including ARM image/migration readiness.
2. Root runs the existing deployment workflow on main with normal pre/post and
   `sync_secrets=false`. Capture the actual old digest, apply additive migrations,
   promote and verify the new immutable image with cohort absent. The rollout
   helper preserves the existing roles/secret references and pinned rollback.
3. Publish shared-types 0.3.0, then SDK 0.2.0, in the coordinated release window.
   Each publishing command must **freshly build and pack before publishing**;
   these previously built candidate files are evidence, not permission to publish
   an old tarball. Recheck artifact contents/hashes and registry availability.
   Backend workspace builds already include both packages, so this readiness
   rollout does not require an early registry publication.
4. Install the actual published SDK in Mercaria, test the adapter and exact cohort
   transition, and verify deployed service scopes, Stripe platform account/mode
   and bindings. Keep inactive until those checks pass. Existing Mercaria webhook
   projection and Oxy's transitional adapter remain until their parity criteria
   are met. No commercial catalogue, merchant credentials or general MoR decision
   is introduced by publishing the packages.

A published package cannot be safely rolled back by overwriting its version.
Backend rollback uses the retained digest-pinned task definition before any
incompatible post migration; consumers remain on their previous dependency until
published-package validation and controlled adoption are complete.
