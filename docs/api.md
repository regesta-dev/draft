# API

This page documents the current HTTP API surface. It covers implemented routes
and the intended boundary between core APIs and ecosystem projections.

A machine-readable OpenAPI reference is available at
[`/openapi/regesta-v0.openapi.json`](/openapi/regesta-v0.openapi.json). It
describes implemented HTTP routes and references the JSON Schema definitions
for Regesta-native objects. The current OpenAPI surface is limited to
Transport, Core Registry, and the npm projection. Future PyPI, Cargo, Go, OCI,
and other projection profiles are design targets, not implemented HTTP APIs.

Public demo hosts:

- Core registry API: [https://registry.regesta.dev/](https://registry.regesta.dev/)
- npm projection: [https://npm.regesta.dev/](https://npm.regesta.dev/)

## API Principles

- Core APIs expose Regesta-native packages, releases, objects, channels, and
  events.
- Ecosystem projection APIs expose package-manager-native responses derived
  from core data.
- Object bytes are addressed by digest.
- Release state is immutable after publication; later state changes are
  represented by additional events.
- Mutable reads use weak cache validators and should be revalidated.
- Immutable object and event reads use digest-based validators.

## URL Encoding

`packageId` is encoded as one path segment:

```text
npm:some.dev/sdk -> npm%3Asome.dev%2Fsdk
```

This avoids ambiguous route parsing when native ecosystem names contain slashes
or reserved words such as `channels` and `releases`.

Core API routes do not enumerate supported ecosystem keys. The package id
schema accepts any lowercase portable ecosystem key that follows the canonical
`ecosystem:owner-domain/name` shape.

## Transport

```http
GET  /
HEAD /
GET  /health
HEAD /health
GET  /ready
HEAD /ready
GET  /favicon.ico
```

On core registry hosts, the root route returns deployment information: service
name, package version, runtime, build time, git sha, dirty state, and registry
statistics such as the current package count. It is meant for operators and
debugging.

Registry statistics are advisory status data. Implementations may cache them
briefly to keep status checks cheap under load. Storage adapters should expose
these values from cheap counters or indexes, not by replaying events or scanning
release rows on every root request. The default server may serve stale cached
statistics when a refresh read fails, but schema-invalid statistics still fail
closed.

`/health` is a lightweight liveness check and returns `{ "ok": true }` when
the process can answer requests.

`/ready` aggregates independent adapter readiness checks and returns `200` when
database, object storage, queue, signer, and any configured checkpoint store
are ready. It returns `503` when any dependency is not ready. Clients should
read the `checks` object and must not depend on probe ordering. Checkpoint
readiness appears only when a checkpoint store adapter is configured.

Transport status `GET` responses use `Cache-Control: no-store` and include
`Content-Length` for the exact JSON response body. Transport status `HEAD`
responses return the same status and cache headers without a response body or
JSON `Content-Length`.

`/favicon.ico` returns `204` with short public caching so browser favicon probes
do not fall through to package routes.

The transport layer applies permissive CORS before mounted registry layers.
Requests from any origin receive `Access-Control-Allow-Origin: *`, and
`OPTIONS` preflight requests can target any host-routed layer. Preflight
responses return `204`, allow the configured HTTP methods, and echo requested
headers through `Access-Control-Allow-Headers`. Preflight requests are answered
before request-size limit enforcement and before mounted route handlers.

Deployments may configure a maximum declared request size. When `Content-Length`
is malformed, the transport layer rejects the request with `400` before mounted
route handlers. When the declared size exceeds the configured limit, it rejects
the request with `413` and the `request_too_large` error code.

## Publish Release

```http
POST /releases
Content-Type: multipart/form-data
```

Multipart fields:

| Field           | Type   | Required | Purpose                                       |
| --------------- | ------ | -------- | --------------------------------------------- |
| `config`        | JSON   | yes      | Normalized Regesta publish config.            |
| `source`        | binary | yes      | Source archive bytes.                         |
| `artifacts`     | JSON   | yes      | Metadata for uploaded artifact binary parts.  |
| `authorization` | JSON   | yes      | Signed `release.publish` write authorization. |

Each artifact metadata entry names a multipart part:

```json
[
  {
    "part": "artifact.install",
    "role": "install",
    "format": "npm-tarball",
    "mediaType": "application/gzip",
    "filename": "sdk-1.2.3.tgz",
    "compatibility": {
      "runtimes": ["node"],
      "modules": ["esm"]
    }
  }
]
```

The binary part named `artifact.install` contains the package-manager-produced
install artifact.

The request also includes a signed write authorization. V0 accepts Ed25519 JWK
authorization and `ssh-ed25519` OpenSSH `SSHSIG` authorization. The signed
payload `domain` must match the owner domain parsed from payload `package`.
The server verifies that owner domain binding, checks the signed intent against
the request body, processes artifacts, stores objects, writes the release
manifest, appends a publish event, and assigns the default `latest` channel.

Response shape:

```json
{
  "channel": "latest",
  "event": {
    "object": "regesta.event",
    "eventType": "release.published",
    "id": "sha256:..."
  },
  "manifest": {
    "object": "regesta.release-manifest",
    "id": "npm:some.dev/sdk",
    "version": "1.2.3"
  },
  "manifestDescriptor": {
    "digest": "sha256:...",
    "mediaType": "application/vnd.regesta.release-manifest.v0+json",
    "size": 1234
  }
}
```

## Package State

```http
GET  /packages/{packageId}
HEAD /packages/{packageId}
```

Returns an event-derived package state snapshot:

```json
{
  "object": "regesta.package-state",
  "id": "npm:some.dev/sdk",
  "ecosystem": "npm",
  "name": "some.dev/sdk",
  "channels": {
    "latest": "1.2.3"
  },
  "releases": [
    {
      "version": "1.2.3",
      "manifestDigest": "sha256:...",
      "createdAt": "2026-06-03T00:00:00.000Z"
    }
  ]
}
```

Package state is mutable. Later channel events can change channel pointers, and
later publish events can add releases.

Package state `releases` are ordered by `createdAt` ascending, using `version`
as the deterministic tie-breaker. Release versions are unique within one
package state, and every channel value points to a release version listed in
that state.

The served state is a convenience view over Regesta-native events. A production
server may materialize it from adapter-owned indexes for performance, but the
event log remains the source of truth. Auditors should replay public events and
compare the result with this response when checking package state.

Package state responses include `Cache-Control: no-cache`. Non-empty states
include a weak `ETag` derived from the last package event id, so clients can
revalidate without treating the state snapshot as immutable.

## Release Reads

```http
GET  /packages/{packageId}/releases/{version}
HEAD /packages/{packageId}/releases/{version}
```

Returns the stored release envelope: event, manifest, and manifest descriptor.
The manifest contains the source descriptor and artifact descriptors. Versioned
release reads are immutable and return canonical JSON bytes with a trailing
newline and `Content-Length` for the exact response body. They use long-lived
immutable caching and weak validators derived from the release event id.

## Release Verification

```http
GET /packages/{packageId}/releases/{version}/verification
```

Returns release verification results. Successful verification returns `200`.
Verification problems return `422` with the same response shape:

```json
{
  "ok": false,
  "problems": ["Release manifest digest does not match stored descriptor"]
}
```

## Channel Reads

```http
GET  /packages/{packageId}/channels/{channel}
HEAD /packages/{packageId}/channels/{channel}
```

Resolves a mutable channel to the current release and returns the same release
envelope shape as the specific release read endpoint.

Channel reads are mutable projections. They include `Cache-Control: no-cache`
and a weak `ETag` for the package event id that produced the current channel
target.

## Channel Writes

```http
PUT    /packages/{packageId}/channels/{channel}
DELETE /packages/{packageId}/channels/{channel}
Content-Type: application/json
```

Channel writes require a signed write authorization with the same Ed25519 JWK or
`ssh-ed25519` authorization formats. Updating a channel points it at an existing
release version:

```json
{
  "authorization": {
    "alg": "EdDSA",
    "kid": "ed25519:example",
    "payload": {
      "object": "regesta.write-intent",
      "operation": "channel.update",
      "package": "npm:some.dev/sdk",
      "channel": "latest",
      "version": "1.2.3",
      "previousVersion": "1.2.2",
      "domain": "some.dev",
      "timestamp": "2026-06-03T00:00:00.000Z",
      "nonce": "..."
    },
    "signature": "..."
  },
  "version": "1.2.3"
}
```

Deleting a channel removes the mutable pointer:

```json
{
  "authorization": {
    "alg": "EdDSA",
    "kid": "ed25519:example",
    "payload": {
      "object": "regesta.write-intent",
      "operation": "channel.delete",
      "package": "npm:some.dev/sdk",
      "channel": "latest",
      "previousVersion": "1.2.3",
      "domain": "some.dev",
      "timestamp": "2026-06-03T00:00:00.000Z",
      "nonce": "..."
    },
    "signature": "..."
  }
}
```

The signed intent binds the package id, channel, target version for updates,
current `previousVersion` when one exists, timestamp, nonce, and owner domain.
The payload `domain` must match the owner domain parsed from payload `package`.
The server verifies the signed intent against that owner domain binding,
rejects replayed authorization digests, and stores an `authorization` proof on
the accepted event. The accepted event records the proof material and
`payloadDigest`; it does not currently publish the full signed intent payload.
Accepted writes append `channel.updated` or `channel.deleted` events. They do
not modify release manifests.

## Objects

```http
GET  /objects?after={digest}&limit={count}
HEAD /objects?after={digest}&limit={count}
GET  /objects/{digest}
HEAD /objects/{digest}
GET  /objects/{algorithm}/{hex}
HEAD /objects/{algorithm}/{hex}
```

Objects are immutable content-addressed bytes. Current V0 object reads are used
for source archives, install artifacts, and release manifest bytes.

The collection route exports object descriptors for mirrors and auditors. It
does not return object bytes. `after` is the last object digest already seen,
and `limit` is the maximum number of following descriptors. V0 accepts page
sizes from `1` to `999`. If `limit` is omitted, the HTTP API uses the maximum
V0 page size.

Object inventory page shape:

```json
{
  "object": "regesta.object-inventory",
  "objects": [
    {
      "digest": "sha256:...",
      "mediaType": "application/gzip",
      "size": 1234
    }
  ],
  "nextAfter": "sha256:..."
}
```

The `{digest}` form uses the canonical digest string, such as
`sha256:0123...`. The `{algorithm}/{hex}` form exposes the same object with the
digest split into path-safe segments.

Object responses include:

- `Content-Type` from the object descriptor;
- `Content-Length`;
- `Accept-Ranges: bytes`;
- strong digest-based `ETag`;
- `Cache-Control` including `immutable`.

Range requests return `206` with `Content-Range`. Unsatisfiable ranges return
`416` with `Content-Range: bytes */{size}` and no object bytes.

`HEAD` returns descriptors without downloading bytes. Verifiers still need to
download bytes when proving object integrity.

## Events

```http
GET  /events?after={eventId}&limit={count}
HEAD /events?after={eventId}&limit={count}
GET  /events/{algorithm}/{hex}
HEAD /events/{algorithm}/{hex}
```

The event log is sequence ordered. `after` is the last event id already seen,
and `limit` is the maximum number of following events.

V0 accepts page sizes from `1` to `999`. If `limit` is omitted, the HTTP API
uses the maximum V0 page size.

Individual event reads return canonical JSON bytes with a trailing newline and
`Content-Length` for the exact response body.

Event page shape:

```json
{
  "events": [
    {
      "object": "regesta.event",
      "eventType": "release.published",
      "id": "sha256:..."
    }
  ],
  "nextAfter": "sha256:..."
}
```

Rules:

- non-empty pages include `nextAfter`;
- `nextAfter` is the last returned event id;
- `nextAfter` does not prove that more events are available;
- pages include `Content-Length` for the exact JSON response body;
- page `ETag` values identify the page cursor and event count;
- unknown cursors return an explicit not-found error;
- individual event reads are immutable public facts with long-lived immutable
  caching and event-id validators.

Mirrors and auditors should fetch each paged event again by id, recompute its
event digest, compare the bodies, and verify the event `ETag`.

## npm Projection

npm projection routes are exposed through npm hosts such as
`https://npm.regesta.dev` or `npm.localhost:4321`. The projection uses
npm-native package names:

```text
@some.dev/sdk
```

The projection maps that name to:

```text
npm:some.dev/sdk
```

Current npm-compatible reads:

```http
GET  /@scope/name
HEAD /@scope/name
GET  /@scope/name/{version-or-tag}
HEAD /@scope/name/{version-or-tag}
GET  /@scope/name/-/{tarball}
HEAD /@scope/name/-/{tarball}
GET  /-/package/@scope/name/dist-tags
HEAD /-/package/@scope/name/dist-tags
GET  /{name}
HEAD /{name}
GET  /{name}/-/{tarball}
HEAD /{name}/-/{tarball}
GET  /-/package/{name}/dist-tags
HEAD /-/package/{name}/dist-tags
GET  /-/ping
HEAD /-/ping
```

On npm projection hosts, the root path returns an empty JSON object for npm
client compatibility. This is the same public path as the core registry root,
but selected by host routing. Root and ping utility `GET` responses include
`Cache-Control: no-cache` and `Content-Length`. Their `HEAD` responses return
the same cache behavior without a response body or JSON `Content-Length`.

The `GET /@scope/name` and `HEAD /@scope/name` entries above use the same
physical path shape as npm-compatible unscoped version or tag reads, such as
`GET /tinyexec/latest`. Regesta-hosted packages remain domain-scoped through
names like `@some.dev/sdk`; unscoped npm names are served only through fallback
or by a client/package-manager fallback policy.

The npm projection derives:

- packument versions from release manifests;
- dist-tags from Regesta channels;
- package description from neutral release metadata;
- dependency and resolver metadata from npm artifact `ecosystemMetadata`;
- tarball URLs for npm-compatible clients.

For Regesta-hosted packages, dependency and resolver metadata is projected
through an explicit supported-field allowlist. Unknown npm artifact metadata
fields remain artifact inspection data and are not copied into local npm
version manifests.

Regesta-hosted npm metadata points `dist.tarball` at the npm projection tarball
URL. That route redirects to the immutable core object URL and never proxies
artifact bytes. Fallback metadata is returned from the upstream npm registry
without rewriting `dist.tarball`.

### Progressive Migration And Fallback

The npm projection is also a compatibility layer for gradual migration. If a
package is not found in Regesta, the projection can fall back to
`registry.npmjs.org` so existing dependency graphs keep resolving while only
selected packages move to Regesta.

Fallback is not part of the core package state. It can be implemented by the
server projection, or by a client/package manager that tries Regesta first and
then asks the ecosystem's default registry for missing packages.

Server-side npm fallback is optional deployment policy. When it is disabled,
missing npm metadata and tarball routes return `404 package_not_found` instead
of contacting or redirecting to `registry.npmjs.org`. Local Regesta-hosted npm
packages still resolve through the npm projection when the projection is
mounted.

When the server projection handles fallback, packument, version-manifest, and
dist-tag metadata are validated and then returned without rewriting. Upstream
`dist.tarball` URLs remain upstream URLs. Direct npm projection tarball routes
redirect local releases to core object URLs and redirect missing releases to
upstream npmjs.org tarballs only when server-side fallback is enabled.
Local-only deployments return `404 package_not_found` for missing tarballs. The
npm projection never proxies tarball bytes.
Client metadata validators such as `If-None-Match` and `If-Modified-Since` are
forwarded to the upstream npm registry; upstream `304` responses preserve
upstream cache headers and do not include a response body. Client credentials,
including `Authorization`, `Cookie`, and npm token headers, are not forwarded to
the upstream registry. Fallback responses preserve only cache and content
metadata headers such as `Cache-Control`, `Content-Type`, `ETag`,
`Last-Modified`, and generated `Content-Length`; upstream cookies, redirects,
authentication challenges, and extension headers are not forwarded to clients.

If the upstream npm registry is unavailable or returns metadata that cannot be
projected safely, the npm projection returns a structured `502` error with code
`upstream_npm_registry_unavailable`. That failure does not create Regesta core
package state.

## Errors

Public API errors are structured JSON:

```json
{
  "error": "Release already exists: npm:some.dev/sdk@1.2.3",
  "message": "Release already exists: npm:some.dev/sdk@1.2.3",
  "code": "release_already_exists"
}
```

For `HEAD` requests, error responses keep the same status and error headers but
do not include the JSON response body.

Validation failures should return client errors, not internal server errors.
Write authorization failures return `401` with code
`write_authorization_invalid`. Replayed write authorizations return `409` with
code `write_authorization_replayed`.
Unexpected 500 responses are handled by the transport error boundary and logged
with `console.error`.

## Caching

- Immutable objects use long-lived immutable caching.
- Individual event reads use digest validators.
- Package state, channel reads, and event pages are mutable views and use weak
  validators.
- npm projection metadata uses projection-specific validators. Local mutable
  projections use weak `ETag` values and may include `Last-Modified` when the
  projection has a reliable timestamp. Local immutable version responses can
  use long-lived caching, and upstream fallback metadata preserves upstream
  `ETag`, `Last-Modified`, and cache policy headers when present.
- For local npm metadata with `Last-Modified`, `If-Modified-Since` can produce
  a `304` response when no `If-None-Match` header is present. `If-None-Match`
  takes precedence when both validators are sent.
- `HEAD` responses return no body. Addressed resources return the same
  validators as `GET` when those validators can be computed without
  materializing the response body. Lightweight collection probes such as
  `HEAD /events` and `HEAD /objects` may omit page validators so they do not
  scan or paginate inventories.

## Verification Notes

The release verifier should use public API data only:

1. Read the release envelope.
2. Fetch the publish event again by id.
3. Fetch manifest, source, and artifact objects by digest.
4. Recompute canonical JSON and byte digests.
5. Reproduce ecosystem metadata extraction when a supported artifact processor
   can do so, such as npm metadata from the install tarball.
6. Replay public events when checking package state.
7. Compare mutable package-state responses with the replayed event state.

Future checkpoint, inclusion proof, consistency proof, and witness endpoints
are intentionally not part of V0 until their object formats are designed.
