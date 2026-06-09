# Architecture

Regesta is organized as layers. Each layer has one job, and the core registry
must stay ecosystem-neutral.

```text
HTTP Transport
  -> Core Registry API
      -> Auth / Trust
      -> Storage Adapters
      -> Artifact Processing
      -> Verification
  -> Ecosystem Projections
      -> npm
      -> PyPI
      -> Cargo
      -> Go
      -> OCI
```

## Transport

Transport owns HTTP mechanics only:

- host and path routing;
- CORS;
- health and readiness routes;
- root deployment information;
- request logging;
- error boundaries;
- sub-application mounting.

Transport must not own registry semantics. It decides where a request goes, not
what a package or release means.

## Core Registry

Core owns Regesta-native state:

- package ids;
- release manifests;
- artifacts;
- content-addressed objects;
- channels;
- events;
- publish flow;
- release verification.

Core stores release manifests and event data. It does not store npm packuments,
PyPI pages, Cargo index files, or other ecosystem-native views as the primary
model.

## Auth And Trust

V0 write authority is domain-bound:

1. The package id includes an owner domain, such as
   `npm:example.com/library`.
2. The server discovers a well-known domain binding.
3. The write request includes an Ed25519 signed intent.
4. The server verifies the intent before committing registry state.
5. The accepted event stores an authorization proof.

V0 has no user account system. Future auth can add UID, passkey, domain claim,
owner/admin, and transfer flows without replacing domain ownership.

## Storage Adapters

All persistent state goes through adapters.

Local V0 uses:

- SQLite for releases, channels, and events;
- filesystem object storage;
- a local append-only derived queue file.

Production storage should be swappable:

- database: Postgres, DynamoDB, or similar;
- object storage: S3, R2, GCS, or similar;
- queue: platform queue or durable worker queue;
- signing/KMS: future server-side signing adapters.

Local container disk is not durable unless it is backed by an external volume.

## Artifact Processing

Artifact processing understands uploaded artifacts without changing the core
model.

The npm processor reads npm tarballs and extracts resolver metadata from
`package/package.json`, such as dependencies, engines, binary entries,
description, OS, CPU, and libc fields. Resolver-specific metadata is attached
to the relevant artifact as `ecosystemMetadata`.

Core does not define a generic dependency model. Each ecosystem owns its own
resolver metadata and projection rules.

## Ecosystem Projections

Projection layers expose package-manager-native APIs from Regesta-native data.

The npm projection currently provides:

- packuments;
- version reads;
- dist-tags;
- tarball reads;
- npm-compatible metadata;
- upstream npmjs.org fallback without tarball proxying.

Future projections should follow the same pattern: they may read core objects
and artifact metadata, but they must not redefine core identity, storage, or
event semantics.

## Verification And Transparency

V0 provides release verification and an append-only event model. It can detect
missing objects, digest mismatches, invalid event ids, release/event
mismatches, and invalid package replay state.

V0 is not a complete transparency log. Full transparency still needs signed
checkpoints, inclusion proofs, consistency proofs, witnesses, mirrors, and
auditor tooling.

## Governance And Operations

Regesta should be community-driven infrastructure. Operational policy should be
auditable, and the registry should avoid permanent capture by one company,
operator, or ecosystem.

Future operations work includes metrics, audit logs, abuse handling, key
compromise response, package freeze policy, takedown policy, and community
governance.
