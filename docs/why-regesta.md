# Why Regesta

Regesta starts from a simple position: package distribution is public
infrastructure. A registry should not be only a private database exposed through
package-manager-compatible endpoints. It should publish verifiable facts about
package identity, releases, artifacts, ownership, policy, and history.

The goal is a registry kernel that can serve many ecosystems without becoming
owned by any single ecosystem, platform, company, or runtime.

## The Registry Should Publish Facts

Most registries are useful because they answer simple questions quickly:

- what package exists;
- what versions exist;
- where the install artifact can be downloaded.

Regesta is designed around harder questions:

- Which exact bytes were accepted for this release?
- Which source and artifact objects belong to it?
- Who or what was authorized to publish it?
- Which public state changes happened after publication?
- Can a mirror replay the same state without private database access?
- Can an auditor detect rewritten or hidden history?
- Can the ecosystem keep operating if one registry operator changes policy or
  disappears?

Those questions should not require privileged operator access. They should be
answered by public objects, public events, deterministic projections, and
independent verification.

## Registry Kernel, Not Ecosystem Clone

Regesta is not a prettier npm registry, a PyPI clone, or a Cargo index with
extra metadata. It is a neutral registry kernel with ecosystem-native
projections.

The kernel owns stable registry facts:

- package ids;
- release manifests;
- source and install artifacts;
- content-addressed objects;
- channels;
- append-only events;
- verification rules;
- policy actions that affect package state.

Ecosystem APIs are projections over those facts. npm packuments, PyPI Simple
API pages, Cargo index entries, Go module proxy responses, and OCI manifests
should be derived views. They are compatibility surfaces, not the source of
truth.

## A Public State Machine

The long-term model is a public, verifiable state machine:

```text
append-only event log
+ content-addressed objects
+ deterministic projections
+ open protocols
+ public mirrors
+ independent witnesses
```

The database is an implementation detail. The public source of truth is the log
and the objects. A registry implementation can use any suitable storage
backend, but the ecosystem should be able to verify the public state it serves.

## Identity Should Be Portable

Regesta package identity is domain-anchored:

```text
ecosystem:domain/name
```

Examples:

```text
npm:some.dev/sdk
pypi:some.dev/sdk
cargo:some.dev/sdk
go:some.dev/sdk
oci:some.dev/sdk
```

The domain is the ownership anchor. It avoids starting from global username
scarcity, package squatting, or an operator-controlled namespace. Ecosystem
clients can still expose native names. For example, npm tooling can map
`npm:some.dev/sdk` to `@some.dev/sdk`.

The canonical identity belongs to the registry protocol. Native ecosystem names
belong to clients and projections.

## Source And Artifacts Belong Together

Regesta should preserve both source and installable artifacts as first-class
objects. Source matters for inspection, long-term preservation, AI tooling,
audits, and future rebuild verification. Install artifacts matter because
package managers need the exact bytes they can consume today.

The registry should be honest about what it knows:

- content-addressed objects prove byte identity;
- release manifests describe what was accepted;
- events describe public state changes;
- signatures and authorization proofs describe publish authority;
- build provenance or reproducibility must be explicit when claimed.

The registry should not imply that an artifact is safe, compatible, or
reproducibly built unless a dedicated protocol proves that claim.

## Transparency Must Be Verifiable

Transparency is not a dashboard feature. It is a protocol property.

Regesta should make it possible to:

- fetch immutable objects by digest;
- replay package state from append-only events;
- recompute release and event digests;
- compare registry views across mirrors;
- verify signed checkpoints;
- use witnesses to detect inconsistent histories;
- audit policy actions such as yanks, freezes, takedowns, and key rotations.

This does not make every package safe. It makes registry behavior inspectable.
That is the foundation for stronger security, better governance, and healthier
package ecosystems.

## Mirrorability Is Governance

Mirrorability is not only an availability feature. It is a governance backstop.

A healthy registry ecosystem should allow independent parties to:

- mirror public objects;
- mirror public event logs;
- replay registry state;
- audit operator behavior;
- recover from outages;
- fork from trusted checkpoints when governance fails.

Forkability should not be a normal workflow. It should be possible enough to
prevent permanent capture.

## Performance Should Follow The Model

Regesta is designed so high performance and scalability follow from the data
model:

- immutable objects are content-addressed and cacheable;
- package-manager projections are deterministic derived views;
- hot read paths can be served through CDN or object storage;
- write paths are explicit and auditable;
- storage, queue, signing, and checkpoint services sit behind adapters;
- deployments can scale without changing the protocol.

The protocol should not depend on one cloud provider, one serverless runtime,
one database, or one package manager.

## Community Over Capture

Regesta should be community-driven infrastructure. That affects the protocol as
much as it affects project governance.

The system should be designed so that no single operator can permanently
capture the ecosystem:

- public log;
- signed checkpoints;
- independent witnesses;
- mirror protocol;
- open implementation;
- replay and fork tooling;
- governance actions represented as auditable facts.

Community-driven does not mean policy-free. It means important rules should be
explicit, reviewable, and not hidden inside one operator's private database.

## The Long-Term Bet

The long-term bet is that package registries should become verifiable public
infrastructure:

- neutral across ecosystems;
- portable across platforms;
- source-attached and content-addressed;
- transparent by default;
- efficient to mirror and cache;
- friendly to humans, package managers, security tools, and AI agents;
- governed by open protocols rather than permanent operator trust.

Regesta exists to test and refine that model.
