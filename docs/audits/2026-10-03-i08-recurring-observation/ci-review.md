# CI verification of the inactive I08 candidate

[Run 37071706517](https://github.com/OxyHQ/Peable/actions/runs/37071706517)
finished SUCCESS for head `fdada04ac32d24f8b5914394b170af665d6aaef1`.
Both jobs checked out GitHub's PR merge commit
`b8150183aab2ed1af0f0c5bdeb8a4546f645312e`; this distinction is recorded rather
than describing the checkout as the branch head.

All 3671 lines of the downloaded log were scanned, grouped by step, and results,
warning/error matches and image lifecycle reviewed. The root reviewer independently
verified the original proof's 12 source/12 log hashes and this CI run.

| Package | Tests passed | Failed |
| --- | ---: | ---: |
| backend | 690 | 0 |
| sdk | 115 | 0 |
| shared-types | 34 | 0 |
| checkout | 34 | 0 |
| pay | 130 | 0 |
| frontend | 388 | 0 |
| Total | 1391 | 0 |

Every package typechecked. Shared-types/pay/SDK builds, no-Mongo and lockfile
checks, and schema/migration consistency passed. The image job built the backend,
applied all 20 migrations using the image migrator, reached readiness after two
seconds, returned health `ok`, and stopped/removed the container. This is CI, not
a deploy or release; it adds no live-provider evidence.

Log error text comes from deliberate negative fixtures (SQL uniqueness/FK/CHECK
failures, rejected tokens, failed provider/network stubs), plus an initial failed
readiness poll before success. PostgreSQL notices truncate long generated FK
names; tool/dependency deprecation and locale warnings are also present. Neither
job nor any test failed. The recurring mirror tests use an injected local reader
and assert no fetch calls.

`ci-proof.json` binds counts and tested SHAs to SHA256 hashes of the complete log
and GitHub run metadata. The commit adding these evidence files does not change
runtime and is not itself what this historical run tested. Original I08 limitations
and pending commercial/provider/activation gates remain unchanged.
