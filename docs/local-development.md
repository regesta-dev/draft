# Local Development

Regesta's PoC/MVP server uses a local adapter by default:

- SQLite database at `${REGESTA_DATA_DIR}/registry.sqlite` for releases, channels, and events.
- Filesystem content-addressed object storage under `${REGESTA_DATA_DIR}/objects`.
- Append-only local queue file at `${REGESTA_DATA_DIR}/queue.ndjson`.

If `REGESTA_DATA_DIR` is not set, the server uses `.regesta-data`.

## Run Locally

```sh
pnpm dev:server
```

Health check:

```sh
curl http://localhost:4321/health
```

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

## Publish The Example

With a development-mode server running:

```sh
pnpm --filter regesta exec regesta publish examples/hello-regesta \
  --registry http://127.0.0.1:4321 \
  --auth-key apps/server/src/dev/private-key.json
```

Verify the release:

```sh
pnpm --filter regesta exec regesta verify npm:dev.localhost/hello-regesta@0.0.4 \
  --registry http://127.0.0.1:4321
```

Inspect the npm projection:

```sh
curl --resolve npm.localhost:4321:127.0.0.1 \
  http://npm.localhost:4321/@dev.localhost/hello-regesta
```
