# Regesta Roadmap and Checklist

Status: draft.

This document tracks practical progress toward the Regesta goal: a transparent,
secure, modern, high-performance, scalable, community-driven universal package
registry. It is a delivery checklist, not a protocol specification.

## Current Position

Regesta is currently in a TypeScript-first PoC/MVP phase. The current working
direction is to prove one complete npm-first publish/install/verify path while
keeping the core registry model ecosystem-neutral.

The implementation already has working pieces for:

- [x] TypeScript-first v0 implementation.
- [x] Canonical package identity using `ecosystem:domain/name`.
- [x] Core release manifests, artifacts, objects, channels, and events.
- [x] Domain-bound v0 publish authorization using well-known discovery and
      Ed25519 signatures.
- [x] Local persistent adapters using SQLite and filesystem object storage.
- [x] Transport-level routing, CORS, health/readiness, root deployment info,
      logging, and error boundary structure.
- [x] npm projection for packuments, version reads, dist-tags, install
      artifacts, tarballs, and upstream fallback.
- [x] npm-first CLI for local publishing, verification, and event-log replay.
- [x] Docker smoke flow covering image build, persistent volume, publish,
      restart, verify, verify-log, npm projection, and real `npm install`.
- [x] Architecture tests that guard important layer boundaries.

## MVP Exit Checklist

The MVP should be considered complete when the repository can reliably
demonstrate one end-to-end registry path without claiming future guarantees.

- [ ] Commit and push the current PoC/MVP implementation.
- [ ] Keep `docs/PLAN.md`, `docs/V0_PLAN.md`, and `docs/design/*` aligned with
      the implemented v0 behavior.
- [ ] Keep the documented local demo flow runnable from a clean checkout:
      install, start server, publish example, verify release, verify event log,
      inspect npm projection, and install through npm.
- [ ] Keep the Docker demo flow runnable with `pnpm smoke:docker`.
- [ ] Ensure new public errors are structured and unexpected 500s are logged
      with `console.error`.
- [ ] Avoid adding npm-specific assumptions to core, protocol, auth, storage,
      or transport packages.
- [ ] Avoid adding new protocol semantics that are not already covered by the
      design documents.

Required gates before treating a change as MVP-ready:

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm smoke:docker
git diff --check
git diff --cached --check
```

## V0 Hardening Checklist

After the MVP path is committed, v0 should harden the current shape rather than
expand into every ecosystem at once.

- [ ] Add CI that runs test, lint, typecheck, build, and Docker smoke where the
      runner supports Docker.
- [ ] Document the current v0 security model clearly: domain well-known binding,
      signed write intents, authorization proofs, and current limitations.
- [ ] Improve operator documentation for persistent data directories, backups,
      restore drills, and container deployment.
- [ ] Add migration guidance for local SQLite schema changes.
- [ ] Strengthen public verifier behavior around event-log pages, event-by-id
      reads, object descriptor headers, and digest mismatches.
- [ ] Add clearer key compromise guidance for v0 operators, without inventing
      new public policy events before they are designed.
- [ ] Keep adapter conformance coverage growing as storage behavior becomes
      more important.

## Production Storage Roadmap

V0 local storage is SQLite plus filesystem. Production storage must remain
swappable behind adapters.

- [ ] Define production storage adapter requirements separately from local PoC
      storage behavior.
- [ ] Add a production database adapter candidate, such as Postgres or
      DynamoDB.
- [ ] Add a production object storage adapter candidate, such as S3, R2, or
      GCS.
- [ ] Add queue adapter support for async derived work.
- [ ] Define backup, restore, retention, and disaster-recovery expectations.
- [ ] Add load and concurrency tests for publish, package reads, event reads,
      object reads, and npm projection reads.

## Transparency Roadmap

V0 provides release verification and an append-only event model. It does not
yet provide a complete transparency log.

- [ ] Keep canonical JSON and deterministic event digests as stable v0
      primitives.
- [ ] Keep public release verification independent from the convenience server
      verifier endpoint.
- [ ] Design public signed-intent representation before claiming independent
      public signature verification from event data alone.
- [ ] Design checkpoint objects before adding checkpoint endpoints.
- [ ] Design inclusion proof and consistency proof formats.
- [ ] Design witness discovery and witness threshold policy.
- [ ] Build mirror and auditor tooling that can replay events and verify
      objects without private database access.

## Ecosystem Projection Roadmap

npm is the v0 development projection. Other ecosystems should be added as
projections over Regesta-native objects, not as changes to the core model.

- [ ] Keep npm-specific processing and projection in npm-related packages and
      server layers.
- [ ] Define PyPI projection design before implementing Simple API behavior.
- [ ] Define Cargo projection design before implementing crate index behavior.
- [ ] Define Go projection design before implementing module proxy behavior.
- [ ] Define OCI projection design before implementing manifest and blob
      behavior.
- [ ] Keep package id inference in clients and ecosystem adapters, not in core.

## Auth and Governance Roadmap

V0 has no user system. It uses domain-bound signatures. Future auth can add
user and passkey flows without replacing domain ownership.

- [ ] Keep v0 domain well-known binding as the minimum write authority model.
- [ ] Design key rotation and revocation behavior.
- [ ] Design package freeze and compromise response behavior.
- [ ] Design future UID plus passkey user accounts.
- [ ] Design domain claim flows with DNS TXT verification.
- [ ] Design owner/admin/transfer rules for claimed domains.
- [ ] Design community governance so the registry is not controlled by a single
      company or operator.

## Explicit Non-Goals For Current V0

- [ ] Do not claim trusted builds or reproducible builds.
- [ ] Do not claim compatibility declarations are verified.
- [ ] Do not define a generic dependency model in the core manifest.
- [ ] Do not make npm packuments or npm tarballs the internal data model.
- [ ] Do not add checkpoint, witness, or proof endpoints before their object
      formats are designed.
