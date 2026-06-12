# Operations

Regesta separates protocol facts from operational storage choices. The protocol
defines releases, objects, channels, events, and verification rules. Operators
choose the database, object store, queue, signer, checkpoint store, and
deployment platform.

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
- local signer readiness state;
- optional checkpoint store bytes for future transparency outputs.

Container images must treat local container disk as disposable. In the demo
container, `/data` is the durable mount. In another deployment, the equivalent
state must live in external services such as a managed database, object store,
queue, signer, checkpoint store, or KMS.

## Runtime Configuration

The default Node server accepts these deployment environment variables:

| Variable                             | Default         | Purpose                                                                       |
| ------------------------------------ | --------------- | ----------------------------------------------------------------------------- |
| `REGESTA_DATA_DIR`                   | `.regesta-data` | Local SQLite, filesystem object storage, queue, signer, and checkpoint state. |
| `REGESTA_DOMAIN_BINDING_TIMEOUT_MS`  | `10000`         | Domain well-known binding fetch timeout. Set `0` to disable it.               |
| `REGESTA_MAX_REQUEST_BYTES`          | unlimited       | Maximum declared HTTP request body size.                                      |
| `REGESTA_MAX_PUBLISH_ARTIFACT_BYTES` | unlimited       | Maximum uploaded install artifact size per publish request.                   |
| `REGESTA_MAX_PUBLISH_SOURCE_BYTES`   | unlimited       | Maximum uploaded source archive size per publish request.                     |
| `REGESTA_READINESS_TIMEOUT_MS`       | `5000`          | Per-adapter readiness probe timeout.                                          |
| `REGESTA_STATISTICS_CACHE_TTL_MS`    | `10000`         | Root deployment statistics cache TTL. Set `0` to disable caching.             |
| `REGESTA_NPM_UPSTREAM_TIMEOUT_MS`    | `10000`         | npm upstream metadata fallback timeout. Set `0` to disable it.                |

Numeric runtime values must be decimal safe integers without whitespace,
fractional notation, exponent notation, or leading zeroes. Timeout and cache
values are milliseconds. Request and publish limits are byte counts.

`REGESTA_MAX_REQUEST_BYTES` is a transport guard over declared
`Content-Length`, not a protocol object-size rule. Malformed `Content-Length`
returns `400`, and a declared body larger than the configured limit returns
`413` before mounted registry routes run. CORS preflight requests are answered
before this guard so browser clients can discover allowed methods and headers
without sending a body.

## Backup Boundary

A backup must preserve a consistent view of:

- registry database state;
- object bytes;
- object metadata;
- queue state when queued work must survive restore;
- signer or KMS configuration needed by the deployment;
- checkpoint store bytes or metadata when checkpoint storage is configured.

Database-only backups are incomplete because releases reference
content-addressed objects. Object-only backups are incomplete because package
state is derived from events stored in the database. Adapter-owned package-state
indexes are recoverable implementation data; event rows are the durable source
for rebuilding them.

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

The Docker smoke requires an accessible Docker daemon because it builds and
runs a real OCI image before checking persistence across a Docker volume.

## Load Smoke Profiles

`pnpm smoke:load` is a repeatable local gate for the SQLite/filesystem V0
adapter path. It publishes packages, reads root deployment statistics, checks
readiness, reads core package state, reads events, lists object inventory,
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
their own profiles against their database, object storage, queue, signer,
checkpoint store, and deployment platform.

## Production Load Gates

Regesta does not define protocol-level performance SLOs. Operators should still
publish repeatable load gates before calling a deployment production-ready.

Minimum pre-production gates:

| Gate                 | Purpose                         | Required checks                                                                                                                   |
| -------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ci-smoke`           | Fast pull-request signal        | `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm docs:build`, `pnpm smoke:load` with the `smoke` profile                         |
| `container-smoke`    | OCI portability and persistence | `pnpm smoke:docker` on a persistent volume                                                                                        |
| `adapter-local`      | Local adapter regression        | `REGESTA_LOAD_PROFILE=local pnpm smoke:load`                                                                                      |
| `adapter-production` | Production backend validation   | the same load shape against the intended database, object store, queue, signer, optional checkpoint store, and deployment runtime |
| `restore-smoke`      | Recovery confidence             | restore from backup, then run readiness, verifier, object, package-state, and projection checks                                   |

The production adapter gate should publish its parameters with the result:

- package count;
- read iterations;
- publish duration budget;
- read duration budget;
- concurrency level;
- runtime version;
- deployment target;
- database, object store, queue, signer, and optional checkpoint store backend;
- data durability settings;
- whether the run used a cold or warm cache.

As a minimum, a production adapter profile should cover the same behavioral
surface as `pnpm smoke:load`: publish, root deployment statistics, package
reads, release reads, event reads, readiness reads, object inventory reads,
object reads, npm packuments, npm version manifests, npm tarball redirects, and
redirected object downloads.

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

## Operational Logs

The default Node server writes structured request and audit JSON logs to
stdout:

- `regesta.request` records transport-layer request id, host, method, path,
  response status, and duration. The logged path excludes query strings;
- `regesta.core-audit` records accepted and rejected core write attempts,
  including publish and channel operations.

The transport layer accepts bounded request ids for correlation. Invalid client
request ids are replaced before they are written to response headers or
operational logs.

Recoverable transport refresh failures use structured `console.error` entries
on stderr. For example, `regesta.deployment-statistics-refresh-failure` means
root deployment statistics could not be refreshed and the server served a stale
cached value.

Unexpected server errors are also logged with `console.error` by the transport
error boundary while the HTTP response hides internal exception details.
Request-log and audit-log sinks are scheduled outside the request critical path,
so a slow operator log sink should not add response latency. Operational logs
are operator telemetry. They are not public protocol objects, do not replace the
append-only event log, and should follow the operator's private log retention
policy.

## Hot Path Cost Boundaries

The V0 implementation is optimized for simple, cache-friendly read paths before
introducing distributed storage.

Current hot-path boundaries:

- health reads do not touch storage;
- readiness reads call cheap, bounded adapter probes, including optional
  checkpoint store probes when configured;
- root deployment statistics are cached and served from adapter counters or
  indexes;
- root deployment info does not run readiness probes;
- core package-state reads use adapter-owned event indexes instead of replaying
  the event log on every request;
- core package-state `HEAD` reads use indexed package heads instead of reading
  full package state;
- domain well-known binding discovery for write authorization is bounded by
  `REGESTA_DOMAIN_BINDING_TIMEOUT_MS`;
- event and object collection reads rely on adapter-owned cursor validation
  inside the paginated read instead of separate cursor preflight reads;
- npm tag and version reads use indexed channel and release state;
- npm tarball routes redirect to the canonical object or upstream URL instead
  of proxying bytes through the npm compatibility layer;
- upstream npm fallback metadata requests are bounded by
  `REGESTA_NPM_UPSTREAM_TIMEOUT_MS`;
- request-log, audit-log, and derived-queue sinks run outside the committed
  write path.

These are implementation cost boundaries, not protocol guarantees. A production
adapter can choose different indexes or caches, but it should preserve the same
behavioral result: public facts remain replayable, immutable objects stay
content-addressed, and compatibility projections are derived from core data.
The local queue writes newline-delimited JSON entries with `topic`, `payload`,
and `enqueuedAt` operational metadata so derived work can be inspected after a
restart.

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
- readiness checks are cheap, bounded, independent adapter probes;
- readiness checks fail closed when a dependency is unavailable.

The default server bounds each readiness probe with
`REGESTA_READINESS_TIMEOUT_MS`, falling back to a 5s timeout when the variable
is not set.

The default server bounds domain well-known binding discovery with
`REGESTA_DOMAIN_BINDING_TIMEOUT_MS`, falling back to a 10s timeout when the
variable is not set. Set it to `0` to disable the timeout when a deployment
uses an external fetch boundary.

The root deployment info endpoint caches advisory package statistics for 10s by
default. Operators can tune this with `REGESTA_STATISTICS_CACHE_TTL_MS`; set it
to `0` to disable cross-request statistics caching. In-flight statistics reads
are still coalesced. When a refresh read fails after a cached value exists, the
default server serves the stale cached statistics and logs the refresh failure;
schema-invalid statistics still fail closed. Storage adapters should serve
these statistics from cheap counters or indexes. In the local SQLite adapter,
package count is maintained in `registry_stats`; startup migration or repair
may scan releases to backfill the counter, but normal root requests should not.
`HEAD /` is a lightweight metadata probe and does not refresh or read package
statistics. Status probes such as `HEAD /health` and `HEAD /ready` return
headers without JSON body serialization. Collection probes such as
`HEAD /events` and `HEAD /objects` also avoid paginating event or object
inventories. Immutable object probes such as `HEAD /events/:digest` and
`HEAD /packages/:id/releases/:version` skip canonical JSON body serialization
after the addressed object is found. Mutable channel release probes such as
`HEAD /packages/:id/channels/:channel` also skip JSON body serialization after
resolving the target release. Core JSON `HEAD` responses, including not-found
probes, request-size rejections, and error-boundary responses return headers
without serializing their JSON body. Unexpected transport errors still keep
status codes and `console.error` logging.

The npm projection bounds upstream npm metadata fallback requests with
`REGESTA_NPM_UPSTREAM_TIMEOUT_MS`, falling back to a 10s timeout when the
variable is not set. Set it to `0` to disable the timeout. This does not affect
tarball routes, which remain redirect-only. Local npm packument `HEAD` requests
use indexed package heads when package state is stable, so metadata probes do
not need to build full packuments. Local npm version manifest `HEAD` requests
also skip npm body projection after the addressed release is found. Local npm
dist-tags `HEAD` requests skip JSON body serialization after reading indexed
channel state. npm utility `HEAD` requests such as `/` and `/-/ping`, local
not-found errors, and upstream fallback failures also avoid serializing JSON
bodies.

The backend can be Postgres, DynamoDB, S3, R2, GCS, a platform queue, KMS, or
another service. The registry core should continue to see only adapters.

## Future Checkpoint Store Adapters

Checkpoint storage is a future transparency adapter, not part of the V0 core
database schema.

The current implementation exposes this as an optional opaque checkpoint store
adapter boundary. It is storage plumbing only: there are no public checkpoint
routes, checkpoint object fields, proof formats, or witness semantics in V0.

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
