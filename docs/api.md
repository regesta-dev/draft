# API

This page documents the current V0 HTTP API shape. It covers implemented
routes and the intended boundary between core APIs and ecosystem projections.

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

## Publish Release

```http
POST /api/v0/releases
Content-Type: multipart/form-data
```

Multipart fields:

| Field       | Type   | Required | Purpose                                      |
| ----------- | ------ | -------- | -------------------------------------------- |
| `config`    | JSON   | yes      | Normalized Regesta publish config.           |
| `source`    | binary | yes      | Source archive bytes.                        |
| `artifacts` | JSON   | yes      | Metadata for uploaded artifact binary parts. |

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

The request also includes a signed write authorization. The server verifies the
domain binding, checks the signed intent against the request body, processes
artifacts, stores objects, writes the release manifest, appends a publish event,
and assigns the default `latest` channel.

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
GET  /api/v0/packages/{packageId}
HEAD /api/v0/packages/{packageId}
```

Returns package state replayed from ordered package events:

```json
{
  "object": "regesta.package-state",
  "specVersion": 0,
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

## Release Reads

```http
GET  /api/v0/packages/{packageId}/releases/{version}
HEAD /api/v0/packages/{packageId}/releases/{version}
```

Returns the stored release envelope: manifest, manifest descriptor, event,
source descriptor, and artifact descriptors.

```http
GET  /api/v0/packages/{packageId}/channels/{channel}
HEAD /api/v0/packages/{packageId}/channels/{channel}
```

Resolves a mutable channel to the current release and returns the same release
envelope as the versioned release endpoint.

## Objects

```http
GET  /api/v0/objects/{algorithm}/{hex}
HEAD /api/v0/objects/{algorithm}/{hex}
```

Objects are immutable content-addressed bytes. Current V0 object reads are used
for source archives, install artifacts, and release manifest bytes.

Object responses include:

- `Content-Type`;
- `Content-Length`;
- digest-based `ETag`;
- cache headers suitable for immutable content.

`HEAD` returns descriptors without downloading bytes. Verifiers still need to
download bytes when proving object integrity.

## Events

```http
GET  /api/v0/events?after={eventId}&limit={count}
HEAD /api/v0/events?after={eventId}&limit={count}
GET  /api/v0/events/{algorithm}/{hex}
HEAD /api/v0/events/{algorithm}/{hex}
```

The event log is sequence ordered. `after` is the last event id already seen,
and `limit` is the maximum number of following events.

V0 accepts page sizes from `1` to `999`. If `limit` is omitted, the HTTP API
uses the maximum V0 page size.

Event page shape:

```json
{
  "schema": "regesta.event-log.v0",
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
- unknown cursors return an explicit not-found error;
- individual event reads are immutable public facts.

Mirrors and auditors should fetch each paged event again by id, recompute its
event digest, compare the bodies, and verify the event `ETag`.

## npm Projection

npm projection routes are exposed through npm hosts such as
`npm.localhost:4321`. The projection uses npm-native package names:

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
GET  /-/ping
HEAD /-/ping
```

The npm projection derives:

- packument versions from release manifests;
- dist-tags from Regesta channels;
- package description from neutral release metadata;
- dependency and resolver metadata from npm artifact `ecosystemMetadata`;
- tarball URLs from install artifact object descriptors.

### Progressive Migration And Fallback

The npm projection is also a compatibility layer for gradual migration. If a
package is not found in Regesta, the projection can fall back to
`registry.npmjs.org` so existing dependency graphs keep resolving while only
selected packages move to Regesta.

Fallback is not part of the core package state. It can be implemented by the
server projection, or by a client/package manager that tries Regesta first and
then asks the ecosystem's default registry for missing packages.

Upstream tarball URLs are not proxied during fallback. npm clients should keep
the upstream tarball URL instead of rewriting it through the Regesta npm
projection.

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
5. Replay relevant events when checking package state.

Future checkpoint, inclusion proof, consistency proof, and witness endpoints
are intentionally not part of V0 until their object formats are designed.
