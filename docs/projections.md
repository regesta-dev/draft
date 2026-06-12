# Ecosystem Projections

Regesta core stores neutral registry facts. Ecosystem projections render those
facts into package-manager-native protocols.

V0 implements the npm projection. PyPI, Cargo, Go, OCI, and other projections
need separate design before implementation.

## Boundary

Core owns:

- canonical package ids;
- release manifests;
- artifact descriptors;
- content-addressed objects;
- channels;
- append-only events;
- publish verification and authorization facts.

Projection layers own:

- package-manager route shapes;
- native package names;
- native resolver metadata;
- native cache and validator behavior;
- upstream fallback policy;
- protocol-specific response formats.

Core must not store npm packuments, PyPI Simple API pages, Cargo index entries,
Go proxy responses, or OCI manifests as the primary model. Those are derived
views over Regesta-native data.

## Package Names

The canonical id is always:

```text
<ecosystem>:<owner-domain>/<package-name>
```

For npm, the projection maps:

```text
npm:some.dev/sdk
```

to the npm-native name:

```text
@some.dev/sdk
```

Other ecosystems must define their own reversible mapping rules in their
projection and client specs before implementation. A Python client may need to
consider normalized distribution names, a Cargo projection may need crate index
rules, a Go projection may need module-path rules, and an OCI projection may
need repository and tag rules.

Those mappings are client and projection concerns. They do not change the core
id shape.

### Mapping Rule Requirements

Every ecosystem mapping must preserve a clear route back to the canonical
Regesta id. A client or projection must define:

- how the owner domain is represented in the ecosystem-native name;
- how the package name is represented after the owner domain;
- which characters are accepted, escaped, normalized, or rejected;
- whether the mapping is fully reversible from the native name alone;
- when a native manifest field is only a hint and `regesta.json` remains the
  authority;
- how collisions are detected after ecosystem-specific normalization;
- how package managers should display the native name without changing the
  stored core id.

For npm, this is already defined: `npm:some.dev/sdk` maps to `@some.dev/sdk`,
and the CLI can infer the Regesta id from `package.json` during publish.

For other ecosystems, Regesta should not assume that npm-style `@scope/name`
syntax is valid or neutral. If an ecosystem cannot represent the owner domain
and package name natively without lossy normalization, the client should require
an explicit `regesta.json` id instead of guessing.

## Metadata

Core can expose small neutral metadata, such as `metadata.description`, when it
is useful across ecosystems.

Core should not define a universal dependency model. Dependency and resolver
metadata belong to artifact-level `ecosystemMetadata`, extracted by artifact
processors and consumed by projections.

For npm, the npm artifact processor can extract package-manager metadata from
`package/package.json`, including dependencies, engines, binaries, platform
constraints, and description. The npm projection can then expose that data in
npm-native packuments and version manifests.

For Regesta-hosted releases, the npm projection emits only the supported npm
resolver metadata fields it knows how to validate and project. Unknown
artifact metadata fields stay inside the Regesta artifact metadata and are not
copied into npm version manifests. This keeps artifact inspection data from
silently becoming package-manager behavior.

Regesta-hosted npm metadata should point `dist.tarball` at the core object URL,
where the object layer serves the immutable artifact. Fallback metadata should
preserve the upstream npm metadata, including upstream `dist.tarball` URLs,
instead of rewriting it to Regesta URLs. Byte serving, range handling, cache
validators, and integrity checks remain object-layer responsibilities.

Future PyPI, Cargo, Go, OCI, and other processors should follow the same
pattern: understand their artifacts, write projection metadata to the artifact,
and leave the core release model neutral.

## Fallback

Fallback is progressive-migration behavior, not core package state.

The npm projection may serve Regesta packages first and fall back to
`registry.npmjs.org` when a package is missing. A package manager or client can
also implement the same policy outside the server by trying Regesta first and
then resolving missing packages from the ecosystem's default registry.

Fallback metadata should not be committed as Regesta package state. When the
server projection handles fallback, upstream packument, version-manifest, and
dist-tag metadata are validated and returned without rewriting. Direct npm
projection tarball routes still redirect to upstream tarballs and the npm
projection never proxies tarball bytes.

## Future Projection Profiles

These profiles define where ecosystem-specific behavior belongs. They do not
change Regesta package ids, release manifests, authorization, storage, or event
semantics.

### PyPI Simple API

A PyPI projection should derive Simple Repository API responses from
`pypi:<domain>/<name>` package state and Python artifacts.

The projection or client owns Python distribution-name normalization, project
page rendering, file links, hash fragments, `requires-python`, yanked markers,
and wheel or source-distribution metadata. Those values should come from
artifact-level Python metadata extracted by a Python artifact processor.

Fallback to PyPI should be projection or client policy. It should not create
Regesta package state unless the upstream bytes are explicitly mirrored.

Reference: [PyPA Simple Repository API](https://packaging.python.org/specifications/simple-repository-api/).

### Cargo Registry

A Cargo projection should derive crate index entries, crate download responses,
and registry configuration from `cargo:<domain>/<crate>` package state and crate
artifacts.

The projection or client owns Cargo crate-name rules, index path rules, checksum
formatting, feature metadata, dependency metadata, and yank representation.
Those values should come from artifact-level Cargo metadata or future auditable
governance events when a registry action changes public package state.

Fallback to crates.io should be projection or client policy. It should not
change core package identity or release manifests.

Reference: [Cargo Registry Index](https://doc.rust-lang.org/cargo/reference/registry-index.html).

### Go Module Proxy

A Go projection should derive module proxy responses from
`go:<domain>/<module>` package state and Go module or source artifacts.

The projection or client owns Go module-path mapping, version list responses,
`.info`, `.mod`, and `.zip` response generation, and compatibility with
GOPROXY-style fallback. Checksum database behavior is separate from the core
registry model and belongs with future transparency and verification work.

Fallback to upstream module sources or another Go proxy should be projection or
client policy. It should not store upstream proxy responses as the Regesta
source of truth.

Reference: [Go Modules Reference](https://go.dev/ref/mod).

### OCI Distribution

An OCI projection should derive manifests, blobs, and tag responses from
`oci:<domain>/<repository>` package state and OCI artifacts.

Blob bytes can map naturally to Regesta content-addressed objects. Tags should
map to channels or projection metadata, depending on the operation being
represented. OCI pushes should be translated into Regesta publish writes; core
should not store an OCI registry database as the primary model.

Fallback to an upstream OCI registry should be projection or client policy. It
should preserve upstream blob and manifest identity unless an operator
explicitly mirrors those objects into Regesta.

Reference: [OCI Distribution Specification](https://github.com/opencontainers/distribution-spec).

## Projection Checklist

Before adding a new ecosystem projection, define:

- native package-name mapping;
- native metadata extraction;
- artifact roles and supported media types;
- platform and compatibility metadata;
- channel or tag semantics;
- cache validators and stale-read behavior;
- fallback behavior;
- verification behavior;
- which facts are stored in core and which responses are derived.

The projection may evolve independently, but it must not redefine core identity,
storage, authorization, or event semantics.
