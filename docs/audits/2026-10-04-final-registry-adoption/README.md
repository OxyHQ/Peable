Published Oxy SDK adoption
==========================

The manifests and lock now resolve contracts 4.9.0, core 4.2.0 and Services 11.1.0 from the public registry. All five SDK archives passed the reviewed registry integrity/member gate before install; every declared importer was compared against those archives. Bloom 6.2.1 remains exact and both frontend/pay resolutions match its published archive (20,940 files each).

Validation: frontend 388 PASS, pay 130 PASS, real canonical auth middleware 3 PASS (777 filtered), backend/frontend types, backend/pay builds and frontend web export all exit 0. The auth harness used disposable PostgreSQL with verified ownership and teardown. Initial missing-DB and missing-workspace-dist setup attempts remain in records.

This is local registry acceptance. Required CI, merged-main image provenance, deployment and commercial cohort acceptance remain separate. No provider effects or SDK publication occurred in this change.
