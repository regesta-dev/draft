# Operations

Regesta separates protocol facts from operational storage choices. The protocol
defines releases, objects, channels, events, and verification rules. Operators
choose the database, object store, queue, signer, and deployment platform.

V0 is not a production registry, but the local implementation already has one
important operational rule: persistent state must live outside the ephemeral
server process.

## Persistent State

The local V0 server uses `REGESTA_DATA_DIR` as the storage root.

That directory contains:

- SQLite registry metadata for releases, channels, events, and authorization
  replay protection;
- filesystem object storage for source archives, install artifacts, release
  manifests, and other content-addressed bytes;
- local queue data for derived or async work;
- local signer readiness state.

Container images must treat local container disk as disposable. In the demo
container, `/data` is the durable mount. In another deployment, the equivalent
state must live in external services such as a managed database, object store,
queue, signer, or KMS.

## Backup Boundary

A backup must preserve a consistent view of:

- registry database state;
- object bytes;
- object metadata;
- queue state when queued work must survive restore;
- signer or KMS configuration needed by the deployment.

Database-only backups are incomplete because releases reference
content-addressed objects. Object-only backups are incomplete because package
state is replayed from events stored in the database.

For the local SQLite/filesystem adapter, a conservative backup should stop
writes, snapshot the whole `REGESTA_DATA_DIR`, then resume service. Future
production adapters should provide backend-specific snapshot guarantees such as
database point-in-time recovery paired with object-store versioning.

## Restore Checks

After restoring state, an operator should verify the registry from public data,
not only check that files exist.

Minimum restore checks:

- `/ready` returns healthy storage status;
- public event log verification succeeds;
- package-state verification succeeds for representative packages;
- release verification succeeds for representative versions;
- npm projection reads still resolve known packages;
- object reads by digest return bytes matching their descriptors.

The local smoke scripts cover a small version of this loop. `pnpm smoke:docker`
checks persistence across a container restart, and `pnpm smoke:load` exercises
the local SQLite/filesystem adapters under repeated reads.

## Load Smoke Profiles

`pnpm smoke:load` is a repeatable local gate for the SQLite/filesystem V0
adapter path. It publishes packages, reads core package state, reads events,
reads objects, and reads the npm projection.

The script supports two profiles:

| Profile | Packages | Read loops | Publish max | Read max |
| ------- | -------- | ---------- | ----------- | -------- |
| `smoke` | 3        | 25         | 30s         | 30s      |
| `local` | 10       | 100        | 120s        | 120s     |

Use `REGESTA_LOAD_PROFILE=local pnpm smoke:load` for a heavier local run.

The profile defaults can be overridden with:

- `REGESTA_LOAD_PACKAGES`
- `REGESTA_LOAD_READS`
- `REGESTA_LOAD_MAX_PUBLISH_MS`
- `REGESTA_LOAD_MAX_READ_MS`

These thresholds are not production SLOs. They are regression gates for the
current local adapter implementation. Production deployments should define
their own profiles against their database, object storage, queue, signer, and
deployment platform.

## Production Load Gates

Regesta does not define protocol-level performance SLOs. Operators should still
publish repeatable load gates before calling a deployment production-ready.

Minimum pre-production gates:

| Gate                 | Purpose                         | Required checks                                                                                           |
| -------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ci-smoke`           | Fast pull-request signal        | `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm docs:build`, `pnpm smoke:load` with the `smoke` profile |
| `container-smoke`    | OCI portability and persistence | `pnpm smoke:docker` on a persistent volume                                                                |
| `adapter-local`      | Local adapter regression        | `REGESTA_LOAD_PROFILE=local pnpm smoke:load`                                                              |
| `adapter-production` | Production backend validation   | the same load shape against the intended database, object store, queue, signer, and deployment runtime    |
| `restore-smoke`      | Recovery confidence             | restore from backup, then run readiness, verifier, object, package-state, and projection checks           |

The production adapter gate should publish its parameters with the result:

- package count;
- read iterations;
- publish duration budget;
- read duration budget;
- concurrency level;
- runtime version;
- deployment target;
- database, object store, queue, and signer backend;
- data durability settings;
- whether the run used a cold or warm cache.

As a minimum, a production adapter profile should cover the same behavioral
surface as `pnpm smoke:load`: publish, package reads, release reads, event
reads, object reads, npm packuments, npm version manifests, npm tarball
redirects, and redirected object downloads. It should also include `/ready` and
object inventory reads when those endpoints are used by mirrors.

A production gate fails if:

- any write or read returns an unexpected error;
- release verification fails;
- event-log or package-state replay fails;
- object bytes do not match descriptors;
- authorization replay protection fails;
- the registry is not ready after deployment or restore;
- measured publish or read duration exceeds the declared profile budget.

Operators should treat these gates as minimum deployment evidence, not a claim
that the registry can handle every ecosystem workload. Public SLOs should be
defined separately from protocol compatibility.

## Retention

Regesta's default bias should be preservation.

Immutable release objects and events should not be garbage-collected while they
are still part of public release history. Removing or hiding data can break
mirrors, auditors, replay, and package-manager clients.

Retention policy should distinguish:

- immutable public facts, which should be preserved by default;
- derived caches, which can be rebuilt;
- local queues, which may be drained or replayed depending on job semantics;
- private operational logs, which can follow operator retention policy;
- legally or safety-sensitive content, which needs explicit governance policy.

Until governance events are defined, removals for abuse, legal, or compromise
response reasons should be treated as operator policy, not silent mutation of
historical protocol facts.

## Disaster Recovery

Disaster recovery should assume an operator may lose one instance, one storage
backend, or one cloud account.

The recovery posture should prefer:

- object storage replication;
- database point-in-time recovery;
- independent mirrors of public objects and event logs;
- verifier tooling that can replay state after restore;
- documented key rotation and compromise procedures;
- deployment manifests that can rebuild the service without changing protocol
  state.

Forkability is the long-term governance backstop. A healthy ecosystem should be
able to recover public package state from mirrored objects, event logs, and
future checkpoints even if one registry operator disappears.

The current manual mirror and auditor workflow is documented in
[Mirroring](/mirroring).

## Production Adapter Expectations

Production adapters should preserve the same logical guarantees as the local V0
adapters:

- release publication is atomic across release state, default channel state,
  and event insertion;
- event ids are immutable and unique;
- authorization payload digests reject replay;
- content-addressed objects are immutable by digest;
- object descriptors match stored bytes;
- queues do not corrupt messages under concurrent writers;
- readiness checks fail closed when a dependency is unavailable.

The backend can be Postgres, DynamoDB, S3, R2, GCS, a platform queue, KMS, or
another service. The registry core should continue to see only adapters.

## Future Checkpoint Store Adapters

Checkpoint storage is a future transparency adapter, not part of the V0 core
database schema.

The checkpoint store should persist transparency-layer outputs without
interpreting the protocol content. Until checkpoint objects, proof formats, and
witness policies are designed, the storage adapter boundary should stay focused
on durability and retrieval:

- store opaque checkpoint bytes or descriptors as immutable records;
- reject mutation when an existing checkpoint id or digest is reused with
  different bytes;
- list published checkpoints in a stable order for mirrors and auditors;
- read one checkpoint by its public identifier or digest;
- store future witness statements as opaque records attached to a checkpoint;
- expose readiness status separately from the registry database and object
  store;
- support backup, restore, and retention with the same care as events and
  immutable objects.

A checkpoint store must not be a hidden side table that only one server process
can understand. A mirror, auditor, or replacement operator should be able to
recover public checkpoint material through documented APIs once the
transparency protocol exists.

Local development can use a SQLite table or filesystem directory under
`REGESTA_DATA_DIR`. Production deployments should be able to use a database,
object store, append-friendly log service, or another durable backend behind
the same adapter boundary.

Checkpoint publication has a stronger consistency requirement than ordinary
derived caches. Once a checkpoint is advertised publicly, the referenced
checkpoint bytes and any attached public witness statements must be durable and
readable. If an adapter cannot make that atomic with its backend, the
transparency layer should use an explicit publish marker so incomplete writes
are never served as public checkpoints.

This section intentionally does not define checkpoint object fields, inclusion
proofs, consistency proofs, witness discovery, or witness thresholds. Those are
protocol decisions, not storage adapter decisions.
