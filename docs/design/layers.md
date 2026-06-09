# Layer Architecture

Regesta should be a universal package registry whose core remains ecosystem-neutral. npm, PyPI, Cargo, Go, OCI, and future ecosystems are projections over Regesta-native objects, not the internal data model.

A server implementation may have a composition root that wires these layers together. That composition root is not the transport layer itself: transport modules route requests and apply HTTP mechanics, while business semantics stay in core, trust, storage, artifact processing, and projection modules.

## 1. Transport

The transport layer owns HTTP mechanics only:

- host and path routing;
- CORS;
- request logging;
- health and deployment information;
- error boundaries;
- sub-application mounting.

It decides which layer receives a request, for example:

```text
registry.dev/*       -> core API
npm.registry.dev/*   -> npm projection
pypi.registry.dev/*  -> PyPI projection
cargo.registry.dev/* -> Cargo projection
```

Transport must not own package, release, trust, storage, or ecosystem semantics. Its only semantic decision is which layer should receive the request.

## 2. Core Registry

The core registry owns Regesta-native state and APIs:

- package ids such as `npm:dev.localhost/hello-regesta`;
- release manifests;
- channels;
- artifacts;
- object addressing;
- event log;
- publish write path;
- package state APIs;
- release verification.

Core APIs expose neutral objects:

```text
POST /api/v0/releases
GET  /api/v0/packages/:id
GET  /api/v0/packages/:id/channels/:channel
GET  /api/v0/objects/:digest
GET  /api/v0/events
```

The core registry must not depend on npm, PyPI, Cargo, Go, OCI, or other ecosystem projection logic. It stores Regesta release manifests and event data, not npm packuments as its primary model.

Core may expose small release-level metadata that is ecosystem-neutral enough to be useful across projections, such as `metadata.description`. It should not define generic dependency, platform resolver, or package-manager-specific schemas.

## 3. Auth / Trust

The auth and trust layer is independent from transport and ecosystems. It owns:

- domain well-known discovery;
- signed write intents;
- canonical write payloads;
- artifact descriptor binding for client-controlled manifest fields;
- Ed25519 verification;
- authorization proofs;
- future passkey, user, and domain-claim flows;
- future transparency checkpoints.

V0 uses:

```text
domain well-known + Ed25519 signature
```

Future trust modes can include domain-based publishing, user-based publishing, passkeys, and hardened domain plus passkey publish flows.

Server composition code may wire trust services into core route handlers, but core should receive verifier callbacks and domain-binding fetch functions rather than importing the trust implementation directly.

## 4. Storage Adapters

All persistence must go through adapters:

- database for releases, channels, and events;
- object storage for artifact, source, and manifest bytes;
- queue for future async jobs;
- signing or KMS for future server-side signing;
- checkpoint store for future transparency logs.

Local V0 uses SQLite plus filesystem object storage. Production deployments should be able to use Postgres, DynamoDB, S3, R2, GCS, queues, and managed signing services without changing protocol semantics.

Write adapters must preserve event/projection consistency. For publish, the accepted event, immutable release projection, and default channel projection should be committed atomically, or none of them should become visible. Adapters should reject publish commits whose event does not describe the stored release manifest and manifest descriptor, whose manifest descriptor does not match the canonical manifest bytes, or whose release manifest contains invalid object descriptors. Channel update/delete writes should likewise commit the channel event and channel projection mutation atomically. If a channel event declares `previousVersion`, adapters should reject the write when the stored channel value changed before commit. The event log remains the source of truth, but V0 read APIs should not observe partially applied writes.

The public storage port should expose these atomic write commits rather than separate release, channel, and event projection mutations. Adapter-internal helpers may exist for migrations or tests, but core and server code should not depend on them.

Events persisted by storage adapters should be valid registry facts, not only matching hashes. The event fact rules belong to the core registry and should be shared by storage adapters, replay helpers, mirrors, and auditors. Before accepting an event, adapters should verify its canonical event id and reject invalid package ids, object/spec versions, digests, empty channel/version fields, non-canonical timestamps, or authorization proofs whose domain does not match the package owner or whose `signedAt` does not match the event timestamp. Signature verification remains in the Auth / Trust layer.

Event log reads should support cursor-based pages so transparency clients, mirrors, and auditors do not have to scan the entire registry log for every sync. Public HTTP event APIs should use the cursor-capable storage read path even when a caller omits pagination parameters, so implementations can add bounded defaults without changing call sites.

## 5. Artifact Processing

Artifact processing understands uploaded artifacts without changing the core model. It may extract ecosystem-native metadata and attach it to artifact descriptors as `ecosystemMetadata`. It may also promote a very small neutral subset, such as a package description, into normalized release metadata before the core manifest is created.

Artifact processing must not turn server-derived projection metadata into a domain-signed claim. The v0 publish signature binds client-controlled artifact descriptor fields through `artifactDescriptorDigest`, while server-derived fields such as `ecosystemMetadata` remain auditable registry output.

For npm, an artifact processor can:

- read the npm tarball;
- extract `package/package.json`;
- verify package name and version;
- extract package description for release metadata;
- extract dependencies, engines, OS, CPU, libc, bin, and package-manager metadata for artifact-level `ecosystemMetadata`.

Core does not define a generic dependency language. Each ecosystem extracts and projects its own resolver metadata, while only explicitly allowed neutral metadata becomes release metadata.

Server implementations should compose artifact processors by ecosystem. V0 registers the npm processor by default, and future PyPI, Cargo, Go, OCI, or other processors should join that layer without changing the core registry APIs.

## 6. Ecosystem Projections

Projection layers expose package-manager-native APIs from core data.

The npm projection owns:

- packuments;
- version and tag endpoints;
- dist-tags;
- tarball URLs;
- npm metadata projection;
- upstream fallback.

Future projections can own:

- PyPI Simple API pages, wheels, sdists, and normalized Python names;
- Cargo crate index format and SemVer pre-release behavior;
- Go module proxy endpoints;
- OCI manifests, blobs, and tags.

Projection layers may read core state and artifacts. They must not make core depend on their package-manager protocol.

npm-native protocol shapes such as packuments, version manifests, and dist-tag responses belong to the npm projection package. They should not be exported from the generic Regesta protocol package.

## 7. Client / Publisher

Clients infer ecosystem data, build artifacts, sign write intents, and upload publish payloads.

The current `regesta` CLI is npm-first for V0 development. It may:

- infer canonical ids, versions, descriptions, exports, and repositories from `package.json`;
- call the package manager to produce an install tarball;
- produce a source archive;
- generate signed write intents;
- upload multipart publish requests.

Future community clients can include `regesta-pypi`, `regesta-cargo`, `regesta-go`, and `regesta-oci`.

## 8. Transparency / Verification

The transparency and verification layer should grow from V0's event log and release verification into:

- canonical JSON;
- release manifest digests;
- event digests;
- append-only logs;
- checkpoints;
- inclusion proofs;
- mirror and auditor verification;
- reproducible or attested build proofs.

V0 should avoid claiming trusted builds until the proof machinery exists.

Detailed verification boundaries are tracked in [Transparency and verification design](transparency-verification.md).

## 9. Ops / Governance

Ops and governance are not package protocol, but they are part of operating resilient public infrastructure:

- metrics;
- audit logs;
- abuse handling;
- admin policy;
- key compromise response;
- domain claim policy;
- package takedown policy;
- community governance.

Regesta should remain community-driven and avoid control by a single company or operator.

Detailed operational requirements are tracked in [Ops and governance design](ops-governance.md).

## Composition Shape

The intended dependency direction is:

```text
HTTP Transport
  -> Core API
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
  -> Ops / Observability
```

## Metadata Flow

Package metadata should move through explicit layers. For example:

```text
package.json description
  -> client or npm artifact processor infer
  -> Regesta release metadata.description
  -> core API exposes metadata.description
  -> npm projection exposes description in packument and version manifest
```

`description` is core-readable release metadata. npm still projects it into npm-native fields.
