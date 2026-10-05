# SDK 0.2.2 registry release

Published from main6f671437b7e7c28c646c03afa9e47483ba04333a after PR97,
byte-identical tree to reviewed head7e00a202. CI37107485676 passed1510 tests,
including SDK144, and image. Root paused/restored three workflows for merge;
no new backend rollout. Readiness TD7 already supplies these published events.

New clean worktree, frozen install, then same-command clean/build/pack/publish
with absolute freshly built archive. Registry preflight0.2.2 absent, shared0.3
present; one publication ACK. Downloaded SHA512/SHA1/SHA256 equal local bytes.
No old archive published and no repeated publication.

Registry-only isolated install passes Node CJS/ESM standalone WebhooksResource
verification of all five formerly rejected types and strict NodeNext consumer
(skipLibCheck explicit). No credentials/client token mint, no auth/provider calls.
All53 SDK +46 shared-types files equal registry distributions in that fixture and
Mercaria's adoption worktree, which now resolves registry SDK^0.2.2. No file or
workspace overrides remain in the consumer. Consumer ingress/rotation/error parity
is tracked separately; publication does not activate financial rails/cohorts,
change scopes or create merchant credentials. Issue87 remains open.
