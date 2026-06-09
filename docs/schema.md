# Schema

This page summarizes the current V0 object shapes. It is not a generated JSON
Schema file. The authoritative implementation is still the TypeScript protocol
and core validation code.

## `regesta.json`

`regesta.json` is the client-side release intent file. It accepts JSON5 syntax
and stays intentionally thin.

```json
{
  "id": "npm:some.dev/sdk",
  "languages": ["typescript"],
  "source": {
    "include": ["package.json", "README.md", "src"],
    "exclude": ["dist", "node_modules"]
  },
  "provenance": {
    "level": "source-attached"
  },
  "family": "some.dev/sdk"
}
```

Fields:

| Field         | Required | Notes                                                    |
| ------------- | -------- | -------------------------------------------------------- |
| `id`          | yes      | Canonical `ecosystem:domain/name` package id.            |
| `version`     | inferred | Usually inferred from the native manifest by the client. |
| `description` | inferred | Optional neutral release metadata.                       |
| `exports`     | inferred | Optional package export metadata.                        |
| `repository`  | inferred | Optional repository metadata.                            |
| `languages`   | no       | Source or artifact language hints.                       |
| `source`      | yes      | Source archive include/exclude rules.                    |
| `provenance`  | no       | Defaults to `{ "level": "source-attached" }` in V0.      |
| `family`      | no       | Cross-ecosystem family id, such as `some.dev/sdk`.       |

Rejected fields:

- `$schema`;
- `schema`;
- generic `dependencies`;
- release-level `compatibility`;
- unknown fields.

Source paths must be normalized relative archive paths. They must not be
absolute, contain parent-directory segments, use backslashes, contain control
characters, or exclude `regesta.json`.

## Package State

Package state is a mutable projection derived from append-only package events.

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

The package state response is useful to clients, but it is not the immutable
source of truth. The event log is.

## Release Manifest

A release manifest records immutable release facts.

```json
{
  "object": "regesta.release-manifest",
  "specVersion": 0,
  "id": "npm:some.dev/sdk",
  "ecosystem": "npm",
  "name": "some.dev/sdk",
  "version": "1.2.3",
  "createdAt": "2026-06-03T00:00:00.000Z",
  "configDigest": "sha256:...",
  "source": {
    "digest": "sha256:...",
    "mediaType": "application/vnd.regesta.source-archive+tgz",
    "size": 1234
  },
  "artifacts": [
    {
      "digest": "sha256:...",
      "mediaType": "application/gzip",
      "size": 4567,
      "role": "install",
      "format": "npm-tarball",
      "filename": "sdk-1.2.3.tgz"
    }
  ],
  "metadata": {
    "description": "Example SDK"
  },
  "provenance": {
    "level": "source-attached",
    "verified": false
  }
}
```

The manifest does not contain:

- channels;
- generic dependencies;
- npm packuments;
- package-manager-native resolver state as top-level fields.

## Object Descriptor

Source archives, install artifacts, and manifest bytes are addressed by object
descriptors.

```json
{
  "digest": "sha256:...",
  "mediaType": "application/gzip",
  "size": 4567
}
```

`digest` is the hash of the exact stored bytes. `size` is the byte length.
`mediaType` is stored as part of the descriptor and must not be inferred from a
multipart header after the fact.

## Artifact Descriptor

Artifacts are release-level objects with role and ecosystem metadata.

```json
{
  "digest": "sha256:...",
  "mediaType": "application/gzip",
  "size": 4567,
  "role": "install",
  "format": "npm-tarball",
  "filename": "sdk-1.2.3.tgz",
  "compatibility": {
    "runtimes": ["node"],
    "modules": ["esm"]
  },
  "ecosystemMetadata": {
    "npm": {
      "dependencies": {
        "left-pad": "^1.3.0"
      }
    }
  }
}
```

`compatibility` is declared intent, not V0 proof. `ecosystemMetadata` is
projection metadata extracted by artifact processors. For npm, it comes from
`package/package.json` inside the install tarball.

## Compatibility

Compatibility is artifact-level because different artifacts in one release can
target different platforms or runtimes.

```json
{
  "runtimes": [
    {
      "name": "node",
      "versions": ">=20",
      "conditions": ["node", "import"]
    }
  ],
  "platforms": [
    {
      "os": ["linux"],
      "arch": ["x64", "arm64"],
      "libc": ["glibc", "musl"]
    }
  ],
  "modules": ["esm"],
  "abi": [
    {
      "name": "node-api",
      "versions": ["napi8", "napi9"]
    }
  ]
}
```

Strings are accepted as declarations. V0 does not prove that a compatibility
claim is true.

## Events

Events are append-only registry facts. Every event has:

- `object: "regesta.event"`;
- `specVersion: 0`;
- `eventType`;
- `timestamp`;
- deterministic `id`.

### Release Published

```json
{
  "object": "regesta.event",
  "specVersion": 0,
  "eventType": "release.published",
  "id": "sha256:...",
  "timestamp": "2026-06-03T00:00:00.000Z",
  "release": {
    "id": "npm:some.dev/sdk",
    "version": "1.2.3",
    "manifestDigest": "sha256:..."
  },
  "channel": "latest",
  "sourceDigest": "sha256:...",
  "artifactDigests": ["sha256:..."],
  "authorization": {
    "object": "regesta.authorization-proof",
    "specVersion": 0,
    "alg": "EdDSA",
    "kid": "ed25519:example",
    "domain": "some.dev",
    "signedAt": "2026-06-03T00:00:00.000Z",
    "payloadDigest": "sha256:...",
    "wellKnownDigest": "sha256:..."
  }
}
```

### Channel Updated

```json
{
  "object": "regesta.event",
  "specVersion": 0,
  "eventType": "channel.updated",
  "id": "sha256:...",
  "timestamp": "2026-06-03T00:00:00.000Z",
  "package": "npm:some.dev/sdk",
  "channel": "beta",
  "version": "1.3.0-beta.1",
  "previousVersion": "1.2.3"
}
```

### Channel Deleted

```json
{
  "object": "regesta.event",
  "specVersion": 0,
  "eventType": "channel.deleted",
  "id": "sha256:...",
  "timestamp": "2026-06-03T00:00:00.000Z",
  "package": "npm:some.dev/sdk",
  "channel": "beta",
  "previousVersion": "1.3.0-beta.1"
}
```

Event ids are computed from canonical event bytes excluding `id`. Storage
adapters must reject events whose id does not match their canonical payload.

## Domain Binding

V0 domain binding is fetched from a well-known endpoint controlled by the owner
domain.

```json
{
  "object": "regesta.domain-binding",
  "specVersion": 0,
  "domain": "some.dev",
  "keys": [
    {
      "kid": "ed25519:example",
      "use": "regesta-write",
      "alg": "EdDSA",
      "publicKeyJwk": {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "..."
      }
    }
  ]
}
```

The server snapshots proof material into accepted events so historical
authorization evidence remains auditable after the domain binding changes.
