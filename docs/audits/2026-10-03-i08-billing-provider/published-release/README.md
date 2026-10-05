# Published I08 billing SDK and compatible backend

Released from clean worktree main `77e7409511966d01780c7727f615213ce6c7627e`
after root verified [readiness deployment37101502264](https://github.com/OxyHQ/Peable/actions/runs/37101502264).
Root's receipt records pinned TD7/image, configuration preservation, health/ready200
and unauthenticated billing401. The cohort remains absent/inactive. The prior
failed deployment37100580836 and the empty-tags fix #93 remain in history.

Published in order: **@peable.to/shared-types0.3.0**, then **@peable.to/sdk0.2.0**.
Each command executed fresh clean, build, `bun pm pack`, and `bun publish <absolute
fresh tarball> --access public` in the same shell invocation. Neither version
existed at the registry preflight. No old candidate tarball was published.

The first shared command built/packed correctly but Bun could not resolve its
relative tarball argument (`ENOENT`); no publish occurred in that attempt.
The successful retry repeated clean/build/pack using an absolute path. A version
URL initially returned404 during registry propagation/cache; fresh packuments
and downloaded distributions subsequently verified both versions. No acknowledged
publication was repeated.

Registry receipts retain published time, SHA512 integrity, SHA1 shasum and SHA256.
Both downloaded distributions equal the freshly built local tarballs byte for
byte. SDK's dependency is `@peable.to/shared-types:^0.3.0`. The isolated consumer
installs SDK0.2.0 from npm only, resolving shared-types transitively; no overrides,
file dependencies or workspace resolution. Node24 CJS/ESM load all five methods;
TypeScript strict NodeNext passes with **skipLibCheck** (consumer check, not a
complete third-party declaration audit). All98 package files match registry
bytes both in that isolated consumer and the Mercaria adoption worktree.

Reproduce consumer: `node packages/sdk/scripts/verify-billing-published.mjs <fixture-parent>`.
Registry installation is the only network traffic in this check; it makes no
Oxy/Peable/Stripe operation. Mercaria's source/adoption acceptance is tracked
separately. Publication does not activate a catalogue, migrate commercial rows,
change MoR, move ingress or complete issue87.

## Independent release and frontend verification

Root independently verified registry SHA512/SHA1/SHA256 and all98 installed files
at both consumers (receipt `root-published-verified.json`). Checkout run
[37102033014](https://github.com/OxyHQ/Peable/actions/runs/37102033014) and frontend
run [37102036182](https://github.com/OxyHQ/Peable/actions/runs/37102036182) completed
successfully on the same main77e7409 after the backend promotion. Root's HTTP and
asset receipts show200 and byte-identical HTML/JS/CSS for each preview and its
custom domain (checkout.peable.to and peable.to). Initial urllib user-agent403
was retained as an unsuccessful probe; the curl browser user-agent probes returned200.
These are deployment/content checks, not authenticated payment-flow acceptance.
Mercaria candidate adoption is [draft1044](https://github.com/OxyHQ/Mercaria/pull/1044);
cohort activation, production bindings and equivalent legacy-client migration
remain separate acceptance gates. No commercial cohort was enabled here.
