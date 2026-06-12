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
signing readiness. Deployments that configure checkpoint storage also report
checkpoint store readiness.

## Configure A Domain Binding

Regesta publish authority is bound to the owner domain in the package id. For a
package id such as `npm:some.dev/sdk`, the owner domain is `some.dev`, and the
registry fetches:

```text
https://some.dev/.well-known/regesta.json
```

The file must be served as JSON, and its `domain` value must match the owner
domain exactly. A new user can start with either the built-in Ed25519 key file
format or an existing `ssh-ed25519` signing key.

### Ed25519 Key File

Generate Regesta key material:

```sh
node --conditions=regesta-source packages/cli/src/index.ts keygen ./regesta-keys \
  --domain some.dev \
  --kid ed25519:release
```

Publish the generated `domain-binding.json` at:

```text
https://some.dev/.well-known/regesta.json
```

The file has this shape:

```json
{
  "object": "regesta.domain-binding",
  "domain": "some.dev",
  "keys": [
    {
      "kid": "ed25519:release",
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

Keep `private-key.json` local and private. Use it when publishing:

```sh
node --conditions=regesta-source packages/cli/src/index.ts publish . \
  --registry https://registry.regesta.dev \
  --auth-key ./regesta-keys/private-key.json
```

### SSH Signing Key

If you already sign Git commits with `ssh-ed25519`, publish the public key in
the same well-known file:

```json
{
  "object": "regesta.domain-binding",
  "domain": "some.dev",
  "keys": [
    {
      "kid": "ssh-ed25519:release",
      "use": "regesta-write",
      "alg": "ssh-ed25519",
      "publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
    }
  ]
}
```

Then publish with the matching key id, public key, and signing program:

```sh
node --conditions=regesta-source packages/cli/src/index.ts publish . \
  --registry https://registry.regesta.dev \
  --signing-format ssh \
  --kid ssh-ed25519:release \
  --ssh-signing-key "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..." \
  --ssh-signing-program /Applications/1Password.app/Contents/MacOS/op-ssh-sign
```

If `--ssh-signing-program` is omitted, the CLI uses `ssh-keygen`. If `--kid` is
omitted for SSH signing, the CLI derives one from the public key; the
well-known file must use the same derived id, so an explicit `--kid` is simpler
for first-time setup.

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

Fallback packuments and version manifests preserve upstream npm metadata,
including upstream `dist.tarball` URLs. The npm projection does not proxy
tarball bytes; direct npm projection tarball routes redirect to npmjs.org when
requested.

## Docker Smoke Test

Run the complete container demo:

```sh
pnpm smoke:docker
```

This requires an accessible Docker daemon. If Docker is not running, the smoke
script exits before building the image and reports the missing daemon
prerequisite.

The smoke test builds the OCI image, starts a development-mode container with a
persistent Docker volume, publishes the example package, restarts the
container, verifies deployment statistics, release, event-log, and
package-state data, checks the npm projection, and runs a real `npm install`.

For a local load smoke against the same server code and local SQLite/filesystem
adapters:

```sh
pnpm smoke:load
```

This publishes a few temporary npm packages and repeatedly reads root deployment
statistics, core package state, releases, events, objects, npm packuments, npm
version manifests, and npm tarball redirects plus redirected object downloads.
It is an operational smoke check, not a benchmark.

For storage and recovery boundaries, see [Operations](/operations).
