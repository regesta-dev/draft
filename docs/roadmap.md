# Roadmap

This checklist tracks delivery progress. It is not a protocol specification.

## Current Position

Regesta is in a TypeScript-first PoC/MVP phase. The current implementation
proves one npm-first publish/install/verify path while preserving an
ecosystem-neutral core.

Completed:

- [x] TypeScript-first V0 implementation.
- [x] Canonical package identity using `ecosystem:domain/name`.
- [x] Core release manifests, artifacts, objects, channels, and events.
- [x] Domain-bound publish authorization using well-known discovery and
      Ed25519 signatures.
- [x] Local persistence with SQLite and filesystem object storage.
- [x] Transport routing, CORS, health, readiness, deployment info, logging, and
      error boundaries.
- [x] npm projection for packuments, versions, dist-tags, tarballs, and
      upstream fallback.
- [x] npm-first CLI for publish, verify, and event-log replay.
- [x] Docker smoke flow for image build, persistent volume, publish, restart,
      verify, npm projection, and real `npm install`.
- [x] Architecture tests for important layer boundaries.

## MVP Exit

- [ ] Keep local demo flow runnable from a clean checkout.
- [ ] Keep Docker demo flow runnable with `pnpm smoke:docker`.
- [ ] Keep docs aligned with implemented V0 behavior.
- [ ] Keep public errors structured.
- [ ] Keep unexpected 500 responses logged with `console.error`.
- [ ] Avoid npm-specific assumptions in core, protocol, auth, storage, and
      transport.
- [ ] Avoid protocol semantics that are not covered by current design.

Required checks before treating a change as MVP-ready:

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm smoke:docker
git diff --check
git diff --cached --check
```

## V0 Hardening

- [ ] Add CI for test, lint, typecheck, build, and Docker smoke where
      available.
- [ ] Document the V0 security model and its limitations.
- [ ] Document persistent data directories, backups, restore drills, and
      container deployment.
- [ ] Add local SQLite migration guidance.
- [ ] Strengthen public verifier checks for event pages, event-by-id reads,
      object headers, and digest mismatches.
- [ ] Add key compromise guidance without inventing undesigned policy events.
- [ ] Expand storage adapter conformance tests.

## Production Storage

- [ ] Define production storage adapter requirements.
- [ ] Add a production database adapter candidate, such as Postgres or
      DynamoDB.
- [ ] Add a production object storage adapter candidate, such as S3, R2, or
      GCS.
- [ ] Add queue adapter support for async derived work.
- [ ] Define backup, restore, retention, and disaster-recovery expectations.
- [ ] Add load and concurrency tests for publish, package reads, event reads,
      object reads, and npm projection reads.

## Transparency

- [ ] Keep canonical JSON and deterministic event digests stable.
- [ ] Keep public release verification independent from server-side convenience
      endpoints.
- [ ] Design public signed-intent representation before claiming independent
      public signature verification from event data alone.
- [ ] Design checkpoint objects before adding checkpoint endpoints.
- [ ] Design inclusion proof and consistency proof formats.
- [ ] Design witness discovery and witness threshold policy.
- [ ] Build mirror and auditor tooling that can replay events and verify
      objects without private database access.

## Ecosystem Projections

- [ ] Keep npm-specific processing and projection in npm-related packages and
      server layers.
- [ ] Define PyPI projection behavior before implementing Simple API support.
- [ ] Define Cargo projection behavior before implementing crate index support.
- [ ] Define Go projection behavior before implementing module proxy support.
- [ ] Define OCI projection behavior before implementing manifest and blob
      support.
- [ ] Keep package id inference in clients and ecosystem adapters, not in core.

## Auth And Governance

- [ ] Keep V0 domain well-known binding as the minimum write authority model.
- [ ] Design key rotation and revocation behavior.
- [ ] Design package freeze and compromise response behavior.
- [ ] Design UID plus passkey user accounts.
- [ ] Design domain claim flows with DNS TXT verification.
- [ ] Design owner, admin, and transfer rules for claimed domains.
- [ ] Design community governance so the registry is not controlled by one
      company or operator.

## Not In Current V0

- [ ] Trusted builds or reproducible build claims.
- [ ] Verified compatibility claims.
- [ ] Generic dependencies in the core manifest.
- [ ] npm packuments or npm tarballs as the internal data model.
- [ ] Checkpoint, witness, or proof endpoints before object formats are
      designed.
