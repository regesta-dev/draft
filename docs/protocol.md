# Protocol

This page summarizes the current V0 protocol shape. It is intentionally concise
and avoids future checkpoint or witness formats that are not designed yet.

## Package Identity

Canonical package ids use:

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

Rules:

- `ecosystem` is lowercase ASCII plus digits and hyphens.
- `owner-domain` is a canonical lowercase DNS-style domain.
- `package-name` is the name inside that owner domain.
- public Regesta objects always store the full id.
- ecosystem-specific tools may omit the prefix only inside that ecosystem
  context.

npm's leading `@` is projection syntax, not part of the core id. The npm
projection maps `npm:some.dev/sdk` to `@some.dev/sdk`.

## `regesta.json`

`regesta.json` describes Regesta-specific release intent. It should stay thin.

Current V0 fields:

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

The parser accepts JSON5 syntax.

V0 rejects:

- `$schema` and `schema`;
- generic `dependencies`;
- release-level `compatibility`;
- unknown fields;
- source paths that are absolute, use backslashes, contain `..`, or are not
  normalized.

Package id inference belongs to clients. The current CLI may infer npm package
ids from `package.json`, but core stores only the normalized Regesta id.

## Schema Boundary

The protocol defines the semantics of package ids, manifests, artifacts,
channels, and events. The concrete V0 object shapes are summarized in
[Schema](./schema.md).

## Channels

Channels are mutable package-level version pointers. They are not release
manifest fields.

V0 publish assigns the published version to the default `latest` channel.
Explicit channel updates or deletes are represented by append-only channel
events.

## Events

Events are append-only registry facts. Current event types:

- `release.published`;
- `channel.updated`;
- `channel.deleted`.

Event ids are deterministic SHA-256 digests over canonical event bytes with
the `id` field excluded.

Storage adapters must reject:

- invalid event ids;
- duplicate event ids;
- duplicate release versions;
- stale channel updates;
- authorization replay;
- invalid package ids, digests, timestamps, channels, and versions.

## API Boundary

The protocol defines object semantics. The HTTP API exposes those objects and
derived views. See [API](./api.md) for current routes, request shapes, caching
rules, and projection endpoints.

## Verification Boundary

V0 can verify release-level facts:

- canonical manifest digest;
- source and artifact object digests;
- event id correctness;
- release/event consistency;
- object availability and response headers;
- package state replay from public events;
- authorization proof structure.

V0 cannot yet claim:

- the source built the artifact;
- the artifact is safe;
- compatibility declarations were tested;
- independent public signature verification from event data alone;
- externally witnessed transparency checkpoints;
- inclusion or consistency proofs.
