# Architecture

Regesta is organized as a registry kernel with explicit layers. The core model
stores ecosystem-neutral facts. Package-manager protocols, cloud platforms, and
storage engines are adapters around that model.

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
  -> Ops / Observability
```

## Architectural Invariants

The most important rule is dependency direction:

```text
transport can route to layers
projections can read core data
core must not depend on projections
storage must not know package-manager protocols
auth must not know transport or npm
```

This keeps Regesta from becoming an npm-shaped registry with generic naming.
The source of truth is Regesta-native release, object, channel, and event data.

Core invariants:

- package identity is canonical and ecosystem-aware;
- release manifests are immutable;
- objects are addressed by digest;
- public state changes are events;
- projections are derived views;
- package-manager metadata does not define the core model;
- infrastructure choices do not become protocol requirements.

## Transport Boundary

Transport owns HTTP mechanics:

- host and path routing;
- CORS;
- health and readiness routes;
- root deployment information;
- request logging;
- error boundaries;
- adapter mounting.

Transport answers one question: which layer should handle this request?

It must not decide what a package, release, dependency, channel, or trust proof
means. Those semantics belong to the core registry, auth/trust, artifact
processing, and projection layers.

Example routing shape:

```text
registry.dev/*       -> core API
npm.registry.dev/*   -> npm projection
pypi.registry.dev/*  -> PyPI projection
cargo.registry.dev/* -> Cargo projection
```

The route shape is deployer-controlled, but the layer boundary should remain
the same.

## Core Registry

Core owns neutral registry state:

- package ids;
- release manifests;
- artifacts;
- content-addressed objects;
- channels;
- events;
- publish flow;
- release verification.

Core stores Regesta-native facts. It does not store npm packuments, PyPI Simple
API pages, Cargo index files, Go proxy responses, or OCI manifests as the
primary model.

Package state is derived from package events. Release manifests are immutable.
Channels are mutable pointers, but channel changes are represented by events
rather than in-place release edits.

Core can expose a narrow neutral metadata surface, such as
`metadata.description`, when it is useful across ecosystems. It must not invent
a generic dependency model or flatten package-manager-specific resolver data
into universal fields.

## Auth And Trust

Auth validates write authority independently from transport and ecosystem
protocols.

The first trust primitive is domain-bound publishing:

1. The package id contains an owner domain, such as `npm:example.com/library`.
2. The owner domain publishes a discoverable trust binding.
3. A write request includes a signed intent.
4. The registry verifies the signature and intent before committing state.
5. The accepted event records the authorization proof.

The signed intent should describe the operation itself: package id, version,
digest set, timestamp, nonce, owner domain, and operation type. It should not
depend on a particular HTTP route.

This leaves room for stronger identity models:

- domain claim through DNS;
- UID-based accounts;
- passkey publishing;
- owner and admin roles;
- key rotation and revocation;
- domain plus passkey hardened publishing;
- transparency checkpoints and witnesses.

Auth should remain a trust layer, not a server framework feature and not an
npm-only rule.

## Storage Adapters

All persistent state goes through adapters:

- database for release, channel, event, and metadata state;
- object storage for source, artifact, manifest, and proof bytes;
- queue for derived or async work;
- signing or KMS services for server-side signing;
- checkpoint store for transparency data.

Single-node deployments can use embedded storage and filesystem-backed object
storage. Production deployments can use services such as Postgres, DynamoDB,
S3, R2, GCS, platform queues, or KMS.

Checkpoint storage is a future transparency adapter boundary. It should store
opaque checkpoint material, publication markers, and future witness statements
without teaching the core registry database how checkpoints, proofs, or witness
policies work. The storage shape is described in
[Operations](/operations#future-checkpoint-store-adapters).

The protocol must not force one storage vendor. Storage adapters are
responsible for preserving registry facts, atomicity, and durability within the
capabilities of their backend.

Operational backup, restore, retention, and disaster-recovery expectations are
documented in [Operations](/operations).

## Artifact Processing

Artifact processing understands uploaded artifacts without changing the core
model.

An npm artifact processor can read a tarball, inspect `package/package.json`,
and extract npm resolver metadata such as:

- dependencies;
- engines;
- binary entries;
- package description;
- OS, CPU, and libc constraints;
- native package metadata.

That data belongs to the artifact as ecosystem metadata. It lets the npm
projection answer npm resolver questions without making npm dependencies a
cross-ecosystem core schema.

Other processors can do the same for wheels, sdists, crates, Go modules, OCI
layers, or future package formats. The processor interprets the artifact. Core
preserves the neutral release facts.

## Ecosystem Projections

Projection layers expose package-manager-native APIs from Regesta-native data.
The boundary is detailed in [Ecosystem Projections](/projections).

Examples:

- npm projection renders packuments, versions, dist-tags, and tarball URLs;
- PyPI projection renders Simple API pages and Python package metadata;
- Cargo projection renders crate index entries;
- Go projection renders module proxy responses;
- OCI projection renders manifests, blobs, and tags.

Projections may read core objects and artifact metadata. They must not redefine
core identity, storage, authorization, or event semantics.

Native names are projection concerns. For example, npm can expose
`@some.dev/sdk`, while core stores `npm:some.dev/sdk`. That mapping belongs to
npm-aware clients and npm projection code.

## Progressive Migration

Ecosystem projections can act as compatibility layers for gradual adoption. A
team should be able to point an existing package manager at a Regesta-compatible
endpoint without migrating every dependency at once.

For npm, that means the npm projection may serve Regesta packages first and
fall back to `registry.npmjs.org` when a package is not present in Regesta.
Fallback metadata is compatibility behavior, not core registry state. When the
server projection handles fallback, tarball URLs in npm metadata point at the
npm projection host and redirect to upstream tarballs instead of proxying
bytes.

The same fallback can also happen in the client or package manager instead of
the server projection. For example, a client can try Regesta for domain-owned
packages and then resolve missing packages from the ecosystem's default
registry. The important boundary is that fallback policy belongs to the
projection or client layer; core remains the source of truth only for packages
published to Regesta.

## Transparency And Verification

Verification starts with deterministic bytes and deterministic state:

- canonical JSON for release and event data;
- object digests for immutable bytes;
- event digests for public state changes;
- replayable package state;
- release manifests that can be fetched and recomputed.

The larger transparency model adds:

- signed checkpoints;
- inclusion proofs;
- consistency proofs;
- witnesses;
- mirror protocols;
- auditor tooling.

The boundary matters. A registry can verify release integrity without claiming
global transparency. Stronger claims require explicit checkpoint, witness, and
proof formats.

## Publish Flow

A publish operation follows this architectural shape:

1. A client infers ecosystem metadata and prepares source plus install
   artifacts.
2. The client creates a signed write intent for the owner domain.
3. Transport accepts the request and routes it to the core publish API.
4. Artifact processors extract ecosystem metadata.
5. Auth verifies the domain binding and signed intent.
6. Core creates the release manifest and event.
7. Storage adapters persist objects, release state, channel state, and events.
8. Ecosystem projections can derive package-manager responses from the new
   core state.

The client and artifact processor understand ecosystem details. Core records
neutral facts and trust proofs.

## Publisher Client Boundary

Publisher clients are ecosystem adapters on the write path. They translate
native project layout into Regesta publish input, but they must not change the
core registry model.

The current CLI is npm-first for V0 development and compatibility testing. It
can infer `npm:<domain>/<name>` from `package.json`, ask the package manager to
produce an install tarball, create a source archive, and submit a signed
publish request.

Future PyPI, Cargo, Go, OCI, or other publisher clients should follow the same
shape:

- infer or require the canonical Regesta package id;
- apply the ecosystem's native package-name mapping rules;
- create ecosystem-native install artifacts without asking core to understand
  the package manager;
- create a source archive when source attachment is supported;
- collect resolver metadata that artifact processors can validate and project;
- create a signed write intent over the normalized publish input;
- send artifacts, source, config, and authorization to the core publish API.

The server should not run arbitrary ecosystem build systems to decide identity
or dependency semantics. If a client cannot infer an id or artifact shape
without lossy assumptions, it should require explicit Regesta configuration
instead of guessing.

## Read Flow

Most reads are derived:

1. A package manager requests a native projection endpoint.
2. Transport routes the request to the projection layer.
3. The projection reads package events, release manifests, objects, and
   artifact metadata.
4. The projection renders package-manager-native metadata.
5. Immutable bytes are served from content-addressed object storage.

This shape is cache-friendly. Immutable objects can be cached aggressively.
Mutable views can use validators and revalidation because they are derived from
stable facts.

## Ops And Governance

Operational features are not package protocol details, but they matter for a
public registry:

- metrics;
- audit logs;
- abuse handling;
- key compromise response;
- package freeze policy;
- takedown policy;
- witness operations;
- mirror operations;
- root key and governance policy.

Actions that affect public package state should become auditable public facts.
Operator-private metrics can stay private. Package freezes, compromise
responses, takedowns, transfers, and key rotations need explicit recording
rules before they become protocol guarantees.

The current governance boundary is documented in [Governance](/governance).
