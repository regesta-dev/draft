# Regesta V0 Implementation Plan

## Purpose

This document defines the first implementation plan for Regesta.

Regesta v0 should prove the product model and protocol shape before optimizing the runtime stack. The first version will be written in TypeScript, distributed as the `regesta` npm package for CLI access, and deployed as a Node.js-compatible service packaged in an OCI image.

The implementation must remain serverless-friendly and platform-agnostic. Cloudflare, AWS, Google Cloud, Azure, Kubernetes, and other environments may be supported through adapters, but no provider-specific primitive should become part of the core architecture.

## V0 Goals

- Publish and install one tarball-backed JavaScript or TypeScript package end to end.
- Define the minimum viable registry kernel: package identity, source attachment, required tarball artifact upload, content-addressed objects, source-attached provenance, release manifest, event schema, npm packument projection, and immutable release state.
- Provide a `regesta` CLI that can read `regesta.json`, create a source archive, create a package-manager tarball, publish a release, and verify a published release at a basic level.
- Expose npm-compatible install behavior for existing package managers.
- Generate the first package page and basic documentation output from source.
- Keep all protocol artifacts language-independent so future Rust, Go, or WASM implementations can verify the same data.

## Technical Direction

TypeScript is the primary v0 implementation language.

Reasons:

- Regesta is built for the JavaScript and TypeScript package ecosystem, so TypeScript gives the fastest path to correct handling of `package.json`, exports, semver, npm metadata, and package manager compatibility.
- The CLI can be distributed naturally through npm as `regesta`.
- A Node.js-compatible HTTP service can run in a normal OCI image across serverless containers, Kubernetes, local Docker, and hosted container platforms.
- Early product risk is in protocol correctness and workflow design, not raw CPU throughput.

The v0 runtime target is a Node.js-compatible server in an OCI image. Bun, Deno, Cloudflare Workers, and other runtimes may be evaluated later, but v0 should not depend on runtime-specific APIs.

## Architecture

Regesta v0 should be structured around portable core behavior and replaceable platform adapters.

Core behavior:

- package naming and domain-scope policy;
- source archive creation and digest calculation;
- required tarball artifact ingestion from the publish request;
- release manifest creation and validation;
- source attachment provenance recording;
- event schema definition and append-only event writing;
- object addressing and object integrity verification;
- npm packument projection;
- basic package page and docs projection;
- basic release verification.

External dependencies:

- database for registry state and projections;
- object storage for source archives, required install tarballs, manifests, and documentation artifacts;
- queue or job system for asynchronous artifact generation and projection work;
- signing or KMS service for release, checkpoint, or registry signatures.

All persistent state must live in external services. Local container disk is temporary and must not be used as durable storage.

The append-only log and object store are the public source of truth. Database tables are projections and may be rebuilt from logged events and referenced objects.

## Package and Repository Shape

The repository should use a TypeScript monorepo-style shape conceptually, even if the exact package manager is chosen later.

Expected subsystems:

- protocol/types: shared TypeScript types and JSON schema sources for public artifacts;
- core verification helpers: digest, canonicalization, manifest validation, and proof verification interfaces;
- server API: publish API, package API, npm compatibility API, and package page API;
- CLI: `regesta publish`, `regesta verify`, and related developer workflows;
- workers/jobs: artifact generation, documentation generation, projections, and mirror/export jobs;
- adapters: database, object storage, queue, signer/KMS, runtime, and hosting-provider integration.

The v0 implementation should avoid hard-coding provider SDKs into core logic. Provider-specific code belongs in adapters.

## Deployment Model

Regesta v0 is serverless-first but container-portable.

The default deployable unit is an OCI image running a Node.js-compatible HTTP service. That image should be runnable in at least:

- local Docker or compatible container runtime;
- serverless container platforms such as Cloud Run, Azure Container Apps, Cloudflare Containers, or similar environments;
- AWS Lambda container images or another adapter with equivalent HTTP/event entrypoints;
- Kubernetes or another general-purpose container orchestrator.

Cloudflare support should be treated as an adapter target, not an architectural dependency. Cloudflare Workers, Durable Objects, R2, Queues, and Containers may be useful deployment components, but the core system must not require them.

The same rule applies to AWS Lambda, Cloud Run, Azure Container Apps, Kubernetes, and any other hosting target: platform capabilities are integrated through adapters, not embedded into protocol or domain logic.

## Verification and Protocol Boundaries

V0 TypeScript code may implement the first verifier, but the protocol must be language-independent from the start.

Required public artifacts:

- release manifest;
- event schema;
- object addressing rules;
- npm packument projection;
- `regesta.json` project configuration.

The v0 `regesta.json` should stay thin. It may inherit `name`, `version`, and `exports` from `package.json`, while declaring Regesta-specific source include/exclude rules, source-attached provenance, and runtime compatibility intent. Local tarball paths are not part of `regesta.json`; the publish request uploads the package-manager-produced `.tgz` bytes directly.

Implementation rules:

- public artifacts must be encoded deterministically enough for independent implementations to verify them;
- digest, signature, event, and manifest semantics must not rely on JavaScript object iteration behavior;
- fixtures and test vectors should be created for every public artifact as the implementation appears;
- verification logic should be isolated so a later Rust/WASM verifier can be introduced without changing release data.

## Out of Scope for V0

V0 should not attempt to deliver the full long-term registry.

Out of scope:

- source-only publishing without a tarball artifact;
- arbitrary npm-only tarball uploads without source attachment;
- mandatory registry-owned builders or a forced JavaScript build toolchain;
- reproducible build enforcement;
- trusted builder attestations;
- private package hosting;
- full npm registry mirroring;
- native addons and arbitrary lifecycle scripts;
- large governance body or foundation process;
- production-grade search ranking;
- full security signal network;
- independent witness network;
- high-throughput custom log infrastructure;
- mandatory Rust, Go, or WASM backend implementation.

## Future Native/WASM Roadmap

Native and WASM work should be introduced only where it gives clear portability, security, or performance value.

Preferred path:

- keep TypeScript as the v0 product and protocol implementation;
- keep v0 tarball-backed and source-attached: source archive required, tarball bytes uploaded in the publish request, artifacts content-addressed, and the source-to-artifact relationship preserved without being verified;
- add reproducible rebuild support later for packages whose build can be replayed deterministically;
- add trusted builder attestations later through registered builders, CI provenance, or third-party verifier submissions;
- implement a Rust verifier/canonicalization core once the release manifest and event formats are stable;
- compile that Rust core to WASM for browser, CLI, edge, and third-party verification use cases;
- consider Go or Rust for throughput-bound backend workers only after profiling shows TypeScript is the bottleneck;
- keep OCI images as the primary portable deployment format for backend services.

WASM is best suited for portable verification, sandboxed policy evaluation, browser usage, and edge-adjacent components. It should not replace the v0 containerized backend service.

## Acceptance Criteria

The v0 plan is complete when:

- Regesta can publish one tarball-backed TS/JS package from `regesta.json`;
- the registry stores source, install artifacts, release manifest, and package metadata as content-addressed objects where appropriate;
- the release manifest records source-attached provenance without claiming reproducible or trusted build verification;
- npm-compatible install works through a generated packument and the uploaded tarball artifact;
- release state is immutable after publication except through explicit logged status events;
- the CLI can perform a basic release verification using public registry data;
- persistent state is externalized to database, object storage, queue, and signing/KMS services;
- the service can run from an OCI image without requiring a specific cloud provider;
- Cloudflare and other platforms are represented only through adapters;
- protocol artifacts are documented and testable enough for a future independent verifier.
