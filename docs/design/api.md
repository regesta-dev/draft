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
POST /v0/releases
Content-Type: multipart/form-data
```

Multipart fields:

| Field          | Type   | Required | Description                                                           |
| -------------- | ------ | -------- | --------------------------------------------------------------------- |
| `config`       | JSON   | yes      | `regesta.json` content or equivalent publish config.                  |
| `source`       | binary | yes      | Source archive bytes.                                                 |
| `artifacts`    | JSON   | yes      | Array describing binary artifact parts.                               |
| artifact parts | binary | yes      | One or more install or auxiliary artifacts referenced by `artifacts`. |

Example `artifacts` field:

```json
[
  {
    "part": "artifact.install",
    "role": "install",
    "format": "npm-tarball",
    "mediaType": "application/gzip",
    "filename": "sdk-1.2.3.tgz"
  }
]
```

The multipart body then includes a binary part named `artifact.install`.

For v0, a release should include exactly one primary `install` artifact for the ecosystem in the package id. Artifact descriptors do not repeat the package ecosystem. The manifest format uses an array so future releases can attach docs, type bundles, signatures, attestations, or verification outputs without changing the release object shape.

Response:

```json
{
  "manifest": {
    "digest": "sha256:...",
    "size": 1234,
    "mediaType": "application/vnd.regesta.release-manifest.v0+json"
  },
  "event": {
    "digest": "sha256:...",
    "size": 567,
    "mediaType": "application/vnd.regesta.event.v0+json"
  },
  "package": "npm:some.dev/sdk",
  "channel": "latest",
  "version": "1.2.3"
}
```

V0 publish assigns the published version to the default `latest` channel as part of the accepted `release.publish` write. The channel did not have to point at a version before the release existed.

### Read Package

```http
GET /v0/packages/{packageId}
```

`packageId` is the full Regesta package id as one URL-encoded path segment. This avoids ambiguous parsing when ecosystem-native names contain path-like segments such as `releases` or `channels`.

Examples:

```http
GET /v0/packages/npm%3Asome.dev%2Fsdk
GET /v0/packages/pypi%3Asome.dev%2Fsdk
GET /v0/packages/go%3Asome.dev%2Fsdk
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

This endpoint returns a core Regesta package view. It does not return an npm packument unless the request is made through the npm projection API.

### Read Package By Channel

```http
GET /v0/packages/{packageId}/channels/{channel}
```

This endpoint follows a mutable package channel, resolves it to the current version, and returns the same stored release object as `GET /v0/packages/{packageId}/releases/{version}`.

Examples:

```http
GET /v0/packages/npm%3Asome.dev%2Fsdk/channels/latest
GET /v0/packages/npm%3Asome.dev%2Fsdk/channels/beta
```

If the channel does not exist, the response is `404`.

### Update Channel

```http
PUT /v0/packages/{packageId}/channels/{channel}
Content-Type: application/json
```

Request:

```json
{
  "version": "1.2.3"
}
```

Channels are mutable package-level version pointers. They are not release manifest fields and they do not change any release object. V0 publish creates or moves the default `latest` channel to the published version. Explicit channel updates after publish create append-only `channel.updated` events.

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
DELETE /v0/packages/{packageId}/channels/{channel}
```

Deleting a channel removes the mutable pointer and creates a `channel.deleted` event. It does not delete any release.

### Read Release

```http
GET /v0/packages/{packageId}/releases/{version}
```

Response:

```json
{
  "manifest": {
    "digest": "sha256:...",
    "size": 1234,
    "mediaType": "application/vnd.regesta.release-manifest.v0+json"
  },
  "release": {
    "id": "npm:some.dev/sdk",
    "version": "1.2.3",
    "createdAt": "2026-06-03T00:00:00.000Z"
  }
}
```

Clients that need full verification should fetch the manifest object, event object, source object, artifact objects, and relevant log checkpoints.

### Read Object

```http
GET /v0/objects/{algorithm}/{hex}
HEAD /v0/objects/{algorithm}/{hex}
```

Example:

```http
GET /v0/objects/sha256/012345...
```

The response content type is the object's stored media type. The response bytes must hash to the requested digest.

### Read Event Log

```http
GET /v0/events?after={cursor}
GET /v0/events/{algorithm}/{hex}
GET /v0/checkpoints/latest
```

Events describe public registry state changes. Checkpoints are signed summaries of the append-only log.

### Verify Release

```http
GET /v0/packages/{packageId}/releases/{version}/verification
```

This endpoint may provide a convenience verification summary, but it must not be the only verification path. Independent clients should be able to verify the release from public objects and log data.

Example response:

```json
{
  "ok": true,
  "checks": [
    "manifest-digest",
    "publish-event",
    "source-object",
    "install-artifact",
    "event-log-membership"
  ],
  "provenance": {
    "level": "source-attached",
    "verified": false
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

Projection APIs should expose resolver-critical metadata before artifact download. For npm, the packument version object should include npm-native fields such as `dependencies`, `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta`, `bundleDependencies`, `engines`, `os`, `cpu`, and `libc` when those fields exist in the published `package.json`.

npm packuments should include npm-native `time` metadata: `created`, `modified`, and one timestamp per published version. Version timestamps are derived from release manifest `createdAt` values. `modified` should reflect the newest package metadata change known to the registry, including channel updates when that event timestamp is available.

This metadata is not a generic Regesta dependency model. It is an ecosystem projection snapshot attached to the relevant install artifact, normally extracted from the uploaded install artifact at publish time, so package managers can continue dependency resolution without first downloading the tarball.

If an npm package is not present in Regesta, the npm projection may fetch and return the upstream packument from `registry.npmjs.org`. Tarball requests must not be proxied through Regesta; upstream packuments should keep their original npmjs tarball URLs.

## Error Format

Errors should use a small structured response:

```json
{
  "error": {
    "code": "release_already_exists",
    "message": "Release already exists: npm:some.dev/sdk@1.2.3"
  }
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

Write requests include a signed authorization envelope. The signed payload is a canonical JSON write intent that includes the operation, package id, owner domain, timestamp, nonce, and operation-specific fields such as release digests or channel names. In v0, `release.publish` includes the default `latest` channel in the signed intent. The server fetches the domain binding, finds the `kid`, verifies the Ed25519 signature, checks the intent matches the request body, and records an authorization proof in the append-only event.

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
