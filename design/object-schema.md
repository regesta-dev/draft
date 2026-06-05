# Regesta Object Schema Design

Status: draft.

This document defines the public object model for a generic Regesta registry. It is intentionally broader than the current TypeScript implementation and should be treated as design input, not implemented behavior.

## Design Goals

- Keep Regesta language-neutral and ecosystem-neutral.
- Use one domain-scoped package id format across ecosystems without making any one ecosystem global.
- Preserve source and install artifacts as content-addressed objects.
- Keep `regesta.json` thin and avoid package-manager-specific duplication.
- Treat compatibility as declared intent, not v0 proof.
- Use source-attached provenance only for v0.
- Avoid build hints, build recipes, declared build commands, and forced builders.

## Package Id

Canonical package ids use:

```text
<ecosystem>:<owner-domain>/<package-name>
```

Rules:

- `ecosystem` is lowercase ASCII plus digits and hyphens.
- `owner-domain` is the domain that owns and authorizes the package namespace.
- `package-name` is the package name inside that owner domain.
- The path after the ecosystem prefix must not contain control characters.
- Regesta public objects always store the full id.
- Ecosystem-specific tools may omit the prefix when the ecosystem context is known, and projections may map the core id into native package-manager names.
- The leading `@` used by npm scoped packages is not part of the core id. It is added by the npm projection when exposing `npm:some.dev/sdk` as `@some.dev/sdk`.

Examples:

```text
npm:some.dev/sdk
pypi:some.dev/sdk
cargo:some.dev/sdk
go:some.dev/sdk
oci:some.dev/sdk
```

Release coordinates append the version to the package id:

```text
npm:some.dev/sdk@1.2.3
pypi:some.dev/sdk@1.2.3
```

Parsers should split package id from version at the last `@`.

## `regesta.json`

`regesta.json` describes Regesta-specific release intent. It should not duplicate ecosystem metadata that already belongs in `package.json`, `pyproject.toml`, `Cargo.toml`, or another native manifest.

The file is named `regesta.json` for ecosystem familiarity, but parsers should accept JSON5 syntax so authors can use comments, unquoted object keys, single-quoted strings, and trailing commas.

There is no `$schema` field in `regesta.json`.

There is no generic `dependencies` field in `regesta.json`. Dependency semantics belong to the native package ecosystem.

Package id inference belongs to publish clients. A client may infer the canonical Regesta id from native manifests, such as `package.json`, `pyproject.toml`, `Cargo.toml`, Go module files, or OCI image metadata, but the registry object model stores only the resulting canonical id.

Recommended deterministic mappings:

| Ecosystem | Native input example            | Regesta id           |
| --------- | ------------------------------- | -------------------- |
| npm       | `@some.dev/sdk`                 | `npm:some.dev/sdk`   |
| PyPI      | `some-dev-sdk`                  | `pypi:some.dev/sdk`  |
| Cargo     | `some-dev-sdk`                  | `cargo:some.dev/sdk` |
| Go        | `some.dev/sdk`                  | `go:some.dev/sdk`    |
| OCI       | `registry.example/some.dev/sdk` | `oci:some.dev/sdk`   |

These mappings are client and projection rules, not mutable registry aliases. The current `regesta` CLI is an npm-focused client for v0 development and testing; later ecosystem clients can provide their own inference and projection behavior without changing the core object model.

Draft example for npm:

```json
{
  "id": "npm:some.dev/sdk",
  "languages": ["typescript"],
  "source": {
    "include": ["package.json", "README.md", "src"],
    "exclude": ["dist", "node_modules"]
  },
  "compatibility": {
    "runtimes": [
      {
        "name": "node",
        "versions": ">=20"
      },
      "bun"
    ],
    "platforms": [
      {
        "os": ["darwin", "linux", "windows"],
        "arch": ["arm64", "x64"]
      }
    ],
    "modules": ["esm"]
  },
  "provenance": {
    "level": "source-attached"
  },
  "family": "some.dev/sdk"
}
```

Draft example for a Python package with native code:

```json
{
  "id": "pypi:some.dev/sdk",
  "languages": ["python", "rust"],
  "source": {
    "include": ["pyproject.toml", "README.md", "src", "crates"]
  },
  "compatibility": {
    "runtimes": [
      {
        "name": "python",
        "versions": ">=3.10"
      }
    ],
    "platforms": [
      {
        "os": ["linux"],
        "arch": ["x64", "arm64"],
        "libc": ["glibc", "musl"]
      },
      {
        "os": ["darwin"],
        "arch": ["x64", "arm64"]
      }
    ],
    "abi": [
      {
        "name": "cpython",
        "versions": ["cp310", "cp311", "cp312"]
      }
    ]
  },
  "provenance": {
    "level": "source-attached"
  },
  "family": "some.dev/sdk"
}
```

### Config Fields

| Field           | Required | Description                                                                  |
| --------------- | -------- | ---------------------------------------------------------------------------- |
| `id`            | yes      | Canonical package id, formatted as `ecosystem:owner-domain/package-name`.    |
| `version`       | optional | Release version if it cannot be inferred from the native ecosystem manifest. |
| `languages`     | optional | Declared source or artifact languages.                                       |
| `source`        | yes      | Source archive selection rules.                                              |
| `compatibility` | optional | Declared runtime, platform, module, and ABI compatibility.                   |
| `provenance`    | optional | Defaults to `{ "level": "source-attached" }` in v0.                          |
| `family`        | optional | Cross-ecosystem package family id, such as `some.dev/sdk`.                   |

`kind` is intentionally not required. If product taxonomy is needed later, it should be optional metadata and must not control registry semantics.

`compatibility.ecosystems` is intentionally omitted. The primary ecosystem is already declared by `id`.

## Compatibility

Compatibility is a declaration. It is useful for package managers, scanners, UI, and policy engines, but v0 verification must not treat it as proof.

Draft shape:

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

### Runtime Names

Runtime names should allow known keys plus custom strings. WinterCG Runtime Keys can be used for JavaScript and web runtimes, but compatibility is not limited to them.

Use a string item for a runtime with no extra constraints, such as `"node"` or `"bun"`. Use an object item only when the release needs to declare versions or package/runtime conditions.

Examples:

```text
node
bun
deno
workerd
react-native
python
jvm
wasm
```

### Platforms

Platform constraints are arrays because one release can support multiple independent target sets.

Common fields:

| Field  | Description                                              |
| ------ | -------------------------------------------------------- |
| `os`   | Operating systems, such as `linux`, `darwin`, `windows`. |
| `arch` | CPU architectures, such as `x64`, `arm64`, `wasm32`.     |
| `libc` | C library constraints, such as `glibc`, `musl`.          |

Additional platform fields may be added later for GPU, accelerator, kernel, or mobile constraints.

### Modules

`modules` describes consumption forms, not package ecosystems.

Examples:

```text
esm
cjs
wasm
wasm-component
python-wheel
python-sdist
```

### ABI

`abi` describes native or binary compatibility.

Examples:

```json
[
  {
    "name": "node-api",
    "versions": ["napi8", "napi9"]
  },
  {
    "name": "cpython",
    "versions": ["cp310", "cp311", "cp312"]
  }
]
```

## Object Descriptor

All immutable objects are referenced through descriptors:

```json
{
  "digest": "sha256:...",
  "size": 12345,
  "mediaType": "application/vnd.regesta.source-archive+tgz"
}
```

Rules:

- `digest` is algorithm-prefixed.
- `size` is the byte length.
- `mediaType` identifies the object format.
- URLs are retrieval locations, not identity.
- Objects must be retrievable by digest.

## Package State

Package state is a projection derived from append-only events. It is mutable as a view, but every change must be represented by an immutable event.

Example:

```json
{
  "object": "regesta.package-state",
  "specVersion": 0,
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

Channels are package-level version pointers. They are not release manifest fields because they can change after a release is published.

V0 publish assigns the new version to the default `latest` channel. Before the first publish, that channel has no corresponding version. Later channel changes are represented by explicit channel events.

Common channel names:

```text
latest
next
beta
canary
lts
```

Ecosystem projections may map channels into native concepts. npm projection can expose them as `dist-tags`. Cargo projection may ignore them because Cargo primarily uses SemVer pre-release versions rather than registry-level mutable version pointers.

## Release Manifest

The release manifest is the central public object for a release. Its digest identifies the release facts.

Example:

```json
{
  "object": "regesta.release-manifest",
  "specVersion": 0,
  "id": "npm:some.dev/sdk",
  "ecosystem": "npm",
  "name": "some.dev/sdk",
  "version": "1.2.3",
  "family": "some.dev/sdk",
  "languages": ["typescript"],
  "createdAt": "2026-06-03T00:00:00.000Z",
  "source": {
    "digest": "sha256:...",
    "size": 12345,
    "mediaType": "application/vnd.regesta.source-archive+tgz"
  },
  "artifacts": [
    {
      "role": "install",
      "ecosystem": "npm",
      "format": "npm-tarball",
      "digest": "sha256:...",
      "size": 45678,
      "mediaType": "application/gzip",
      "filename": "sdk-1.2.3.tgz"
    }
  ],
  "compatibility": {
    "runtimes": [
      {
        "name": "node",
        "versions": ">=20"
      },
      "bun"
    ],
    "platforms": [
      {
        "os": ["darwin", "linux", "windows"],
        "arch": ["arm64", "x64"]
      }
    ],
    "modules": ["esm"]
  },
  "ecosystemMetadata": {
    "npm": {
      "dependencies": {
        "@some.dev/core": "^1.0.0"
      }
    }
  },
  "provenance": {
    "level": "source-attached",
    "verified": false
  },
  "configDigest": "sha256:..."
}
```

### Manifest Fields

| Field               | Required | Description                                        |
| ------------------- | -------- | -------------------------------------------------- |
| `object`            | yes      | Public object discriminator.                       |
| `specVersion`       | yes      | Regesta object format version.                     |
| `id`                | yes      | Canonical package id.                              |
| `ecosystem`         | yes      | Parsed ecosystem from `id`.                        |
| `name`              | yes      | Parsed domain-scoped package name from `id`.       |
| `version`           | yes      | Release version.                                   |
| `family`            | optional | Cross-ecosystem package family id.                 |
| `languages`         | optional | Declared package languages.                        |
| `createdAt`         | yes      | Publication timestamp.                             |
| `source`            | yes      | Source archive descriptor.                         |
| `artifacts`         | yes      | Release artifact descriptors.                      |
| `compatibility`     | optional | Declared compatibility.                            |
| `ecosystemMetadata` | optional | Ecosystem-native metadata used by projection APIs. |
| `provenance`        | yes      | V0 source-attached provenance.                     |
| `configDigest`      | yes      | Digest of normalized `regesta.json` config.        |

The manifest should not contain its own digest. The digest is computed over the canonical manifest bytes.

The manifest should not contain channels such as `latest`, `next`, or `beta`. The default `latest` channel is assigned by the publish event, and later channel changes must be represented by channel events.

The manifest should not define a generic cross-ecosystem dependency model. However, it may include small ecosystem-native metadata snapshots that are needed to produce projection APIs without downloading install artifacts. For npm, the registry can extract resolver-relevant fields from `package/package.json` at publish time and expose them through the npm packument.

Example npm metadata snapshot:

```json
{
  "ecosystemMetadata": {
    "npm": {
      "dependencies": {
        "@some.dev/core": "^1.0.0"
      },
      "optionalDependencies": {
        "@some.dev/native-linux-x64": "^1.0.0"
      },
      "peerDependencies": {
        "react": "^19.0.0"
      },
      "peerDependenciesMeta": {
        "react": {
          "optional": true
        }
      },
      "engines": {
        "node": ">=20"
      }
    }
  }
}
```

This is projection metadata, not Regesta's own dependency language. Other ecosystems should use their own metadata snapshots or projection objects rather than being forced into npm-shaped fields.

## Artifact Descriptor

Artifacts are immutable release outputs.

```json
{
  "role": "install",
  "ecosystem": "npm",
  "format": "npm-tarball",
  "digest": "sha256:...",
  "size": 45678,
  "mediaType": "application/gzip",
  "filename": "sdk-1.2.3.tgz"
}
```

Required fields:

- `role`
- `digest`
- `size`
- `mediaType`

Recommended fields:

- `ecosystem`
- `format`
- `filename`

Common roles:

```text
install
types
docs
ai-context
signature
attestation
```

V0 requires one `install` artifact. Future versions may support additional roles.

## Provenance

V0 provenance is intentionally minimal:

```json
{
  "level": "source-attached",
  "verified": false
}
```

Meaning:

- Source bytes are attached and content-addressed.
- Install artifact bytes are attached and content-addressed.
- The release does not claim a verified source-to-artifact build.
- The release does not include a build command, build hint, build recipe, or trusted builder statement.

Future provenance levels may include reproducible rebuilds or trusted builder attestations, but they are not v0 behavior.

## Registry Event

Registry events are append-only facts.

Example publish event:

```json
{
  "object": "regesta.event",
  "specVersion": 0,
  "eventType": "release.published",
  "id": "sha256:...",
  "timestamp": "2026-06-03T00:00:00.000Z",
  "channel": "latest",
  "release": {
    "id": "npm:some.dev/sdk",
    "version": "1.2.3",
    "manifestDigest": "sha256:..."
  },
  "sourceDigest": "sha256:...",
  "artifactDigests": ["sha256:..."],
  "authorization": {
    "object": "regesta.authorization-proof",
    "specVersion": 0,
    "domain": "some.dev",
    "kid": "ed25519:2026-06-main",
    "alg": "EdDSA",
    "signedAt": "2026-06-03T00:00:00.000Z",
    "payloadDigest": "sha256:...",
    "signature": "base64url-signature",
    "wellKnownDigest": "sha256:...",
    "publicKeyJwk": {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "base64url-public-key"
    }
  }
}
```

Event ids are computed from canonical event bytes excluding `id`, then stored in `id`.

V0 write events should include `authorization` when accepted through the public API. The proof snapshots the verified domain key and signed payload digest so historical events remain auditable even if the domain's well-known file changes later.

Example channel update event:

```json
{
  "object": "regesta.event",
  "specVersion": 0,
  "eventType": "channel.updated",
  "id": "sha256:...",
  "timestamp": "2026-06-03T00:10:00.000Z",
  "package": "npm:some.dev/sdk",
  "channel": "latest",
  "version": "1.2.3",
  "previousVersion": "1.2.2"
}
```

Example channel delete event:

```json
{
  "object": "regesta.event",
  "specVersion": 0,
  "eventType": "channel.deleted",
  "id": "sha256:...",
  "timestamp": "2026-06-03T00:20:00.000Z",
  "package": "npm:some.dev/sdk",
  "channel": "beta",
  "previousVersion": "1.3.0-beta.1"
}
```

Channel events mutate package state projections only. They do not change release manifests, source objects, artifact objects, or publish events.

## Package Family

Package family links related ecosystem packages without merging their package identities.

Example:

```json
{
  "family": "some.dev/sdk",
  "members": [
    "npm:some.dev/sdk",
    "cargo:some.dev/sdk",
    "go:some.dev/sdk",
    "pypi:some.dev/sdk"
  ]
}
```

Family records are metadata and navigation aids. They should not replace package ids, release manifests, or ecosystem-native projection names.

## Canonicalization

Public objects must have a deterministic byte representation before digesting.

Requirements:

- JSON objects use deterministic key ordering.
- Strings are Unicode strings encoded as UTF-8.
- No insignificant whitespace is required for digesting.
- Digest computation is over canonical bytes, not parsed object identity.
- Independent implementations must be able to reproduce object digests.

The exact canonical JSON profile should be specified separately once the object model is stable.
