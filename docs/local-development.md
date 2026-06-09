# Local Development

Regesta's PoC/MVP server uses a local adapter by default:

- SQLite database at `${REGESTA_DATA_DIR}/registry.sqlite` for releases, channels, and events.
- Filesystem content-addressed object storage under `${REGESTA_DATA_DIR}/objects`.
- Append-only local queue file at `${REGESTA_DATA_DIR}/queue.ndjson`.

If `REGESTA_DATA_DIR` is not set, the server uses `.regesta-data`.

Optional publish upload guards:

- `REGESTA_MAX_REQUEST_BYTES` limits any HTTP request that includes a
  `Content-Length` header before route handlers parse the body.
- `REGESTA_MAX_PUBLISH_SOURCE_BYTES` limits the uploaded source archive size.
- `REGESTA_MAX_PUBLISH_ARTIFACT_BYTES` limits each uploaded artifact size.

Unset or empty values leave the corresponding limit disabled. These are
operator safeguards for local and container deployments; they do not change the
Regesta object model or publish protocol.

## Run Locally

```sh
pnpm dev:server
```

Health check:

```sh
curl http://localhost:4321/health
curl -I http://localhost:4321/health
curl http://localhost:4321/ready
curl -I http://localhost:4321/ready
```

`/health` only confirms that the HTTP process is serving requests. `/ready`
checks the local infrastructure adapters: the SQLite database, filesystem object
storage, the file-backed derived queue, and the signer/KMS adapter. The
readiness response is self-classifying with `kind: "regesta.readiness"` so logs
and monitors can identify it without treating it as package protocol state.

## Run With Docker

Build the image:

```sh
docker build -t regesta-draft .
```

Run the production-shaped container with persistent local data:

```sh
docker run --rm \
  --name regesta-draft \
  -p 4321:4321 \
  -v regesta-draft-data:/data \
  regesta-draft
```

For local signed publish demos, enable the fixed `dev.localhost` binding:

```sh
docker run --rm \
  --name regesta-draft \
  -e NODE_ENV=development \
  -p 4321:4321 \
  -v regesta-draft-data:/data \
  regesta-draft
```

The development binding is public demo key material. It must not be used for production packages.

Or use Docker Compose for the same development-mode environment:

```sh
docker compose up --build
```

Run the full Docker smoke check:

```sh
pnpm smoke:docker
```

The smoke check builds the OCI image, starts a development-mode container with a
persistent Docker volume, publishes the example package with the real CLI,
restarts the container, verifies the release and public event log with the CLI,
and checks the npm projection with a real npm install.

## Publish The Example

With a development-mode server running:

```sh
node --conditions=regesta-source packages/cli/src/index.ts publish examples/hello-regesta \
  --registry http://127.0.0.1:4321 \
  --auth-key apps/server/src/dev/private-key.json
```

Verify the release:

```sh
node --conditions=regesta-source packages/cli/src/index.ts verify npm:dev.localhost/hello-regesta@0.0.5 \
  --registry http://127.0.0.1:4321
```

The CLI verifier fetches the public release, event, and object APIs and verifies
the release locally. It does not rely on the server-side verification summary
endpoint as the source of truth.

Verify the public event log replay path:

```sh
node --conditions=regesta-source packages/cli/src/index.ts verify-log \
  --registry http://127.0.0.1:4321
```

Inspect the npm projection:

```sh
curl --resolve npm.localhost:4321:127.0.0.1 \
  http://npm.localhost:4321/@dev.localhost/hello-regesta
```

Install through the npm-compatible projection:

```sh
npm install \
  --registry http://npm.localhost:4321 \
  --replace-registry-host=never \
  @dev.localhost/hello-regesta@0.0.5
```

`--replace-registry-host=never` is important while using upstream fallback
without tarball proxying. It prevents npm from rewriting upstream npmjs.org
tarball URLs back through the Regesta npm projection.
