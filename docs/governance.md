# Governance

Regesta treats governance as part of registry safety, not as private operator
state hidden behind package-manager APIs.

The long-term goal is that actions affecting package availability, ownership,
trust, or visibility become public facts that mirrors and auditors can inspect.
V0 does not define those governance event types yet. Until they exist, an
implementation should prefer conservative operator policy over pretending that
private decisions are protocol guarantees.

## Current Boundary

V0 protocol state currently covers:

- release publication;
- channel updates and deletes;
- content-addressed source, artifact, and manifest objects;
- domain-bound write authorization proofs;
- public event replay for package state.

V0 does not yet define protocol-level objects for:

- package freezes;
- yanks;
- takedowns;
- domain claims;
- ownership transfer;
- key revocation;
- root key stewardship;
- witness participation;
- compromise response.

Those actions can be implemented as operator policy during experiments, but
they should not silently rewrite release manifests, object bytes, event ids, or
historical event order.

## Abuse And Takedown

Abuse handling should avoid making history unverifiable.

For V0, an operator can choose projection-level policy such as refusing to serve
a package through npm compatibility endpoints, returning structured errors, or
blocking future writes. That is different from deleting or mutating the
underlying public facts.

When legal or safety requirements force object removal, the operator should
record the scope and reason outside the V0 protocol and keep package-state
responses internally consistent. Future protocol work should represent these
actions as auditable events instead of relying on private database flags.

V0 abuse handling should follow a narrow decision path:

1. Record the report, reporter contact when available, package id, version,
   channel, object digest, and projection route involved.
2. Preserve relevant event ids, release envelopes, object descriptors, and
   object bytes before taking action.
3. Classify the issue: malware, credential theft, impersonation, spam,
   namespace abuse, legal request, privacy/safety issue, or operational error.
4. Choose the least destructive action that protects users.
5. Publish a human-readable notice when doing so does not worsen the harm.
6. Keep enough records for owner appeal, mirror review, and future governance
   event migration.

V0 operator actions should be scoped:

- block future writes for an owner domain or package id;
- suppress package-manager projection responses for a package, version,
  channel, or artifact;
- return structured compatibility-layer errors for suppressed projection reads;
- keep core package state replayable from events;
- keep immutable public facts available to mirrors and auditors when legally
  and safely possible.

Object removal should be the last resort. If an operator must remove bytes for
legal, privacy, or safety reasons, the operator should preserve the descriptor,
event references, removal reason, decision timestamp, and reviewer identity
outside the V0 protocol. Future governance events should make that record
public and replayable without exposing content that cannot be served.

Yanks and takedowns are not the same as normal channel changes. A package owner
can move or delete a channel through channel events, but an operator takedown is
policy intervention. V0 should not pretend that an operator takedown is a
package-owner channel decision.

## Compromise Response

The most serious case is full developer machine compromise. An attacker may
steal sessions, cookies, tokens, local keys, or passkey access to an unlocked
device.

Regesta's V0 mitigation is intentionally narrow:

- write authorization is bound to the owner domain;
- accepted events snapshot authorization proof material;
- signed write intents include artifact, source, config, package, version,
  timestamp, and nonce digests;
- replayed authorization payloads are rejected.

This helps make malicious writes attributable and replay-resistant. It does not
prove the developer's machine was clean.

Operators and package owners should respond by preserving evidence, rotating
domain keys, blocking new writes when necessary, and publishing clear recovery
information. Future protocol work should define auditable freeze, revocation,
recovery, and checkpoint behavior.

## V0 Incident Policy

V0 compromise handling is operator policy. It can restrict future behavior, but
it must not rewrite public history.

When a maintainer key, domain binding, package artifact, or registry operator
account is suspected to be compromised, the conservative response is:

1. Preserve evidence.
2. Stop new writes for affected package ids or owner domains.
3. Keep event logs, release manifests, and object bytes intact.
4. Rotate affected domain binding keys.
5. Mirror the current public event and object state for investigation.
6. Verify affected package state from public events.
7. Publish recovery information outside the V0 protocol.
8. Re-enable writes only after the owner domain has a clean binding and the
   affected package state has been audited.

For V0, a package freeze means blocking new writes and optionally suppressing
projection responses. It does not mean deleting releases, mutating channels
without events, changing object bytes, or editing event history.

Projection-level suppression can be useful when a known harmful artifact should
not be served to package-manager clients. That suppression is a compatibility
policy. Mirrors and auditors should still be able to inspect the underlying
Regesta-native facts unless legal or safety requirements force object removal.

Recovery should require at least:

- a rotated or confirmed domain binding;
- a public explanation of the affected package ids, versions, and channels;
- release verification for known-good versions;
- event-log replay for affected package state;
- mirror or auditor comparison when independent data is available;
- documented operator action for any package-manager projection suppression.

V0 cannot make old authorizations disappear. A key that was valid at write time
remains part of the historical event proof until future revocation or recovery
events define stronger semantics.

## Package Freeze And Compromise Response Behavior

A package freeze is a protective state, not a release mutation.

For V0, a freeze is operator policy that can affect future writes and projection
serving behavior. It must not change canonical release manifests, object bytes,
event ids, event order, or channel history without explicit channel events.

A freeze can be scoped to:

- an owner domain;
- a package id;
- a package version;
- a channel;
- one or more artifacts;
- one or more ecosystem projection routes.

The safest V0 freeze behavior is:

- reject new publish and channel writes for the frozen scope;
- keep core event and object reads internally consistent;
- keep mirrors and auditors able to inspect immutable facts when legally and
  safely possible;
- suppress package-manager projection responses only when serving the package
  would put users at risk;
- record the operator reason, reviewer, timestamp, and affected scope outside
  the V0 protocol.

Compromise response should use freeze as a narrow control while the owner and
operator establish what happened. It should not become a hidden package
deletion mechanism.

Before unfreezing, the operator should require:

- clean domain binding keys;
- package-state replay for the affected scope;
- release verification for known-good versions;
- artifact review when malicious bytes are suspected;
- a recovery note that downstream users and mirrors can inspect;
- a decision about whether projection suppression should remain in place.

Future protocol-level freeze and recovery should become append-only public
facts. Before implementation, the design should specify how freeze, unfreeze,
recovery, appeal, and takedown records are replayed by mirrors without giving
operators a private mutable switch over public package history.

## Domain And Key Policy

The domain is the ownership anchor. A package id such as
`npm:some.dev/sdk` means that `some.dev` is the authority for writes to that
package namespace.

In V0, the server checks the current well-known domain binding at write time and
stores proof material in the accepted event. Historical verification should use
the event proof, not assume that the current domain binding still contains the
same key.

Future account-based flows can add UID plus passkey accounts, DNS domain
claims, owner/admin roles, transfer rules, and hardened publish flows that
combine passkey approval with domain signatures. Those features should extend
the trust layer without moving package identity into an operator-owned username
namespace.

## Future Account And Domain Trust

V0 intentionally has no user account system. Future account-based flows should
add human and organizational administration without replacing domain-scoped
package identity.

The account model should use stable UIDs rather than usernames as authority
identifiers. Usernames, handles, display names, and profile URLs can change and
can collide across communities. A UID can own credentials, claim domains, hold
roles, and appear in auditable governance records without becoming part of the
package id.

Passkeys are the preferred future default for interactive account approval.
They should authorize account actions such as signing in, approving publishes,
adding credentials, accepting role changes, and confirming transfers. They
should not make the registry an operator-owned username namespace, and they
should not weaken the domain-bound publishing model.

Domain claims should prove control of an owner domain before a UID can
administer that namespace. The expected claim path is DNS-based:

1. The registry creates a domain claim challenge.
2. The claimant publishes a DNS TXT record under the domain.
3. The registry verifies the challenge and binds the domain claim to a UID.
4. Future writes for that domain can require the claimed account policy in
   addition to the domain signing key.

DNS claims should be high-weight but optional. Some domains will not want the
operational burden. For high-impact domains, a DNS claim can reduce the risk of
single-key compromise by requiring both domain control history and account
approval policy.

The role model should separate domain administration from package-manager
projection behavior:

- owner: the UID that controls domain-level administration and transfer;
- admin: a delegated UID that can publish, rotate delegated publishing
  credentials, or manage package-level policy within the owner's scope;
- transfer recipient: a UID that can receive ownership only through an explicit
  transfer flow.

The first successful domain claim can become the initial owner. Owners can add
or remove admins, and owners can transfer ownership. A transfer should affect
future administration only; it must not rewrite old package ids, release
manifests, object bytes, events, or historical authorization proofs.

Hardened publishing should combine account approval and domain signatures. A
future hardened publish flow should require:

- passkey approval from an authorized UID;
- a domain-bound signature over the publish intent;
- agreement between both proofs on package id, owner domain, version, digest
  set, timestamp, nonce, and operation type;
- replay protection for both the account approval and the domain signature.

This gives operators and package owners a stronger policy than either factor
alone. A stolen passkey session should not be enough to publish for a hardened
domain without the domain signing key. A stolen domain signing key should not be
enough to publish for a hardened domain without account approval. Full machine
compromise can still defeat local controls, so recovery, freeze, mirror, and
auditor workflows remain necessary.

Future account, claim, role, and transfer changes should become auditable facts
once governance events exist. Until then, they are design targets, not V0
protocol guarantees.

## Key Lifecycle Boundary

V0 supports key replacement through the domain well-known binding used for new
writes. If an owner removes an old key from the well-known response and adds a
new key, future publish requests must use a key that the server accepts for the
domain at write time.

That is not the same as protocol-level revocation. Historical events keep the
authorization proof that was accepted when the event was written. V0 does not
yet define a public revocation event, freeze event, recovery event, or
checkpoint rule that tells mirrors how to reinterpret old authorizations after a
compromise.

Until those events exist, operators should treat suspected key compromise as an
operational incident:

- preserve the event log and object bytes as evidence;
- block new writes for affected namespaces when necessary;
- rotate the domain binding keys;
- publish recovery information out of band;
- avoid mutating historical release manifests or event order.

Future protocol work should define auditable revocation, freeze, recovery, and
key-rotation semantics before claiming that Regesta can fully contain a stolen
publisher key.

## Key Rotation And Revocation Behavior

Key rotation and key revocation are related, but they are not the same
operation.

For V0, key rotation means changing the domain binding for future writes:

- publish the new public key in the owner domain's well-known binding;
- stop signing new write intents with the old private key;
- allow the registry to verify future writes against the current binding;
- keep historical events verifiable with the authorization proof that was
  accepted when each event was written.

For V0, removing a key from the current domain binding does not invalidate old
events. Old release and channel events remain part of the public history because
their accepted authorization proof is already recorded. A verifier should not
reinterpret historical events only because today's well-known binding is
different.

For V0, revocation is an operational incident response:

- block new writes for the affected domain or package ids when necessary;
- rotate the domain binding to clean keys;
- preserve event, release, and object evidence;
- suppress harmful projection responses only as explicit operator policy;
- publish recovery information outside the protocol.

That operational revocation can protect future users, but it is not a
protocol-level revocation proof. Mirrors and auditors need append-only public
facts before they can consistently interpret a key as revoked across registry
views.

Future protocol-level revocation should be modeled as auditable facts, not
private database flags. Before implementation, the design should specify:

- the scope of a revocation: domain, package id, key id, public key, version,
  channel, or artifact;
- whether it blocks only future writes or also changes package-manager
  availability;
- how it references the evidence being revoked without mutating old events;
- how mirrors replay it alongside release and channel events;
- how recovery or appeal records are represented;
- how checkpointed histories and witnesses observe the change.

Until those protocol events exist, Regesta should use conservative operator
policy for compromise response while keeping core history replayable.

## Root Key Stewardship

V0 does not define a protocol root key, checkpoint signing key, witness key, or
global governance key. Domain publishing keys are owner-domain keys, not
ecosystem root keys.

Future root or checkpoint keys should be treated as community infrastructure,
not operator secrets. Stewardship rules should require:

- public purpose and scope for each root key;
- separation between operator deployment keys and ecosystem governance keys;
- multi-party custody or threshold control for keys that can affect global
  trust;
- documented key ceremonies for creation, rotation, and retirement;
- public emergency procedures with narrow scope and review;
- auditable records for key changes;
- enough independent mirrors and witnesses to detect inconsistent histories.

No single company, hosting provider, registry operator, or package ecosystem
should be able to unilaterally redefine global trust for Regesta.

## Witness And Mirror Participation

Mirrors and witnesses are governance participants because they make capture,
rewrites, and selective history harder.

For V0, mirrors can participate without permission by reading public events,
release envelopes, and objects. They can replay package state and compare local
mirror directories with the CLI tooling. This is an auditor workflow, not a
global consensus protocol.

Future witness participation should be open but accountable. A useful witness
set should include independent operators across different organizations,
jurisdictions, infrastructure providers, and package ecosystems. Participation
rules should define:

- how witnesses are discovered;
- what public statements a witness signs;
- how clients choose witness thresholds;
- how witnesses are removed or distrusted;
- how mirrors and witnesses report inconsistent registry views;
- how forks use trusted checkpoints during governance failure.

Those witness and checkpoint formats are not part of V0. Until they exist,
Regesta should describe mirrors as replayable and inspectable, not globally
witnessed.

## Community Control

Regesta should remain community-driven infrastructure. The protocol should make
capture expensive by supporting:

- open specifications and reference implementations;
- independently operated mirrors;
- independent witnesses;
- replay and verification tooling;
- auditable governance actions;
- documented root key and recovery procedures.

An operator may run a registry instance, but the ecosystem should not depend on
permanent trust in one company, cloud provider, package manager, or database.
