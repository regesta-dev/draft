# Ops and Governance Design

Status: draft.

This document describes operational and governance requirements for Regesta. It is not a package protocol specification and should not introduce new public object schemas by itself. Any future policy event, release status, checkpoint, witness, user, or domain-claim object needs a separate protocol design before implementation.

## Purpose

Regesta should be public package infrastructure, not a product controlled by one operator. Operational systems must therefore support:

- auditability;
- key compromise response;
- abuse handling;
- domain policy;
- scalable production operations;
- community governance;
- credible forkability.

The registry should make it possible for package managers, mirrors, auditors, and community-run infrastructure to verify what happened without trusting hidden operator state.

## Operational Boundaries

Ops and governance are separate from package-manager protocols:

- Transport handles HTTP mechanics.
- Core Registry handles release, object, channel, event, and verification semantics.
- Auth / Trust handles domain-bound write authorization.
- Storage Adapters persist registry state.
- Ecosystem Projections expose npm, PyPI, Cargo, Go, OCI, and future native protocols.
- Ops / Governance handles policies, observability, incident response, and operator accountability.

Ops tools may read core state, events, object metadata, request logs, and metrics. They should not create package facts through hidden side channels. If an operational action affects public package state, it needs an auditable public record.

## V0 Posture

V0 should stay small:

- domain-bound publishing through well-known Ed25519 keys;
- append-only release and channel events;
- content-addressed source and install artifacts;
- structured, self-classifying request logging;
- self-classifying, adapter-native readiness status for database, object
  storage, queue, and signer checks;
- request-correlated, self-classifying operator-local audit logging for
  accepted and rejected core write attempts;
- request-correlated, self-classifying console logging for unexpected 500
  errors;
- local SQLite and filesystem persistence for PoC deployments;
- Docker deployment for a complete local environment.

V0 should not claim:

- user account security;
- passkey-backed identity;
- neutral foundation governance;
- complete transparency-log inclusion proofs;
- trusted builder verification;
- automated malware verdicts;
- complete abuse automation.

The honest v0 claim is narrower: publish operations are domain-signed, release facts are content-addressed, and registry state changes are represented by auditable events.

## Compromise Response

The most dangerous incident is developer machine compromise. If an attacker controls the developer's browser session, 2FA state, package manager token, and local files, ordinary account security is not enough.

V0 reduces some token-theft risk by removing registry API tokens from the publish path. A release publish requires a domain-bound Ed25519 signature whose public key is discoverable from the owner domain's well-known binding. This does not fully solve machine compromise: if the attacker can read the private key or control the signing operation, they can still publish.

Operational response should separate facts from policy:

- Already accepted release events remain historical facts.
- New publishing can be frozen for a package, domain, key id, or ecosystem projection.
- Suspect releases can be marked or hidden from default distribution.
- Mirrors and auditors should be able to see the disputed event and the later policy action.
- Recovery should require a documented domain-owner proof, not only an operator dashboard click.

Future protocol work is needed for signed policy actions, release status, domain freezes, key compromise declarations, and public recovery records.

## Domain Policy

Domain ownership is a strong namespace signal, but it is not permanent by itself. Domains expire, change hands, and can be temporarily hijacked.

Policy requirements:

- A domain binding authorizes writes at the time of verification.
- Historical package ownership must not silently transfer when a domain expires or changes hands.
- Domain reclaim should be public, rate-limited, and reviewable for high-impact packages.
- High-impact packages should be encouraged to use stronger domain practices, such as DNS records, offline keys, hardware-backed signing, or multi-party review.
- Well-known key rotation should be supported without rewriting historical events.

Regesta should treat domain verification as an authorization mechanism, not a trademark court or permanent identity oracle.

## Abuse and Takedown

Package content is untrusted input. Some content may be malicious, illegal, privacy-invasive, or otherwise unsuitable for default distribution.

Principles:

- Do not rewrite the public event history.
- Do not pretend that immutable logs remove legal or safety obligations.
- Separate archival facts from default serving policy.
- Make policy actions auditable.
- Keep package-manager clients safe by default.
- Preserve enough metadata for mirrors and auditors to understand what changed.

Future protocol work should define how release status, restricted availability, takedown notices, dispute records, and appeal outcomes are represented.

## Observability

Production deployments need observability that does not become protocol truth:

- request logs;
- publish latency and failure metrics;
- object storage read/write metrics;
- database transaction metrics;
- queue lag;
- self-classifying derived queue enqueue failures;
- projection cache hit rates;
- request-correlated, self-classifying upstream fallback failures;
- verification failures;
- replay and mirror lag.

Metrics can be operator-local. Public safety-relevant facts should eventually be represented by signed events, checkpoints, or auditor reports.

## Scalability

Regesta should scale read-heavy package manager traffic without making one database the protocol bottleneck.

Operational goals:

- immutable object serving should be CDN-friendly;
- projection responses should be cacheable when derived from stable release facts;
- event log reads should support pagination and replay;
- storage adapters should allow production backends such as Postgres, DynamoDB, S3, R2, GCS, queues, and managed signing services;
- per-package write coordination should be abstract, not tied to a specific provider primitive;
- mirrors should be able to rebuild package state from public events and objects.

## Governance

Regesta should be community-driven and avoid capture by one company, cloud provider, or registry operator.

Governance requirements:

- open protocol development;
- open reference implementation;
- public design documents and issue discussion;
- documented policy for domain claims, disputes, and abuse;
- independent mirrors;
- independent witnesses for future checkpoints;
- root or policy keys not controlled by a single company;
- fork and replay tooling as a governance backstop.

Early governance can be maintainer-led, but the architecture should make a later neutral governance transition possible without rewriting the protocol.

## Future Design Items

These items should not be added implicitly through implementation shortcuts:

- user-based identity with UID and passkeys;
- domain claims through DNS TXT records;
- domain owner transfer;
- package/domain freeze records;
- signed administrative policy actions;
- release status and takedown records;
- transparency checkpoints and witness signatures;
- inclusion and consistency proofs;
- trusted builder and rebuild attestations;
- auditor-signed security signals.

Each item needs an explicit design before it becomes part of the public protocol.
