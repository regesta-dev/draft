# API

This page documents the current HTTP API surface. It covers implemented routes
and the intended boundary between core APIs and ecosystem projections.

A machine-readable OpenAPI reference is available at
[`/openapi/regesta-v0.openapi.json`](/openapi/regesta-v0.openapi.json). It
describes implemented HTTP routes and references the JSON Schema definitions
for Regesta-native objects.

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

## Transport

```http
GET  /
HEAD /
GET  /health
HEAD /health
GET  /ready
HEAD /ready
```

The root route returns deployment information: service name, package version,
runtime, build time, git sha, dirty state, and registry statistics such as the
current package count. It is meant for operators and debugging.

Registry statistics are advisory status data. Implementations may cache them
briefly to keep status checks cheap under load.

`/health` is a lightweight liveness check and returns `{ "ok": true }` when
the process can answer requests.

`/ready` aggregates independent adapter readiness checks and returns `200` when
database, object storage, queue, and signer are ready. It returns `503` when
any dependency is not ready. Clients should read the `checks` object and must
not depend on probe ordering.

Transport status responses use `Cache-Control: no-store`.

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
authorization and `ssh-ed25519` OpenSSH `SSHSIG` authorization. The server
verifies the domain binding, checks the signed intent against the request body,
processes artifacts, stores objects, writes the release manifest, appends a
publish event, and assigns the default `latest` channel.

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

Returns package state replayed from ordered package events:

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
newline and `Content-Length` for the exact response body.

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
envelope shape as the versioned release endpoint.

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
The server verifies the signed intent against the owner domain binding, rejects
replayed authorization digests, and stores an `authorization` proof on the
accepted event. The accepted event records the proof material and
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

- `Content-Type`;
- `Content-Length`;
- digest-based `ETag`;
- `Cache-Control` including `immutable`.

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
- individual event reads are immutable public facts.

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
client compatibility.

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

Regesta-hosted npm metadata points `dist.tarball` at the core object URL, where
the object layer serves the immutable artifact. Fallback metadata is returned
from the upstream npm registry without rewriting `dist.tarball`; the npm
projection never proxies artifact bytes.

### Progressive Migration And Fallback

The npm projection is also a compatibility layer for gradual migration. If a
package is not found in Regesta, the projection can fall back to
`registry.npmjs.org` so existing dependency graphs keep resolving while only
selected packages move to Regesta.

Fallback is not part of the core package state. It can be implemented by the
server projection, or by a client/package manager that tries Regesta first and
then asks the ecosystem's default registry for missing packages.

When the server projection handles fallback, packument, version-manifest, and
dist-tag metadata are validated and then returned without rewriting. Upstream
`dist.tarball` URLs remain upstream URLs. Direct npm projection tarball routes
still redirect to upstream npmjs.org tarballs and never proxy tarball bytes.

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

Validation failures should return client errors, not internal server errors.
Unexpected 500 responses are handled by the transport error boundary and logged
with `console.error`.

## Caching

- Immutable objects use long-lived immutable caching.
- Individual event reads use digest validators.
- Package state, channel reads, event pages, and npm projection reads are
  mutable views and use weak validators.
- `HEAD` responses return the same validators as `GET` without the body.

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
