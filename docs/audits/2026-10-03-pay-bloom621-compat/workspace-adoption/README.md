# Peable workspace adoption

Source `cfc220a1b399349b3a7d24e0286752e0187b9fef` widens the optional Pay peer to `>=6.2.1 <7.0.0`, pins Pay development and the wallet frontend to published Bloom 6.2.1, and updates the real workspace lock. The earlier unchanged-source fixture is retained in the parent directory.

The workspace frozen install, shared-types/Pay/frontend builds and frontend TypeScript check pass. Frontend tests: 388 passed; Pay tests: 130 passed. Logs and source hashes are in `proof.json`. Payment and component runtime sources are unchanged.

This is preparation for the coordinated final Oxy adoption. The Oxy SDK dependencies still select the existing baseline; no package was published and no frontend was deployed. Native rendered behavior and commercial activation are outside these checks.
