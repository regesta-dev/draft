# Transparency and Verification Design

Status: draft.

This document defines the boundary between Regesta v0 verification and the future transparency-log system. It is a design boundary document, not a complete transparency-log protocol. Checkpoint formats, proof encodings, witness policies, and trusted build attestations need separate protocol designs before implementation.

## Purpose

Regesta should make registry history auditable by independent clients, mirrors, package managers, and security researchers.

Transparency and verification should answer:

- Was this release manifest encoded and addressed correctly?
- Do the source, install artifacts, and manifest bytes match their digests?
- Does the publish event match the stored release?
- Was the write authorized by the owner domain at publish time?
- Can package state be replayed from append-only events?
- Has the operator hidden, reordered, rewritten, or forked registry history?
- Which claims are proven, and which are only declarations?

V0 answers the first set of release-level questions. A full transparency log answers the global history questions later.

## V0 Verification Claims

V0 may claim:

- release manifests are canonical JSON objects addressed by digest;
- source archives are content-addressed;
- install artifacts are content-addressed;
- release publish events are append-only facts with deterministic event ids;
- channel mutations are append-only events;
- write authorization proofs snapshot the domain key and signed payload digest that the server verified at publish time;
- the release verifier can detect missing objects, digest mismatches, invalid manifest fields, invalid event ids, missing event log entries, and mismatched release/event data.

V0 must not claim:

- the source built the artifact;
- the artifact is safe;
- compatibility declarations were tested;
- the public event alone is enough to independently re-run Ed25519 signature verification for the write intent;
- the event log has an externally witnessed Merkle checkpoint;
- clients have inclusion or consistency proofs;
- the registry cannot present split views to different clients.

The short version is:

```text
V0 gives release verification and an append-only event model.
Full transparency requires checkpoints, proofs, witnesses, and mirror/auditor tooling.
```

## Verification Inputs

Independent release verification should be possible from public data:

- package id;
- release version;
- release manifest object;
- manifest object descriptor;
- source object descriptor and bytes;
- artifact object descriptors and bytes;
- publish event;
- relevant event log entries;
- authorization proof inside the event;
- owner domain binding snapshot digest recorded by the authorization proof.

The convenience verification endpoint can summarize this work, but it must not become the only verification path.

Independent verifiers may fetch object descriptor headers with `HEAD` before
downloading object bytes with `GET`. A descriptor-only check is not enough: the
verifier still needs to compare response headers, downloaded byte length, media
type, cache validator, and byte digest with the descriptors committed by the
release manifest. Object `HEAD` and `GET` responses should be rejected when
they omit `Content-Length`, `Content-Type`, or object-digest `ETag`.
Release and event JSON responses should also be rejected when their
`Content-Type` is not JSON or when they omit the event-id `ETag`, so
verification does not silently accept a response from the wrong projection or an
HTML error page that happens to parse.

## Canonical JSON and Digests

Public digests must be computed over deterministic bytes:

- release manifest digests use canonical manifest bytes;
- event ids use canonical event payload bytes with the `id` field excluded;
- authorization payload digests use canonical write-intent bytes;
- object digests are hashes of the exact stored object bytes.

Independent implementations should not need JavaScript object insertion order, Node.js behavior, or server-local database state to reproduce public digests.

## Authorization Proof Boundary

V0 publish writes are verified by the server before state changes are committed.
The server verifies the submitted write authorization against the owner domain's
well-known binding, checks that the signed intent matches the request body, and
records an authorization proof in the resulting event.

The current authorization proof records:

- owner domain;
- key id;
- Ed25519 public key snapshot;
- signature bytes;
- signed timestamp;
- signed payload digest;
- well-known binding digest.

This is a server-verified publish-time authorization proof. It is not yet a
standalone public signature proof, because the event does not expose the
canonical signed write intent or the nonce needed to reconstruct it. An
independent verifier can validate the proof envelope, key shape, digest shapes,
signature encoding, owner-domain match, event timestamp match, event digest, and
object integrity, but it cannot recompute the signed payload digest or re-run
Ed25519 verification from public event data alone.

Future protocol work should decide whether public events store the canonical
signed intent payload, or store enough canonical fields to reconstruct it,
including the nonce and operation-specific intent fields. Until that decision is
made, tools and documentation should describe v0 authorization proofs as
server-verified evidence, not as complete independent public signature proofs.

## Event Log Semantics

V0 events are append-only registry facts. The event log is the source of truth for registry state changes, while database rows and package-manager projections are derived views.

Minimum event-log requirements:

- every published release has a matching `release.published` event;
- every channel update/delete has a matching channel event;
- event ids are deterministic digests;
- event reads support cursor-based pagination;
- package state can be replayed from ordered release and channel events;
- storage adapters reject invalid events and reject duplicate event ids;
- release, channel, and event projections are committed atomically where the storage backend supports transactions.

V0 event ordering is enough for replay and auditing within one registry view. It is not enough to prove that all clients saw the same global log.

## Future Checkpoints and Proofs

Future transparency work should add a checkpointed append-only log.

Expected capabilities:

- signed checkpoints;
- log tree size;
- log root hash;
- inclusion proofs;
- consistency proofs;
- witness countersignatures;
- mirror synchronization;
- auditor verification.

The current TypeScript PoC should not invent a checkpoint wire format implicitly. Until a checkpoint protocol exists, checkpoint endpoints in design documents are future API targets, not implemented v0 guarantees.

## Mirrors and Auditors

Mirrors should be able to rebuild useful registry state from public data:

- event pages;
- release manifests;
- object descriptors;
- source and artifact objects;
- future checkpoints and proofs.

V0 mirrors should page through `GET /api/v0/events` until they reach an empty
tail page. They should treat each page as a mutable cursor response, verify
the page schema and cursor rules, reject duplicate event ids, then fetch each
event again by id through `GET /api/v0/events/{algorithm}/{hex}`. The
event-by-id response is the immutable public fact: mirrors should recompute
the event id, compare the canonical event body with the page entry, and verify
the event-id `ETag` before replaying package state.

Auditors should be able to verify:

- event digest correctness;
- manifest digest correctness;
- object availability;
- authorization proof structure;
- package state replay;
- projection consistency for selected ecosystems.

Mirrors and auditors should not need private database access.

## Trusted Builds and Attestations

V0 provenance is source-attached only. It preserves source and artifact bytes but does not prove the artifact was built from that source.

Future trust upgrades can include:

- reproducible rebuild proofs;
- trusted builder attestations;
- CI provenance;
- third-party verifier submissions;
- signed security signals.

These claims should be artifact-level or release-level proof objects, not vague prose fields. Regesta should not mark a release as trusted-build verified until verifiers, proof formats, and policy are explicitly defined.

## Ecosystem Projection Verification

Ecosystem projections should be verifiable back to core data:

- npm packuments derive from package state, release manifests, channels, and artifact metadata;
- npm tarball URLs point at install artifact objects;
- npm `dist-tags` derive from Regesta channels;
- future PyPI, Cargo, Go, and OCI projections should follow the same pattern.

Projection metadata may be package-manager-native, but the source of truth remains Regesta-native objects and events.

## Open Design Items

These items need explicit design before public protocol commitment:

- checkpoint object format;
- public signed-intent representation for independent authorization signature verification;
- log leaf hash domain separation;
- Merkle tree algorithm;
- inclusion proof encoding;
- consistency proof encoding;
- witness key discovery;
- witness threshold policy;
- mirror sync protocol;
- auditor report format;
- release status and policy action events;
- trusted build proof format.
