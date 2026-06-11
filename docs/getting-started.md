# Getting Started

This guide runs the current V0 demo. It proves the local npm-first path without
claiming production readiness.

## Public Demo

The hosted experimental demo is available at:

- [https://registry.regesta.dev/](https://registry.regesta.dev/) for core
  Regesta API reads and signed publish requests.
- [https://npm.regesta.dev/](https://npm.regesta.dev/) for npm-compatible
  package manager reads.

The hosted demo is not a production registry and may be reset.

## Requirements

- Node.js 24 or newer.
- pnpm through Corepack.
- Docker, only for the container smoke test.

Install dependencies:

```sh
pnpm install
```

## Start The Server

Run the development server:

```sh
pnpm dev:server
```

The default server listens on `http://localhost:4321`.

Health and readiness:

```sh
curl http://localhost:4321/health
curl http://localhost:4321/ready
```

`/health` only checks that HTTP is responding. `/ready` checks the local
adapters: SQLite, filesystem object storage, derived queue storage, and local
signing readiness.

## Publish The Example Package

The development server exposes a fixed `dev.localhost` binding for local
testing. The key material is checked in for the demo only and must not be used
for production packages.

```sh
node --conditions=regesta-source packages/cli/src/index.ts publish examples/hello-regesta \
  --registry http://127.0.0.1:4321 \
  --auth-key apps/server/src/dev/private-key.json
```

## Verify The Release

Verify the public release data:

```sh
node --conditions=regesta-source packages/cli/src/index.ts verify \
  npm:dev.localhost/hello-regesta@0.0.5 \
  --registry http://127.0.0.1:4321
```

Verify the public event log replay path:

```sh
node --conditions=regesta-source packages/cli/src/index.ts verify-log \
  --registry http://127.0.0.1:4321
```

Verify that mutable package state matches public event-log replay:

```sh
node --conditions=regesta-source packages/cli/src/index.ts verify-package \
  npm:dev.localhost/hello-regesta \
  --registry http://127.0.0.1:4321
```

The verifier reads public APIs and checks release, event, object, event-log,
and package-state integrity. It does not treat the convenience server endpoint
as the source of truth.

## Inspect The npm Projection

The npm-compatible projection is mounted on npm subdomains:

```sh
curl --resolve npm.localhost:4321:127.0.0.1 \
  http://npm.localhost:4321/@dev.localhost/hello-regesta
```

Install through npm:

```sh
npm install \
  --registry http://npm.localhost:4321 \
  @dev.localhost/hello-regesta@0.0.5
```

The npm projection supports gradual migration: packages published to Regesta
are served from Regesta, while missing packages can fall back to
`registry.npmjs.org`. The same fallback policy can also be handled by a
client/package manager instead of the server projection.

Fallback packuments and version manifests expose tarball URLs on the npm
projection host, such as
`https://npm.regesta.dev/tinyexec/-/tinyexec-0.0.1.tgz`. Those URLs redirect to
upstream npmjs.org tarballs; the npm projection does not proxy tarball bytes.

## Docker Smoke Test

Run the complete container demo:

```sh
pnpm smoke:docker
```

The smoke test builds the OCI image, starts a development-mode container with a
persistent Docker volume, publishes the example package, restarts the
container, verifies release, event-log, and package-state data, checks the npm
projection, and runs a real `npm install`.

For a local load smoke against the same server code and local SQLite/filesystem
adapters:

```sh
pnpm smoke:load
```

This publishes a few temporary npm packages and repeatedly reads core package
state, releases, events, objects, npm packuments, npm version manifests, and npm
tarball redirects plus redirected object downloads. It is an operational smoke
check, not a benchmark.

For storage and recovery boundaries, see [Operations](/operations).
