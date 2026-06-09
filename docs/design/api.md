# Regesta API Design

Status: draft.

This document describes the API shape for Regesta as a generic, ecosystem-neutral registry. It is not an implementation plan for the current TypeScript code. It defines the protocol boundary that future implementation work should target.

## Goals

- Support a generic registry core, not only JavaScript or TypeScript packages.
- Keep package content interpretation in ecosystem adapters and package managers.
- Preserve source, install artifacts, release manifests, and events as verifiable public facts.
- Use content-addressed objects and append-only events as the source of truth.
- Let npm, PyPI, Cargo, Go, OCI, and other ecosystems be projections rather than core assumptions.
- Keep v0 provenance honest: source-attached only, not reproducible or trusted-build verified.

## Non-Goals

- Do not define package manager dependency resolution.
- Do not force a registry-owned builder.
- Do not require build hints, build recipes, or declared build commands.
- Do not claim runtime, platform, ABI, or package-manager compatibility is verified in v0.
- Do not make npm packuments or npm tarballs the internal data model.
- Do not define a generic cross-ecosystem `dependencies` schema in the core manifest.

## Package Identity

The canonical package id format is:

```text
<ecosystem>:<owner-domain>/<package-name>
```

The `owner-domain` must be a canonical lowercase DNS-style domain. It is the domain used for v0 well-known key discovery and write authorization.

Examples:

```text
npm:some.dev/sdk
pypi:some.dev/sdk
cargo:some.dev/sdk
go:some.dev/sdk
oci:some.dev/sdk
```

The ecosystem prefix is mandatory in Regesta manifests, events, storage records, and generic APIs. It may be omitted only inside a specific ecosystem context. For example, TypeScript users still write:

```ts
import '@some.dev/sdk'
```

The npm adapter resolves that native npm specifier as:

```text
npm:some.dev/sdk
```

Regesta core ids deliberately do not include npm's leading `@`. The `@some.dev/sdk` spelling belongs to npm-compatible projection APIs; other ecosystem projections can map the same core id into names that are valid for their package managers.

### Client Mapping Rules

Package id inference is a client responsibility. The registry core accepts and verifies the canonical Regesta id; it does not infer package identity from `package.json`, `pyproject.toml`, `Cargo.toml`, or OCI metadata.

Publish clients and ecosystem adapters should use deterministic mappings:

| Ecosystem | Native input example            | Regesta id           |
| --------- | ------------------------------- | -------------------- |
| npm       | `@some.dev/sdk`                 | `npm:some.dev/sdk`   |
| PyPI      | `some-dev-sdk`                  | `pypi:some.dev/sdk`  |
| Cargo     | `some-dev-sdk`                  | `cargo:some.dev/sdk` |
| Go        | `some.dev/sdk`                  | `go:some.dev/sdk`    |
| OCI       | `registry.example/some.dev/sdk` | `oci:some.dev/sdk`   |

Reverse projection is also client or adapter behavior. For example, an npm registry-compatible endpoint exposes `npm:some.dev/sdk` as `@some.dev/sdk`, while a PyPI-compatible endpoint may expose `pypi:some.dev/sdk` as `some-dev-sdk`.

The current `regesta` CLI is an npm-oriented client used for the TypeScript v0 and local development tests. It may infer `npm:domain/name` from `package.json` names such as `@domain/name`, but that does not make npm part of the core protocol. Future clients for PyPI, Cargo, Go, OCI, and other ecosystems can be maintained independently by the community.

## API Principles

- Core APIs expose Regesta package ids, release manifests, objects, and events.
- Ecosystem APIs expose package-manager-native protocols such as npm packuments or PyPI Simple API pages.
- Object bytes are addressed by digest, not by a mutable URL.
- Release state is immutable after publication except through additional logged events.
- Projection data is derived from release manifests and events.
- API responses should be deterministic enough for independent clients to verify them.

## Core Endpoints

### Publish Release

```http
POST /api/v0/releases
Content-Type: multipart/form-data
```

Multipart fields:

| Field          | Type   | Required | Description                                                            |
| -------------- | ------ | -------- | ---------------------------------------------------------------------- |
| `config`       | JSON   | yes      | Client-normalized publish config with required package id and version. |
| `source`       | binary | yes      | Source archive bytes.                                                  |
| `artifacts`    | JSON   | yes      | Array describing binary artifact parts.                                |
| artifact parts | binary | yes      | One or more install or auxiliary artifacts referenced by `artifacts`.  |

Example `artifacts` field:

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

The multipart body then includes a binary part named `artifact.install`.

Publish clients may start from a thin `regesta.json`, infer fields such as `id`, `version`, `description`, `exports`, and repository from native manifests, and send the normalized publish config to the server. Ecosystem artifact processors may also extract native metadata from uploaded artifacts before core manifest creation. The core registry model still stores Regesta release manifests, not package-manager-native manifests as the primary model.

For v0, a release should include exactly one primary `install` artifact for the ecosystem in the package id. Artifact descriptors do not repeat the package ecosystem. The manifest format uses an array so future releases can attach docs, type bundles, signatures, attestations, or verification outputs without changing the release object shape.

Clients may include artifact-level `compatibility` in the `artifacts` metadata. The server validates and copies it to the stored artifact descriptor. Clients should not send `ecosystemMetadata`; resolver metadata such as npm dependencies is extracted by artifact processing from the uploaded install artifact.

Each artifact metadata entry must include an explicit `mediaType`. The server
must not infer it from multipart file headers because media type is part of the
stored object descriptor and the signed publish intent.

Response (trimmed):

```json
{
  "manifest": {
    "object": "regesta.release-manifest",
    "specVersion": 0,
    "id": "npm:some.dev/sdk",
    "version": "1.2.3",
    "metadata": {
      "description": "Example SDK"
    }
  },
  "event": {
    "object": "regesta.event",
    "specVersion": 0,
    "eventType": "release.published",
    "id": "sha256:..."
  },
  "manifestDescriptor": {
    "digest": "sha256:...",
    "size": 1234,
    "mediaType": "application/vnd.regesta.release-manifest.v0+json"
  },
  "channel": "latest",
  "version": "1.2.3"
}
```

The publish response includes the stored release manifest, the accepted append-only event, and the manifest object descriptor. The event is identified by `event.id`; it can be fetched later through `GET /api/v0/events/{algorithm}/{hex}`.

V0 publish assigns the published version to the default `latest` channel as part of the accepted `release.publish` write. The channel did not have to point at a version before the release existed.

Release-level `metadata.description` is core-readable metadata. For npm-first publishing it is normally inferred from `package.json.description` by the client or npm artifact processor, stored in the Regesta release manifest, exposed by core APIs, and projected back into npm packuments and version manifests.

### Read Package

```http
GET /api/v0/packages/{packageId}
HEAD /api/v0/packages/{packageId}
```

`packageId` is the full Regesta package id as one URL-encoded path segment. This avoids ambiguous parsing when ecosystem-native names contain path-like segments such as `releases` or `channels`.

Examples:

```http
GET /api/v0/packages/npm%3Asome.dev%2Fsdk
GET /api/v0/packages/pypi%3Asome.dev%2Fsdk
GET /api/v0/packages/go%3Asome.dev%2Fsdk
```

Response:

```json
{
  "id": "npm:some.dev/sdk",
  "ecosystem": "npm",
  "name": "some.dev/sdk",
  "channels": {
    "latest": "1.2.3",
    "beta": "1.3.0-beta.1"
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

This endpoint returns a core Regesta package view replayed from ordered package events. It does not return an npm packument unless the request is made through the npm projection API.

Package state is mutable because later channel events can change current channel pointers and later publish events can add releases. Servers may return a weak ETag derived from the latest package event id, but should require revalidation rather than serving this response as an immutable fact.

`HEAD` responses return the same cache validators as `GET` without the JSON body.

### Read Package By Channel

```http
GET /api/v0/packages/{packageId}/channels/{channel}
HEAD /api/v0/packages/{packageId}/channels/{channel}
```

This endpoint follows a mutable package channel, resolves it to the current version, and returns the same stored release object as `GET /api/v0/packages/{packageId}/releases/{version}`.

Channel reads are mutable pointer reads. Servers may return `Cache-Control: no-cache` with a weak ETag derived from the latest package event id so clients can revalidate without treating the channel response as an immutable release fact.
`HEAD` responses return the same cache validators as `GET` without the JSON body.

Examples:

```http
GET /api/v0/packages/npm%3Asome.dev%2Fsdk/channels/latest
GET /api/v0/packages/npm%3Asome.dev%2Fsdk/channels/beta
```

If the channel does not exist, the response is `404`.

### Update Channel

```http
PUT /api/v0/packages/{packageId}/channels/{channel}
Content-Type: application/json
```

Request:

```json
{
  "version": "1.2.3"
}
```

Channels are mutable package-level version pointers. They are not release manifest fields and they do not change any release object. V0 publish creates or moves the default `latest` channel to the published version. Explicit channel updates after publish create append-only `channel.updated` events.

Channel names are registry-level labels, not npm-only dist-tags. V0 accepts
custom non-empty channel names, but they must not contain control characters.

Common channel names:

```text
latest
next
beta
canary
lts
```

npm projection may map Regesta channels to npm `dist-tags`. Ecosystems without native channel support may expose channels only through Regesta APIs.

Response:

```json
{
  "package": "npm:some.dev/sdk",
  "channel": "latest",
  "version": "1.2.3",
  "previousVersion": "1.2.2",
  "event": {
    "digest": "sha256:...",
    "size": 567,
    "mediaType": "application/vnd.regesta.event.v0+json"
  }
}
```

### Delete Channel

```http
DELETE /api/v0/packages/{packageId}/channels/{channel}
```

Deleting a channel removes the mutable pointer and creates a `channel.deleted` event. It does not delete any release.

### Read Release

```http
GET /api/v0/packages/{packageId}/releases/{version}
HEAD /api/v0/packages/{packageId}/releases/{version}
```

Response:

```json
{
  "event": {
    "object": "regesta.event",
    "specVersion": 0,
    "eventType": "release.published",
    "id": "sha256:..."
  },
  "manifest": {
    "object": "regesta.release-manifest",
    "specVersion": 0,
    "id": "npm:some.dev/sdk",
    "version": "1.2.3",
    "createdAt": "2026-06-03T00:00:00.000Z",
    "source": {
      "digest": "sha256:...",
      "size": 1234,
      "mediaType": "application/vnd.regesta.source-archive+tgz"
    },
    "artifacts": [
      {
        "digest": "sha256:...",
        "size": 5678,
        "mediaType": "application/gzip",
        "role": "install"
      }
    ]
  },
  "manifestDescriptor": {
    "digest": "sha256:...",
    "size": 1234,
    "mediaType": "application/vnd.regesta.release-manifest.v0+json"
  }
}
```

The response is the stored release envelope: the accepted publish event, the release manifest, and the manifest object descriptor. Versioned release envelopes are immutable. Servers should return long-lived immutable cache headers and an ETag derived from the publish event id for this endpoint. Channel endpoints are mutable pointers and should not be cached as immutable release facts even when they currently resolve to the same envelope.

`HEAD` responses return the same immutable release validators as `GET` without the JSON body.

Clients that need v0 release verification should fetch this release envelope, fetch the event again through `GET /api/v0/events/{algorithm}/{hex}`, and fetch the manifest, source, and artifact objects by digest. Verifiers may use object `HEAD` responses to read descriptor headers before downloading bytes, but the downloaded bytes still need digest, size, media type, and cache-validator checks against the manifest descriptors. Future transparency verification should additionally fetch checkpoints and proofs once those protocols exist.

### Read Object

```http
GET /api/v0/objects/{digest}
HEAD /api/v0/objects/{digest}
GET /api/v0/objects/{algorithm}/{hex}
HEAD /api/v0/objects/{algorithm}/{hex}
```

Example:

```http
GET /api/v0/objects/sha256:012345...
GET /api/v0/objects/sha256/012345...
```

The `{digest}` form is the algorithm-prefixed digest as one URL segment, such as `sha256:...`. The `{algorithm}/{hex}` form is equivalent and avoids clients that encode colons inconsistently.

The response content type is the object's stored media type. For `GET`, the response bytes must hash to the requested digest. For `HEAD`, the response returns descriptor headers without object bytes, including the stored `Content-Length`, `Content-Type`, and object-digest `ETag`.

Content-addressed object responses are immutable. Servers should return long-lived immutable cache headers and an ETag derived from the object digest. Conditional `GET` or `HEAD` requests with a matching `If-None-Match` should return `304 Not Modified`.

### Read Event Log

```http
GET /api/v0/events?after={eventId}&limit={count}
HEAD /api/v0/events?after={eventId}&limit={count}
GET /api/v0/events/{algorithm}/{hex}
HEAD /api/v0/events/{algorithm}/{hex}
```

Events describe public registry state changes. Event ids are `sha256` digests of the canonical event payload excluding the `id` field, so clients can independently recompute fetched event ids.

The event log is sequence-ordered. When paginating, `after` is the last event id already seen and `limit` is the maximum number of following events to return. V0 accepts page sizes from 1 to 999 events. If `limit` is omitted, the HTTP API uses the maximum V0 page size of 999 events. Non-empty responses include `nextAfter`, which is the last returned event id and can be used as the next `after` value. `nextAfter` does not imply that more events are currently available. If `after` is not a known event id, servers should return an explicit not-found error rather than an empty page, so mirrors and auditors do not mistake an invalid cursor for the current log tail.

V0 event-log page bodies use the `regesta.event-log.v0` schema marker, an `events` array, and an optional `nextAfter` cursor. Verifiers should treat event pages as replay cursors, not as immutable proof objects. A verifier should reject unknown page fields, invalid event ids, duplicate event ids, pages that return more events than requested, empty pages that still include `nextAfter`, non-empty pages whose `nextAfter` is not the last returned event id, and cursors that do not advance. To cross-check page data against immutable facts, verifiers should fetch every returned event again through `GET /api/v0/events/{algorithm}/{hex}`, recompute the event id from canonical JSON, compare the event body with the page entry, and verify the event-id `ETag`.

Event log page responses are mutable views over an append-only log. Servers may return `Cache-Control: no-cache` with a weak ETag derived from the page contents and cursor so mirrors can revalidate polling requests without treating a tail page as immutable.

Individual event responses fetched by event id are immutable public facts. Servers should return long-lived immutable cache headers and an ETag derived from the event id. Because the event id identifies the canonical event payload rather than a specific JSON serialization, implementations may use a weak ETag for this endpoint. Conditional `GET` or `HEAD` requests with a matching `If-None-Match` should return `304 Not Modified`.

`HEAD` responses for event pages and individual events return the same cache validators as `GET` without the JSON body.

Future transparency APIs may add signed checkpoint endpoints such as:

```http
GET /api/v0/checkpoints/latest
```

Checkpoint formats, inclusion proofs, consistency proofs, and witness policies are future protocol work. The current event log supports release verification and replay inside one registry view, but it is not by itself a complete transparency log. See [Transparency and verification design](transparency-verification.md).

### Verify Release

```http
GET /api/v0/packages/{packageId}/releases/{version}/verification
```

This endpoint may provide a convenience verification summary, but it must not be the only verification path. Independent clients should be able to verify the release from public objects and log data. The `regesta verify` CLI command is a v0 example of this client-side verification path.

Example response (trimmed):

```json
{
  "ok": true,
  "problems": [],
  "manifest": {
    "object": "regesta.release-manifest",
    "specVersion": 0,
    "id": "npm:some.dev/sdk",
    "version": "1.2.3"
  }
}
```

## Ecosystem Projection APIs

Projection APIs expose package-manager-native views derived from Regesta objects.

Examples:

```http
GET https://npm.registry.example/@some.dev/sdk
GET https://npm.registry.example/@some.dev/sdk/-/sdk-1.2.3.tgz
GET /pypi/simple/some-sdk/
GET /pypi/files/some-sdk-1.2.3-py3-none-any.whl
```

Projection APIs may use ecosystem-native naming and response formats. They must not define core identity, storage, or log semantics.

npm projection should use a subdomain mount:

- `https://npm.registry.example/@some.dev/sdk` for npm registry compatibility when clients do not reliably preserve a registry path prefix.

The `npm.` subdomain selects the npm projection and the path is interpreted exactly like an npm registry root. Packument tarball URLs should use the same subdomain-root mount.

Projection APIs should expose resolver-critical metadata before artifact download. For npm, the packument and version object should include core `metadata.description` plus npm-native fields such as `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta`, `bundleDependencies`, `engines`, `os`, `cpu`, and `libc` when those fields exist in the published `package.json`.

npm packuments should include npm-native `time` metadata: `created`, `modified`, and one timestamp per published version. Version timestamps are derived from release manifest `createdAt` values. `modified` should reflect the newest package metadata change known to the registry, including channel updates when that event timestamp is available.

Local npm JSON projection responses such as packuments, tag-resolved manifests like `/latest`, and `dist-tags` are mutable views over Regesta package state. Servers may return `Cache-Control: no-cache` with a weak ETag derived from the latest package event id so npm clients can revalidate repeated resolver requests. The mutable JSON projection ETag is not a content-addressed object digest.

Exact npm version manifest responses, such as `/1.2.3`, are derived from an immutable release. Servers may return long-lived immutable cache headers with a weak ETag derived from the release publish event id. This ETag identifies the release event behind the projected npm JSON, not a content-addressed digest of the serialized npm response.

Local npm tarball responses are immutable release artifacts. They should use the stored install artifact media type as `Content-Type`, long-lived immutable cache headers, and an ETag derived from the install artifact digest, including `304 Not Modified` responses for matching `If-None-Match`. Upstream fallback tarballs must not be proxied.

Local npm projection endpoints should support `HEAD` for packuments, version manifests, `dist-tags`, ping, and tarball artifact URLs. `HEAD` responses should return the same cache validators and descriptor headers as `GET` where applicable, but no response body.

This metadata is not a generic Regesta dependency model. It is an ecosystem projection snapshot attached to the relevant install artifact, normally extracted from the uploaded install artifact at publish time, so package managers can continue dependency resolution without first downloading the tarball.

If an npm package is not present in Regesta, the npm projection may fetch and return the upstream packument from `registry.npmjs.org`. The projection should forward conditional request headers such as `If-None-Match` and `If-Modified-Since` and preserve upstream cache validators and cache-control headers. A fallback `HEAD` request should be forwarded upstream as `HEAD`. Tarball requests must not be proxied through Regesta; upstream packuments should keep their original npmjs tarball URLs.

Because npm rewrites `registry.npmjs.org` tarball hosts to the configured
registry by default, clients that depend on upstream fallback without tarball
proxying should use `replace-registry-host=never`.

## Error Format

Errors should use a small structured response. During the v0 transition, the
top-level `error` string remains for older clients, while `code` and `message`
are the stable fields new clients should use:

```json
{
  "code": "release_already_exists",
  "error": "Release already exists: npm:some.dev/sdk@1.2.3",
  "message": "Release already exists: npm:some.dev/sdk@1.2.3"
}
```

Error codes should be stable. Messages are for humans and may change.

## Authentication and Authorization

V0 uses domain-bound write signatures instead of a user account system. The registry does not authenticate usernames, passwords, sessions, or API tokens for write operations in v0.

Each writable package id must resolve to an owner domain. The owner domain is the first path segment after the ecosystem prefix, such as `example.com` in `npm:example.com/pkg`, `pypi:example.com/pkg`, or `cargo:example.com/pkg`. Ecosystem projections may map this core id into native package-manager names, such as npm's `@example.com/pkg`.

The owner domain publishes its active write keys at:

```http
GET https://example.com/.well-known/regesta.json
```

The TypeScript v0 implementation rejects domain binding responses larger than
64 KiB so a compromised or hostile owner domain cannot make publish
authorization read an unbounded response body.
It also aborts domain binding fetches after 10 seconds so write requests do not
wait indefinitely on owner-domain infrastructure.
If a domain binding response includes `Content-Type`, the TypeScript v0
implementation rejects non-JSON media types so HTML error pages or wrong
well-known endpoints are not silently accepted as authorization data.
The TypeScript v0 implementation requests domain bindings with `cache:
no-store` and without credentials, because current owner-domain key state is the
authorization input for a write.

Example domain binding:

```json
{
  "object": "regesta.domain-binding",
  "specVersion": 0,
  "domain": "example.com",
  "keys": [
    {
      "kid": "ed25519:2026-06-main",
      "use": "regesta-write",
      "alg": "EdDSA",
      "publicKeyJwk": {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "base64url-public-key"
      }
    }
  ]
}
```

Domain binding keys may include `createdAt` and `expiresAt` timestamps. A key is
usable only when it matches the requested `kid`, is not scheduled for the
future, and has not expired.
When both timestamps are present, the TypeScript v0 implementation requires
`expiresAt` to be after `createdAt`.
The TypeScript v0 implementation rejects control characters in `kid` and
write-intent `nonce` fields so authorization metadata remains safe to log,
compare, and persist.

Write requests include a signed authorization envelope. The signed payload is a canonical JSON write intent that includes the operation, package id, owner domain, timestamp, nonce, and operation-specific fields such as release digests or channel names. In v0, `release.publish` includes the default `latest` channel in the signed intent. It also includes `artifactDescriptorDigest`, a digest over the canonical client-controlled artifact descriptor fields that affect the stored release manifest: artifact digest, role, media type, filename, format, and compatibility declarations. Server-derived `ecosystemMetadata` is not part of this signed descriptor digest. The server fetches the domain binding, finds the `kid`, verifies the Ed25519 signature, checks the intent matches the request body, rejects already-used authorization payload digests, and records an authorization proof in the append-only event.

This means a signature over artifact bytes, source bytes, and config bytes is not the only publish check. If a client or intermediary changes descriptor metadata such as `compatibility`, `format`, `mediaType`, or `filename` after signing, the server computes a different `artifactDescriptorDigest` and rejects the publish authorization.

The v0 authorization proof is server-verified publish-time evidence. It records
the verified key snapshot, signature bytes, payload digest, timestamp, and
well-known binding digest, but it does not expose the canonical signed intent or
nonce. Independent clients can audit the event/proof envelope and release
objects from public APIs, but independent Ed25519 re-verification from public
event data requires a future signed-intent proof representation.

The append-only event log is the v0 replay guard. A write authorization is accepted at most once: if an event already contains the same `authorization.payloadDigest`, the server rejects the new write before mutating release or channel state.

Storage adapters should expose an indexed unique lookup for authorization payload digests so replay checks do not require scanning the full event log and concurrent duplicate writes cannot both be accepted.

Publish requests send the authorization envelope as a multipart `authorization` field. Channel mutation requests send it as the JSON `authorization` property.

The authorization decision is logged as part of the write event. Public read APIs should be usable by mirrors, auditors, package managers, and independent verification tools.

### Local Development Binding

For local debugging only, the Hono server may expose a fixed development domain on `dev.localhost`. This is a public demo credential and must never be used for production packages.

Development endpoints:

```http
GET http://dev.localhost:4321/.well-known/regesta.json
GET http://dev.localhost:4321/regesta.public-key.json
GET http://dev.localhost:4321/regesta.private-key.json
```

The well-known response is a normal `regesta.domain-binding` for `dev.localhost`, so packages such as `npm:dev.localhost/hello-regesta` can exercise the v0 domain-bound signing flow without owning a real DNS domain.

## Compatibility Claims

Compatibility fields are declarations, not v0 proof. Release manifests expose compatibility on artifact descriptors because different install artifacts can target different runtimes, platforms, modules, or ABI constraints. The verifier must not claim that Regesta has executed compatibility tests unless a future verified compatibility object exists.
