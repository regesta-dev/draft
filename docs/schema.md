# Schema

This page summarizes the current V0 object shapes. A machine-readable JSON
Schema reference is available at
[`/schema/regesta-v0.schema.json`](/schema/regesta-v0.schema.json).

The JSON Schema reference is not the protocol authority. The authoritative
implementation is still the TypeScript protocol and core validation code,
especially for semantic checks such as canonical event ids, owner-domain
validation, and object digest verification.

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

The `ecosystem` key inside package ids is not a closed enum. Current examples
include npm, PyPI, Cargo, Go, and OCI, but future projection/client ecosystems
can use the same `ecosystem:domain/name` shape without changing core objects.

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
source of truth. The event log is. Servers can materialize this object from
event-derived indexes for read performance; verifiers should still reconstruct
package state from public events when auditing it.

## Release Manifest

A release manifest records immutable release facts.

```json
{
  "object": "regesta.release-manifest",
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

## Metadata For Tools

Regesta stores source, artifact, release, event, and authorization metadata as
structured data so package managers, security tools, mirrors, auditors, IDEs,
and AI agents can inspect package state without scraping an ecosystem-native
response.

V0 preserves:

- canonical package id, ecosystem, owner domain, package name, and version;
- release creation time;
- source archive descriptor;
- install artifact descriptors;
- artifact role, format, filename, media type, digest, and byte size;
- neutral release metadata such as description;
- language hints from `regesta.json`;
- declared artifact compatibility;
- artifact-level ecosystem metadata extracted by processors;
- event ids, event timestamps, channel changes, and authorization proof
  descriptors.

Those fields are inspection metadata, not safety claims. V0 does not prove that
source built an artifact, that an artifact is non-malicious, or that declared
compatibility was tested.

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

## Object Inventory

Object inventory pages expose public object descriptors for mirrors and
auditors. They do not include object bytes.

```json
{
  "object": "regesta.object-inventory",
  "objects": [
    {
      "digest": "sha256:...",
      "mediaType": "application/gzip",
      "size": 4567
    }
  ],
  "nextAfter": "sha256:..."
}
```

`nextAfter` is the digest cursor for the next page when the page is non-empty.

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
JSON-compatible projection metadata extracted by artifact processors. For npm,
it comes from `package/package.json` inside the install tarball, and verifiers
can reproduce that extraction from the artifact bytes.

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

## Write Authorization

Authenticated writes carry a `writeAuthorization` object. The object wraps a
canonical write intent payload plus a domain-bound signature. Ed25519 JWK keys
use the default `EdDSA` shape:

```json
{
  "alg": "EdDSA",
  "kid": "ed25519:example",
  "payload": {
    "object": "regesta.write-intent",
    "operation": "release.publish",
    "package": "npm:some.dev/sdk",
    "domain": "some.dev",
    "version": "1.2.3",
    "channel": "latest",
    "configDigest": "sha256:...",
    "sourceDigest": "sha256:...",
    "artifactDigests": ["sha256:..."],
    "artifactDescriptorDigest": "sha256:...",
    "timestamp": "2026-06-03T00:00:00.000Z",
    "nonce": "..."
  },
  "signature": "..."
}
```

SSH signing uses the same payload but stores an OpenSSH `SSHSIG` signature:

```json
{
  "alg": "ssh-ed25519",
  "kid": "ssh-ed25519:...",
  "payload": {
    "object": "regesta.write-intent",
    "operation": "release.publish",
    "package": "npm:some.dev/sdk",
    "domain": "some.dev",
    "version": "1.2.3",
    "channel": "latest",
    "configDigest": "sha256:...",
    "sourceDigest": "sha256:...",
    "artifactDigests": ["sha256:..."],
    "artifactDescriptorDigest": "sha256:...",
    "timestamp": "2026-06-03T00:00:00.000Z",
    "nonce": "..."
  },
  "signature": "-----BEGIN SSH SIGNATURE-----\n...\n-----END SSH SIGNATURE-----"
}
```

`operation` selects the payload shape:

| Operation         | Additional payload fields                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `release.publish` | `version`, `channel`, `configDigest`, `sourceDigest`, `artifactDigests`, `artifactDescriptorDigest` |
| `channel.update`  | `channel`, `version`, optional `previousVersion`                                                    |
| `channel.delete`  | `channel`, optional `previousVersion`                                                               |

For every write intent, payload `domain` must exactly match the owner domain
parsed from payload `package`.

The server verifies the authorization against the owner domain binding and
stores only the accepted `authorizationProof` on events. The original signed
payload is not stored as event state in V0.

## Events

Events are append-only registry facts. Every event has:

- `object: "regesta.event"`;
- `eventType`;
- `timestamp`;
- deterministic `id`.

Authenticated writes also include an `authorization` proof. The proof stores the
public verification material and digests needed for later audit; it does not
store the original signed write intent payload.

### Release Published

```json
{
  "object": "regesta.event",
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
    "alg": "EdDSA",
    "kid": "ed25519:example",
    "domain": "some.dev",
    "publicKeyJwk": {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "..."
    },
    "signature": "...",
    "signedAt": "2026-06-03T00:00:00.000Z",
    "payloadDigest": "sha256:...",
    "wellKnownDigest": "sha256:..."
  }
}
```

`wellKnownDigest` is the SHA-256 digest of the exact well-known response bytes
that were used for authorization.

### Channel Updated

```json
{
  "object": "regesta.event",
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

V0 domain binding is fetched directly as JSON from a well-known endpoint
controlled by the owner domain.

For package id `npm:some.dev/sdk`, the binding URL is:

```text
https://some.dev/.well-known/regesta.json
```

The response must be UTF-8 JSON with an `application/json` or `+json` content
type. The registry does not follow redirects for this fetch. The `domain` field
must match the owner domain, and the authorization `kid` must match one active
key in `keys`.

```json
{
  "object": "regesta.domain-binding",
  "domain": "some.dev",
  "keys": [
    {
      "kid": "ed25519:example",
      "use": "regesta-write",
      "alg": "EdDSA",
      "createdAt": "2026-06-01T00:00:00.000Z",
      "expiresAt": "2026-09-01T00:00:00.000Z",
      "publicKeyJwk": {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "..."
      }
    },
    {
      "kid": "ssh-ed25519:...",
      "use": "regesta-write",
      "alg": "ssh-ed25519",
      "createdAt": "2026-06-01T00:00:00.000Z",
      "expiresAt": "2026-09-01T00:00:00.000Z",
      "publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
    }
  ]
}
```

The server snapshots proof material into accepted events so historical
authorization evidence remains auditable after the domain binding changes.
The `keys` array must contain at least one write key. Key validity windows are
optional, but if both `createdAt` and `expiresAt` are present, `expiresAt` must
be after `createdAt`.
