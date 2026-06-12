# Mirroring

Regesta's long-term model includes mirror synchronization protocols,
checkpoints, witnesses, inclusion proofs, and fork procedures. V0 does not
define those protocol objects yet.

What V0 does provide is enough public surface to manually mirror and audit a
small registry view:

- paginated public events;
- immutable event reads by digest;
- immutable release envelopes;
- paginated object descriptor inventory;
- content-addressed object reads;
- replayable package state;
- verifier tooling for release, event-log, and package-state checks.

This page defines the V0 mirror synchronization profile over the current public
routes. It is not a checkpointed consensus or fork protocol.

## Public Surfaces

A mirror or auditor can read:

- `GET /events?limit=...`
- `GET /events?after=<event-id>&limit=...`
- `GET /events/sha256/<hex>`
- `GET /packages/<id>`
- `GET /packages/<id>/releases/<version>`
- `GET /packages/<id>/channels/<channel>`
- `GET /objects?limit=...`
- `GET /objects?after=<object-digest>&limit=...`
- `GET /objects/<digest>`

The npm projection can also be checked, but it is a derived compatibility view.
It should not be the source of truth for mirror state.

## Mirror Loop

A conservative V0 mirror loop is:

1. Start with no cursor.
2. Fetch `/events?limit=<n>`.
3. Store every event in the page by event id.
4. Fetch each event again from `/events/sha256/<hex>` and confirm it matches the
   event-log page entry.
5. For every `release.published` event, fetch the release envelope from
   `/packages/<id>/releases/<version>`.
6. Store the release manifest and manifest descriptor.
7. Fetch object inventory pages when checking for additional public objects.
8. Fetch the manifest object, source object, and artifact objects by digest.
9. Confirm every object descriptor matches the downloaded bytes.
10. Advance to `nextAfter` and repeat until an empty page is reached.
11. Replay package state from mirrored events and compare it with
    `/packages/<id>` for packages under audit.

The mirror should preserve raw bytes where possible. Canonical JSON digests and
object digests are part of verification, so changing formatting or normalizing
objects during storage can hide bugs. Release manifest descriptor checks must
hash the exact manifest object bytes, including the trailing newline after the
canonical JSON text.

## Synchronization Profile

V0 synchronization has two cursors:

- event cursor: the last event id accepted from `/events`;
- object cursor: the last object digest accepted from `/objects`.

The event cursor is the primary state cursor. Events are append-only registry
facts, and package state should be replayed from event pages. Mirrors should
fetch every event again by immutable event id before accepting it.

The object cursor is a descriptor inventory cursor. It is useful for discovering
public objects that are not reached from the sampled release events. It is not a
substitute for event replay, and it is not a snapshot. V0 object inventory pages
are ordered by digest, so a mirror that needs exhaustive object discovery should
periodically rescan object inventory from the beginning or compare with another
mirror.

A V0 sync pass should:

1. Fetch event pages until an empty page is reached or a configured page limit
   stops the pass.
2. For every event, verify the immutable event endpoint and store canonical
   event bytes.
3. For every publish event, fetch the release envelope and all referenced
   manifest, source, and artifact objects.
4. Fetch object inventory pages and store any additional object bytes whose
   descriptors are not already mirrored.
5. Write a local inventory containing event ids, package ids, release keys, and
   object digests observed during the pass.

If the pass stops before either the event tail or the object inventory tail, the
mirror result is partial and should not be used as a complete registry view.
Before checkpoints exist, a completed V0 sync pass proves only what that mirror
observed through public APIs.

## Public Auditor Toolchain

The V0 CLI can audit registry state without private database access:

- `verify-log` reads public event pages, fetches immutable event endpoints, and
  checks event replay.
- `verify-package` replays public events for one package and compares the
  result with `/packages/<id>`.
- `verify` checks one release envelope, its event, and its referenced objects.
- `mirror` stores public events, release envelopes, and object bytes in a local
  mirror directory.
- `compare-logs` compares two live public event-log views.
- `compare-mirrors` compares two local mirror directories offline.

This is not yet a checkpointed transparency system. It is enough for V0 mirrors
and auditors to replay sampled public state, verify object bytes, and detect
differences between observed registry views.

`verify-package` intentionally reads event-log pages until it reaches the tail,
then filters events for the requested package. That keeps the check grounded in
the public global log, but it means large registries should run it with explicit
`--limit` and `--max-pages` values or against a local mirror. Package-scoped
proofs, checkpoints, or compact inclusion proofs are future protocol work and
should not be assumed by V0 auditors.

## Auditor Checks

Current CLI checks cover the public verification path:

```sh
node --conditions=regesta-source packages/cli/src/index.ts verify-log \
  --registry https://registry.example

node --conditions=regesta-source packages/cli/src/index.ts verify-package \
  npm:some.dev/sdk \
  --registry https://registry.example

node --conditions=regesta-source packages/cli/src/index.ts verify \
  npm:some.dev/sdk@1.2.3 \
  --registry https://registry.example
```

For comparing two registry views, an auditor should compare:

- event-log tails reached from the same starting cursor;
- event bytes by event id;
- release envelopes by package id and version;
- object descriptors and object byte digests;
- package state replayed from events;
- package state served by `/packages/<id>`;
- projection responses only after the core facts match.

The V0 CLI includes an event-log comparison helper for the first part of this
workflow:

```sh
node --conditions=regesta-source packages/cli/src/index.ts compare-logs \
  https://registry-a.example \
  https://registry-b.example
```

It also includes a local mirror helper over the current public APIs:

```sh
node --conditions=regesta-source packages/cli/src/index.ts mirror ./mirror \
  --registry https://registry.example
```

The mirror helper reads event pages and `/objects` descriptor inventory, then
writes event JSON, release envelopes, object bytes, and a local inventory file.
The local inventory records the source registry URL, capture time, final event
cursor, observed event ids, object digests, package ids, release keys, mirror
status, and known problems. It is a tool artifact, not a protocol object.
Future mirror sync or checkpoint formats can build on the public descriptor
list.

Two local mirror directories can be compared without contacting either
registry again:

```sh
node --conditions=regesta-source packages/cli/src/index.ts compare-mirrors \
  ./mirror-a \
  ./mirror-b
```

This comparison checks local inventories, event files, release envelope files,
and object bytes. It is useful for sampled view comparison and offline audits,
but it is still bounded by the public data that each mirror previously fetched.

If two registries serve different event sequences before checkpoints and
witnesses exist, V0 can detect the difference but cannot provide a global
consistency proof.

## Registry View Comparison

V0 registry-view comparison should be core-first. An auditor should compare
Regesta-native facts before checking package-manager projections.

The comparison order is:

1. Compare event-log pages from the same cursor and page size.
2. Fetch every compared event again by event id.
3. Recompute event ids from canonical event bytes.
4. For publish events, fetch the release envelope by package id and version.
5. Fetch manifest, source, and artifact objects by digest.
6. Verify object descriptors against object bytes.
7. Replay package state from events.
8. Compare replayed state with `/packages/<id>`.
9. Compare projection responses only after the core facts match.

Differences should be classified by the lowest layer that disagrees:

| Class                 | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| Event divergence      | The registries expose different event ids or event order.                |
| Event mutation        | The same event id resolves to different bytes or invalid canonical data. |
| Object divergence     | A referenced object is missing or its bytes do not match its descriptor. |
| Release divergence    | A release envelope disagrees with the event or manifest object.          |
| State divergence      | Replayed package state disagrees with the served package state.          |
| Projection divergence | Core facts match, but a package-manager response differs.                |

Projection divergence is lower severity than core divergence. It may indicate a
cache issue, projection bug, fallback policy difference, or package-manager
compatibility difference. Core divergence means the registry views no longer
agree on Regesta-native facts.

Before checkpoints and witnesses exist, a V0 auditor can prove that two sampled
views differ, or that they matched for the sampled range. It cannot prove that a
registry never served a different view to another client.

## Manual Fork Bootstrap

V0 does not define a checkpoint-based fork procedure, but it does allow a
replacement operator or community mirror to preserve the public facts it can
observe.

A conservative manual fork bootstrap should:

1. Select the source registry URL and the event cursor range to preserve.
2. Run the mirror helper until it reaches an empty event page, or record that
   the mirror is intentionally partial.
3. Fetch every mirrored event again from its immutable event endpoint.
4. Verify release envelopes, manifest objects, source objects, and artifact
   objects by digest.
5. Replay package state from mirrored events and compare representative
   packages with the source registry's `/packages/<id>` responses.
6. Compare the resulting mirror with at least one independently fetched mirror
   when possible.
7. Publish the mirror inventory, source registry URL, fetch time, final event
   cursor, and known gaps before asking users to trust the replacement view.

This workflow is a recovery and accountability tool, not a global consistency
proof. Without checkpoints and witnesses, different clients may have observed
different event-log views. A fork operator should therefore disclose the exact
public evidence used to build the replacement registry and keep the raw
mirrored events and objects available for auditors.

The current V0 CLI writes a mirror directory; it does not yet provide a
general-purpose import command for a new registry operator. That import path
should replay Regesta-native events and copy content-addressed objects through
storage adapters instead of importing package-manager projection responses as
the source of truth.

## Current Limits

V0 does not yet provide:

- mirror sync manifests;
- signed checkpoints;
- witness discovery;
- inclusion proofs;
- consistency proofs;
- checkpoint-based fork rules;
- governance event comparison.

Those are future transparency and governance protocol work. Until then, mirrors
should treat V0 as replayable and inspectable, not globally witnessed.

## Open Transparency Decisions

Checkpoint, proof, and witness work should not start from implementation
convenience. Before Regesta defines those protocol objects, the project needs
explicit decisions for:

- what registry state a checkpoint commits to;
- whether checkpoint cadence is time-based, event-count-based, operator-driven,
  or a combination of those policies;
- how clients discover witnesses and decide which witness sets they trust;
- what a witness statement means when mirrors observe inconsistent registry
  views;
- how inclusion and consistency proofs interact with event ids, release
  envelopes, and object descriptors;
- how a fork should select a trusted checkpoint when operator governance fails.

Until those questions are answered, V0 mirror and auditor tooling should keep
using public event replay, immutable event reads, release envelopes, object
descriptors, and direct object digest checks as its source of evidence.
