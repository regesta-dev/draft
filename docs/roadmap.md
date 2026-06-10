# Roadmap

This roadmap describes the long-term shape of Regesta. It is not a protocol
specification and it is not limited to one implementation stage.

## Registry Kernel

- [x] Define V0 canonical package identity as `ecosystem:domain/name`.
- [x] Keep V0 release manifests immutable and content-addressed.
- [x] Keep V0 channels as event-backed pointers, not release mutations.
- [x] Keep V0 core metadata intentionally small and ecosystem-neutral.
- [x] Keep V0 dependency and resolver metadata inside artifact-level ecosystem
      metadata.
- [x] Add V0 conformance tests for core replay, channel state, object
      addressing, and event ordering.

## Trust And Identity

- [x] Support V0 domain-bound publishing as the base trust primitive.
- [x] Document the V0 key lifecycle boundary for new writes, historical proofs,
      and compromise response.
- [x] Document V0 package freeze and compromise response behavior as operator
      policy.
- [x] Define key rotation and revocation behavior.
- [x] Define package freeze and compromise response behavior.
- [x] Design UID plus passkey accounts.
- [x] Design domain claim flows with DNS verification.
- [x] Design owner, admin, and transfer rules for claimed domains.
- [x] Design hardened publishing with both domain signatures and passkeys.

## Transparency

- [x] Provide V0 canonical JSON and deterministic digest checks.
- [x] Make V0 release verification independent from server convenience
      endpoints.
- [x] Verify V0 event-log replay and package-state projections from public
      APIs.
- [x] Define public signed-intent representation.
- [ ] Define checkpoint objects.
- [ ] Define inclusion proof and consistency proof formats.
- [ ] Define witness discovery and witness threshold policy.
- [x] Build V0 mirror and auditor tooling that can replay events and verify
      objects without private database access.

## Ecosystem Projections

- [x] Keep V0 ecosystem projection code outside the core registry model.
- [x] Provide V0 npm-compatible packument, version, tag, dist-tag, and tarball
      projection.
- [x] Keep V0 progressive migration fallback policies in projections or clients,
      not in core registry state.
- [x] Document ecosystem projection boundaries and mapping responsibilities.
- [x] Define PyPI Simple API projection behavior.
- [x] Define Cargo crate index projection behavior.
- [x] Define Go module proxy projection behavior.
- [x] Define OCI manifest, blob, and tag projection behavior.
- [x] Keep V0 package id inference in clients and ecosystem adapters, not in
      core.

## Storage And Scale

- [x] Define V0 storage adapter conformance requirements.
- [x] Support V0 local database adapters for durable release, channel, event,
      and metadata state.
- [x] Support V0 local object storage adapters for source, artifact, manifest,
      and proof bytes.
- [x] Support V0 local queue adapters for derived and async work.
- [x] Support V0 signer adapters for readiness and future server-side signing
      hooks.
- [x] Design checkpoint storage adapters.
- [x] Run the V0 server with SQLite and filesystem storage on a persistent OCI
      container volume.
- [x] Define V0 backup, restore, retention, and disaster-recovery
      expectations.
- [x] Add V0 server concurrency tests for publish, package reads, event reads,
      object reads, and npm projection reads.
- [x] Add a local V0 load smoke for publish, package reads, event reads, object
      reads, and npm projection reads.
- [x] Define repeatable V0 load-smoke thresholds and runtime profiles for the
      local SQLite/filesystem adapter path.
- [x] Define production load-test thresholds and CI/runtime profiles.

## Mirrors And Forkability

- [x] Provide V0 public event log export.
- [x] Document the V0 manual mirror and auditor workflow over existing public
      APIs.
- [x] Define object inventory export.
- [x] Define the V0 mirror synchronization profile over public APIs.
- [x] Provide V0 replay tooling that reconstructs package state from public
      event data.
- [ ] Define checkpoint-based fork procedure.
- [x] Define V0 auditor behavior for comparing sampled registry views.

## Governance

- [x] Document the V0 governance boundary for abuse handling, takedown,
      compromise response, domain policy, and community control.
- [ ] Define protocol events that keep governance actions auditable when they
      affect public package state.
- [x] Define V0 abuse handling and takedown policy.
- [x] Define V0 compromise response and recovery policy.
- [x] Define V0 root key stewardship boundaries.
- [x] Define V0 witness and mirror participation boundaries.
- [x] Keep the project community-driven and resistant to capture by one
      company, operator, or package ecosystem.

## Tooling And Knowledge

- [x] Build a V0 npm-first publisher client for development and compatibility
      testing.
- [ ] Build package-manager-specific publisher clients beyond the V0 npm-first
      client.
- [x] Build a V0 verifier CLI for release, event-log, and package-state
      checks.
- [x] Build a V0 auditor CLI helper for comparing public event-log views.
- [x] Build a V0 auditor CLI helper for comparing local mirror directories.
- [ ] Build auditor CLIs for checkpoints and governance events.
- [x] Build a V0 local mirror CLI over existing public registry APIs.
- [x] Publish machine-readable protocol and schema references.
- [x] Document V0 source, release, artifact, event, and authorization metadata
      preserved for security tools and AI agents.
- [x] Document V0 package identity and npm mapping rules for package managers
      and clients.
