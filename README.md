# Regesta Draft

Regesta is a draft for a modern package registry built around transparency, security, high performance, scalability, and ecosystem neutrality.

The goal is not to create another npm-compatible database with a different UI. Regesta treats package distribution as public infrastructure: releases, source archives, artifacts, ownership, and registry state changes should be verifiable facts that independent clients, mirrors, auditors, and package managers can inspect.

Core principles:

- Transparency: public registry state should be derived from append-only events, not hidden mutable database rows.
- Security: package identity should be tied to domain-controlled ownership and verifiable authorization.
- Verifiability: source archives, install artifacts, manifests, and events should be content-addressed and independently checkable.
- Neutrality: npm, PyPI, Cargo, Go, OCI, and future ecosystems should be projections over a shared registry model, not separate trust silos.
- Performance: immutable objects, deterministic metadata, and cache-friendly projections should make hot read paths fast.
- Scalability: registry state should be replayable, shardable, mirrorable, and horizontally scalable without central database bottlenecks becoming the protocol.
- Honesty: provenance claims should say exactly what is known; v0 is source-attached, not trusted-builder verified.
- Community: the registry should be community-driven and not controlled by any single company or operator.
- Resilience: public objects and logs should be mirrorable, replayable, and forkable from trusted checkpoints.
- Modernity: package metadata should be structured, deterministic, and useful to package managers, auditors, IDEs, and AI agents.

How Regesta aims to achieve this:

- Use a canonical package identity format across ecosystems: `ecosystem:domain/name`.
- Store immutable release facts as content-addressed objects.
- Represent registry mutations as append-only events.
- Derive ecosystem-native package manager APIs as projections.
- Design governance and protocol guarantees so the ecosystem can outlive any one organization.
- Keep read-heavy package manager endpoints cacheable and derivable from stable objects.
- Separate the registry protocol from storage, queue, compute, and hosting adapters so deployments can scale independently.
- Keep package-manager-specific dependency and resolution semantics outside the core manifest.
- Let publish clients infer canonical ids from native manifests while keeping registry identity stable.
- Make verification possible from public objects and log data, not only from registry-operated APIs.

Documentation:

- [Overview](docs/index.md)
- [Why Regesta](docs/why-regesta.md)
- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Schema](docs/schema.md)
- [API](docs/api.md)
- [Roadmap](docs/roadmap.md)

Run the VitePress docs locally:

```sh
pnpm docs:dev
```

Run the registry demo with Docker Compose:

```sh
docker compose up -d --build
curl http://127.0.0.1:4321/ready
```

The Compose setup stores SQLite metadata and object bytes in the
`regesta-data` volume. Override `REGESTA_PORT` to bind a different host port.
Runtime configuration variables documented in [Operations](docs/operations.md)
can also be passed through Compose, including the npm projection, npm artifact
processing, and npm upstream fallback switches.
