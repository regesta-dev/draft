# Roadmap

This roadmap describes the long-term shape of Regesta. It is not a protocol
specification and it is not limited to one implementation stage.

## Registry Kernel

- [ ] Stabilize canonical package identity as `ecosystem:domain/name`.
- [ ] Keep release manifests immutable and content-addressed.
- [ ] Keep channels as event-backed pointers, not release mutations.
- [ ] Keep core metadata intentionally small and ecosystem-neutral.
- [ ] Keep dependency and resolver metadata inside artifact-level ecosystem
      metadata.
- [ ] Maintain conformance tests for core replay, channel state, object
      addressing, and event ordering.

## Trust And Identity

- [ ] Support domain-bound publishing as the base trust primitive.
- [ ] Define key rotation and revocation behavior.
- [ ] Define package freeze and compromise response behavior.
- [ ] Design UID plus passkey accounts.
- [ ] Design domain claim flows with DNS verification.
- [ ] Design owner, admin, and transfer rules for claimed domains.
- [ ] Design hardened publishing with both domain signatures and passkeys.

## Transparency

- [ ] Keep canonical JSON and deterministic digests stable.
- [ ] Make release verification independent from server convenience endpoints.
- [ ] Define public signed-intent representation.
- [ ] Define checkpoint objects.
- [ ] Define inclusion proof and consistency proof formats.
- [ ] Define witness discovery and witness threshold policy.
- [ ] Build mirror and auditor tooling that can replay events and verify
      objects without private database access.

## Ecosystem Projections

- [ ] Keep ecosystem projection code outside the core registry model.
- [ ] Maintain npm-compatible packument, version, tag, and tarball projection.
- [ ] Keep progressive migration fallback policies in projections or clients,
      not in core registry state.
- [ ] Define PyPI Simple API projection behavior.
- [ ] Define Cargo crate index projection behavior.
- [ ] Define Go module proxy projection behavior.
- [ ] Define OCI manifest, blob, and tag projection behavior.
- [ ] Keep package id inference in clients and ecosystem adapters, not in core.

## Storage And Scale

- [ ] Define storage adapter conformance requirements.
- [ ] Support database adapters for durable release, channel, event, and
      metadata state.
- [ ] Support object storage adapters for source, artifact, manifest, and proof
      bytes.
- [ ] Support queue adapters for derived and async work.
- [ ] Support signing and checkpoint storage adapters.
- [ ] Define backup, restore, retention, and disaster-recovery expectations.
- [ ] Add load and concurrency tests for publish, package reads, event reads,
      object reads, and projection reads.

## Mirrors And Forkability

- [ ] Define public event log export.
- [ ] Define object inventory export.
- [ ] Define mirror synchronization protocol.
- [ ] Define replay tooling that reconstructs package state from public data.
- [ ] Define checkpoint-based fork procedure.
- [ ] Define auditor behavior for comparing registry views.

## Governance

- [ ] Keep governance actions auditable when they affect public package state.
- [ ] Define abuse handling and takedown policy.
- [ ] Define compromise response and recovery policy.
- [ ] Define root key stewardship.
- [ ] Define witness and mirror participation rules.
- [ ] Keep the project community-driven and resistant to capture by one
      company, operator, or package ecosystem.

## Tooling And Knowledge

- [ ] Build package-manager-specific publisher clients.
- [ ] Build verifier and auditor CLIs.
- [ ] Build mirror tools.
- [ ] Publish machine-readable protocol and schema references.
- [ ] Preserve source and release metadata for security tools and AI agents.
- [ ] Document ecosystem mapping rules for package managers and clients.
