# JSM Plan

JSM is a source-native, verifiable package registry for modern JavaScript and TypeScript modules.

This document captures the product direction, architecture, governance model, and staged implementation plan for JSM. The goal is not to build a prettier npm UI, a security SaaS, or another thin registry clone. The goal is to design a modern registry kernel that can serve as trustworthy public infrastructure for the next decade of JavaScript.

## 1. Mission

JSM exists to make JavaScript package distribution:

- source-native;
- runtime-neutral;
- content-addressed;
- publicly auditable;
- mirrorable;
- forkable;
- AI-readable;
- governance-aware;
- compatible with existing npm-based tooling where possible.

The registry should not merely host packages. It should publish verifiable facts about packages.

A package registry for the next decade should answer:

- What source produced this release?
- Which artifacts were generated from it?
- Who published it?
- Which domain or organization identity is responsible for it?
- What changed in public registry state?
- Can anyone verify that history was not rewritten?
- Can anyone mirror enough data to keep the ecosystem alive?
- Can tools and AI agents consume accurate, structured package knowledge instead of scraping README files?

## 2. Core Thesis

Traditional registries are usually internal databases exposed through public APIs.

JSM should instead be a public, verifiable state machine:

```text
append-only event log
+ content-addressed objects
+ deterministic projections
+ open protocols
+ public mirrors
+ independent witnesses
```

The database is an implementation detail. The public source of truth is the log plus the objects.

This is the key architectural distinction.

## 3. Non-Goals for v0

JSM v0 should not attempt to replace all of npm.

It should not initially support:

- arbitrary npm tarball uploads;
- CommonJS authoring as the primary package format;
- lifecycle scripts;
- native addons;
- arbitrary build scripts;
- postinstall downloads;
- full npm mirroring;
- private package hosting;
- enterprise dashboards;
- black-box security scoring;
- P2P distribution;
- a large bureaucratic governance body.

The first version should prove the registry kernel, not imitate every legacy behavior of npm.

## 4. Product Positioning

JSM is not a "more secure npm" in the narrow security-vendor sense.

It is:

```text
A source-native, verifiable registry for modern JavaScript and TypeScript modules.
```

The initial target is high-quality modern packages:

- TypeScript libraries;
- ESM-first packages;
- frontend libraries;
- SDKs;
- edge/runtime-neutral libraries;
- framework utilities;
- packages that benefit from provenance and source-native distribution.

Long-term, JSM may become a broader registry and trust infrastructure. But the initial product must be focused.

## 5. Naming and Identity

Project name:

```text
JSM
```

Suggested meaning:

```text
JavaScript Modules
```

Suggested GitHub organization:

```text
github.com/jsm-project
```

Suggested project structure:

```text
jsm-project/registry
jsm-project/cli
jsm-project/protocol
jsm-project/log
jsm-project/mirror
jsm-project/rfcs
```

Avoid depending on `.io` as the primary brand anchor. Prefer stable domains such as `.dev`, `.org`, or a longer project domain if necessary.

## 6. Design Principles

### 6.1 Source-Native

Authors publish source, not opaque build artifacts.

The registry validates source and generates artifacts such as:

- npm-compatible tarballs;
- type declarations;
- documentation data;
- AI context bundles;
- package metadata projections.

The source archive is the highest-priority object to preserve.

### 6.2 Runtime-Neutral

JSM is not a Node, Deno, Bun, Cloudflare, or browser registry.

It should support multiple consumption paths:

```text
npm-compatible protocol  -> npm / pnpm / Yarn / Bun
native JSM protocol      -> verified clients and tooling
HTTP/ESM delivery        -> browsers, Deno, edge runtimes
AI/MCP/API access        -> agents and IDEs
```

A developer who only uses Bun, Node, or Cloudflare Workers should still be able to use JSM without feeling like they are adopting another runtime's ecosystem.

### 6.3 Content-Addressed Objects

All immutable objects are identified by digest:

- source archives;
- generated npm tarballs;
- release manifests;
- documentation artifacts;
- type artifacts;
- provenance attestations;
- audit bundles;
- AI context bundles.

Object identity is the digest, not the URL.

A release manifest should reference:

```json
{
  "digest": "sha256:...",
  "size": 123456
}
```

not a single canonical storage URL.

URLs are only retrieval hints.

### 6.4 Append-Only Public State

Every public registry state change must be represented as an event:

- publish release;
- yank release;
- deprecate release;
- mark malicious;
- restore release;
- update dist tag;
- create scope;
- verify domain;
- grant project scope;
- transfer scope;
- rotate key;
- register builder;
- change policy.

Current database tables are projections of the event log. They are not the public source of truth.

### 6.5 Mirrorability and Forkability

A compliant implementation should be able to:

1. export the public event log;
2. export signed checkpoints;
3. export object inventories;
4. mirror public objects;
5. replay registry state from the log;
6. fork from a trusted checkpoint.

Forkability is not a daily workflow. It is a governance backstop.

### 6.6 Lightweight Governance, Strong Architecture

JSM should avoid premature bureaucracy, but it must not rely on trust in a single company.

The bootstrap phase should be maintainer-led, fast-moving, and transparent.

The architecture must ensure that no single operator can permanently capture the ecosystem:

- public log;
- signed checkpoints;
- independent witnesses;
- mirror protocol;
- root keys not controlled by one operator;
- replay/fork tooling;
- open implementation;
- open protocol.

## 7. Package Model

### 7.1 Package Coordinates

JSM v0 should require scoped packages.

Preferred canonical identity:

```text
@domain/package
```

Examples:

```text
@hono.dev/hono
@vuejs.org/router
@cloudflare.com/workers-types
```

Unscoped packages should not be part of the native package model.

### 7.2 Domain Scopes

v0 should primarily support domain scopes.

A domain scope proves that a package is associated with a domain-controlled identity.

Verification methods:

- DNS TXT record;
- `.well-known` URL;
- later, optional organization attestations.

Example DNS record:

```text
_jsm.example.com TXT "jsm-scope=..."
```

Domain verification is a signal, not an automatic ownership transfer mechanism.

If a domain expires and someone else acquires it, they must not automatically gain publishing rights over existing packages.

Rules:

- domain verification expires periodically;
- expiration lowers trust or freezes some operations;
- expiration does not delete history;
- new domain holder must go through a public reclaim process;
- already-published package coordinates are never silently reassigned.

### 7.3 System Scopes

JSM may reserve system scopes such as:

```text
@std/*
@types/*
@registry/*
@npm/*
```

These should be created only through explicit policy.

### 7.4 Project Scopes and Short Scopes

Short scopes should not be first-come-first-served.

Examples:

```text
@react/*
@vue/*
@vite/*
@hono/*
@zod/*
```

These are scarce ecosystem resources.

They should be reserved by default and granted only after a project proves:

- real adoption;
- verified identity;
- low risk of user confusion;
- no active naming or trademark dispute;
- credible maintainership.

Signals may include:

- stable download volume;
- public dependents;
- existing npm/JSR/GitHub identity;
- verified domain;
- source provenance;
- community recognition.

Downloads alone should never automatically grant a scope because downloads can be manipulated.

Project scopes should initially operate as aliases to canonical domain-scoped packages.

Example:

```text
canonical: @hono.dev/hono
alias:     @hono/hono
```

The canonical identity remains stable; the short scope improves ergonomics.

## 8. Release Model

A release is immutable.

Publishing a release creates a release manifest and stores all immutable objects by digest.

A release can later be:

- yanked;
- deprecated;
- quarantined;
- blocked;
- marked malicious;
- restored.

But the release itself is never overwritten.

### 8.1 Release Manifest

The release manifest is the central object of a release.

Example shape:

```json
{
  "schemaVersion": 1,
  "package": "@example.com/foo",
  "version": "1.2.3",
  "createdAt": "2026-05-30T00:00:00Z",
  "source": {
    "digest": "sha256:...",
    "size": 12345
  },
  "exports": {
    ".": "./mod.ts"
  },
  "dependencies": {},
  "artifacts": {
    "npm": {
      "digest": "sha256:...",
      "size": 45678
    },
    "types": {
      "digest": "sha256:...",
      "size": 1234
    },
    "docs": {
      "digest": "sha256:...",
      "size": 3456
    },
    "aiContext": {
      "digest": "sha256:...",
      "size": 7890
    }
  },
  "runtime": {
    "module": "esm",
    "typescript": true,
    "lifecycleScripts": false
  },
  "builder": {
    "name": "jsm-builder",
    "version": "0.1.0",
    "imageDigest": "sha256:..."
  }
}
```

The manifest should be canonicalized and content-addressed.

## 9. Transparency Log

JSM should use a transparency-log model inspired by Certificate Transparency, Go checksum database, Sigstore Rekor, and Trillian/Tessera.

The log is tamper-evident, not physically tamper-proof.

It guarantees that tampering is detectable and provable if checkpoints are witnessed and monitored.

### 9.1 Log Entries

Public registry operations become log entries.

Examples:

```text
PUBLISH_RELEASE
YANK_RELEASE
DEPRECATE_RELEASE
UPDATE_DIST_TAG
CREATE_SCOPE
VERIFY_DOMAIN_SCOPE
EXPIRE_DOMAIN_VERIFICATION
REQUEST_PROJECT_SCOPE
GRANT_PROJECT_SCOPE
CREATE_SCOPE_ALIAS
MARK_MALICIOUS
QUARANTINE_RELEASE
BLOCK_RELEASE
RESTORE_RELEASE
REGISTER_BUILDER
ROTATE_KEY
CHANGE_POLICY
```

### 9.2 Merkle Tree

Each event is canonicalized and hashed:

```text
leafHash = sha256(canonical_event)
```

Leaf hashes form a Merkle tree.

The registry periodically publishes signed checkpoints:

```json
{
  "logId": "jsm-main",
  "treeSize": 1234567,
  "rootHash": "sha256:...",
  "timestamp": "2026-05-30T12:00:00Z",
  "signature": "..."
}
```

Clients and auditors verify:

- inclusion proofs;
- consistency proofs;
- checkpoint signatures;
- witness signatures.

### 9.3 Witnesses

A single operator signing checkpoints is insufficient.

Independent witnesses should observe checkpoints, verify consistency, and countersign.

Possible future witnesses:

- foundation or fiscal host;
- OpenJS-related participant;
- runtime ecosystem participants;
- independent security labs;
- universities;
- cloud providers;
- community-run monitors.

Clients may eventually require a witness threshold such as `3-of-5`.

### 9.4 Existing Technology

JSM should not invent Merkle log primitives from scratch.

Relevant projects and models:

- Trillian;
- Trillian Tessera;
- Sigstore Rekor;
- Go checksum database;
- Certificate Transparency;
- TUF-style metadata for anti-rollback protections.

JSM should define its own registry event schema, but use proven transparency-log concepts and implementations where appropriate.

## 10. Object Availability

Transparency proves what the correct bytes are. It does not guarantee the bytes still exist.

Therefore JSM needs an object availability strategy.

### 10.1 Object Inventory

JSM should publish object inventories by epoch.

Example:

```json
{
  "epoch": "2026-05-30",
  "objectCount": 42193,
  "totalBytes": 9812345678,
  "objectsRoot": "sha256:..."
}
```

Mirrors can sync by epoch and publish attestations.

### 10.2 Mirror Types

JSM should support several mirror modes.

#### Metadata Mirror

Stores:

- event log;
- checkpoints;
- release manifests;
- package indexes;
- object inventories.

This is cheap and should be easy for anyone to run.

#### Canonical Object Mirror

Stores:

- source archives;
- release manifests;
- provenance attestations;
- critical metadata.

This is the most important object layer.

#### Full Object Mirror

Stores:

- source archives;
- generated npm tarballs;
- docs;
- types;
- AI artifacts;
- all public objects.

Suitable for foundations, universities, companies, and cloud providers.

#### Hot Mirror

Stores popular packages or selected scopes.

Examples:

```text
--top=100000
@vuejs.org/*
@cloudflare.com/*
```

#### Rescue Mirror

Used during disaster recovery to collect objects from:

- official mirrors;
- community mirrors;
- user package-manager caches;
- CI caches;
- authors;
- cold storage.

Since objects are content-addressed, any matching bytes are valid.

### 10.3 Long-Term Storage

Future storage backends may include:

- S3-compatible mirrors;
- GCS;
- Azure Blob;
- Backblaze B2;
- self-hosted MinIO;
- Filecoin;
- IPFS;
- Arweave;
- Internet Archive;
- academic mirrors;
- BitTorrent-style snapshots.

These are availability layers, not trust roots.

Trust comes from the manifest digest and transparency log.

## 11. Forkability

If the primary operator fails, censors, deletes data, or violates governance, the community must be able to fork.

Fork process:

1. choose the last trusted checkpoint;
2. verify witness signatures;
3. sync the event log up to that checkpoint;
4. verify the Merkle root;
5. collect required objects from mirrors and caches;
6. replay the event log;
7. rebuild projections;
8. launch a new operator;
9. publish new root metadata referencing the fork point.

The fork should begin with an event such as:

```json
{
  "type": "FORK_FROM",
  "previousLog": "jsm-main",
  "previousTreeSize": 12345678,
  "previousRootHash": "sha256:...",
  "newLogId": "jsm-community"
}
```

Forkability requires:

- public event log;
- object mirrors;
- replay tooling;
- root keys not controlled by one company;
- open protocol;
- documented client trust-root migration.

## 12. Deployment Architecture

JSM should be deployable on different infrastructure providers.

A Cloudflare-based reference deployment may be useful, but the protocol must not depend on Cloudflare-specific primitives.

### 12.1 Logical Components

```text
Read Plane
  native API
  npm compatibility API
  docs API
  AI context API
  object serving

Write Plane
  auth
  publish API
  package coordinator
  validation
  build queue
  event commit

Object Store
  content-addressed immutable objects

Metadata Store
  accounts, scopes, projections, permissions

Transparency Log
  append-only event log, checkpoints, proofs

Build Workers
  source validation, docs, types, npm artifacts, AI bundles

Search and Intelligence
  package search, docs search, semantic indexes

Security Signal Network
  external auditor verdicts, policy actions
```

### 12.2 Cloudflare Reference Mapping

Possible mapping:

```text
Workers          -> read APIs, lightweight publish endpoints
R2               -> content-addressed object storage
D1/Postgres      -> metadata and projections
Durable Objects  -> per-package publish coordination
Queues           -> build, docs, search, audit jobs
KV               -> hot cache only, never source of truth
Containers       -> sandboxed build/analysis workers
```

Durable Objects are useful for per-package serialization, but the abstract requirement is a per-package transactional coordinator.

## 13. npm Compatibility

npm compatibility is necessary for adoption, but npm's data model should not define JSM's internal architecture.

Native JSM model:

```text
package summary
version shards
release manifest
object digests
event log
```

npm compatibility layer:

```text
generated packument
generated tarball URL
dist.integrity
semver-compatible metadata
```

The npm packument should be a projection, not source of truth.

Important limitation:

Existing npm clients will not verify JSM transparency proofs. They may verify tarball integrity but not the public log.

Therefore JSM should support two modes:

```text
npm-compatible mode   -> broad compatibility
verified mode         -> full manifest/log/status verification
```

Future tools:

```text
jsm install
jsm verify-lock
package-manager plugins
CI verification tools
```

## 14. Build and Publishing Flow

Initial publish flow:

1. CLI reads `jsm.json` or a compatible config subset.
2. CLI creates source archive.
3. CLI computes source digest.
4. Source is uploaded to object storage.
5. Server validates domain scope, package policy, exports, and source layout.
6. Build job generates artifacts:
   - npm tarball;
   - package metadata;
   - docs JSON;
   - type declarations;
   - AI context bundle;
   - audit bundle.
7. Release manifest is created and hashed.
8. Package coordinator commits atomically:
   - release event;
   - release row/projection;
   - dist-tag update;
   - object inventory update;
   - npm adapter projection.
9. Release becomes visible.

Invariant:

```text
A release must not become visible until all referenced artifacts exist.
```

## 15. Security Signal Network

JSM should not attempt to personally audit every package.

Instead, it should provide real-time, verifiable data for auditors, AI systems, security companies, and community monitors.

### 15.1 Audit Feed

Auditors should be able to follow:

```text
GET /v1/events?after=...
GET /v1/events/stream
log tiles / checkpoint feed
```

The feed should expose publish events and release manifest references quickly.

### 15.2 Audit Bundle

Each release should provide a machine-readable audit bundle:

```json
{
  "package": "@example.com/foo",
  "version": "1.2.3",
  "manifestDigest": "sha256:...",
  "source": {
    "digest": "sha256:..."
  },
  "artifacts": {
    "npmTarball": "sha256:..."
  },
  "previousRelease": {
    "version": "1.2.2",
    "manifestDigest": "sha256:..."
  },
  "provenance": {},
  "dependencies": {},
  "exports": {},
  "capabilities": {
    "lifecycleScripts": false
  },
  "generated": {
    "sbom": "sha256:...",
    "fileIndex": "sha256:..."
  }
}
```

### 15.3 Signed Security Verdicts

Third-party auditors can submit signed verdicts.

Example:

```json
{
  "schema": "jsm.security.verdict.v1",
  "auditor": "socket.dev",
  "auditorKeyId": "socket-2026-01",
  "release": {
    "package": "@example.com/foo",
    "version": "1.2.3",
    "manifestDigest": "sha256:..."
  },
  "verdict": "malicious",
  "severity": "critical",
  "confidence": 0.97,
  "categories": [
    "credential-exfiltration",
    "suspicious-network"
  ],
  "recommendedAction": "block",
  "toolchain": {
    "scanner": "example-ai-auditor",
    "version": "3.4.1",
    "model": "security-model-2026-05"
  },
  "createdAt": "2026-05-30T12:34:56Z",
  "signature": "..."
}
```

### 15.4 Security Signal Log

Third-party signals should live in a separate signal log.

The main registry log records execution actions:

```text
WARN_RELEASE
QUARANTINE_RELEASE
BLOCK_RELEASE
RESTORE_RELEASE
```

The security signal log records who said what.

### 15.5 Release Status

Possible states:

```text
ACTIVE
AUDIT_PENDING
WARNED
QUARANTINED
BLOCKED
RESTORED
```

Blocking means:

- official registry does not serve normal downloads;
- verified clients refuse installation;
- mirrors should respect blocked state;
- content may remain available in restricted security archives.

Blocking does not make already-mirrored bytes disappear.

### 15.6 Policy Engine

Auditors should not directly block packages.

They submit signed evidence. JSM applies public policy.

Policy should consider:

- severity;
- confidence;
- evidence quality;
- auditor class;
- auditor independence;
- correlation between signals;
- emergency response rules.

Simple majority voting is insufficient because multiple auditors may share the same upstream signal or model.

## 16. AI-Native Registry Design

AI-native does not mean adding a chatbot.

It means the registry publishes structured, verifiable package knowledge that AI agents, IDEs, search systems, migration tools, and package managers can reliably consume.

Principle:

```text
Do not make AI guess package facts. Let AI query package facts.
```

### 16.1 AI Context Bundle

Each release should generate an AI context bundle.

Possible contents:

```text
ai-context.md
ai-context.chunks.json
package-intelligence.json
api-snapshot.json
examples.json
runtime-compat.json
migration-notes.json
```

The bundle should be content-addressed and referenced from the release manifest.

### 16.2 Package Intelligence Manifest

Example:

```json
{
  "schema": "jsm.package-intelligence.v1",
  "package": "@example.com/router",
  "version": "1.2.3",
  "summary": {
    "oneLine": "A small URL router for Web Standard Request objects.",
    "categories": ["routing", "http", "web-standards"]
  },
  "runtimes": {
    "node": "supported",
    "bun": "supported",
    "deno": "supported",
    "cloudflareWorkers": "supported",
    "browser": "partial"
  },
  "exports": [
    {
      "name": "Router",
      "kind": "class",
      "signature": "class Router<TContext = unknown>",
      "stability": "stable"
    }
  ],
  "capabilities": {
    "filesystem": false,
    "network": false,
    "environment": false,
    "lifecycleScripts": false
  },
  "examples": [
    {
      "id": "basic-routing",
      "verified": true,
      "runtime": "node"
    }
  ],
  "commonMistakes": []
}
```

### 16.3 Verified Examples

Examples should be versioned and testable.

The registry should prefer examples that:

- typecheck;
- run in declared runtimes;
- match the current package version;
- are referenced by the AI context bundle.

This helps AI agents avoid hallucinated or outdated usage.

### 16.4 Intent-Based Discovery

Future API:

```text
POST /v1/resolve/intent
```

Example intent:

```json
{
  "task": "parse YAML in a Cloudflare Worker",
  "constraints": {
    "runtime": "cloudflare-workers",
    "typescript": true,
    "noLifecycleScripts": true
  }
}
```

Results must include evidence, not just recommendations.

### 16.5 Agent-Safe Install Plan

Future API:

```text
POST /v1/install-plan
```

The registry returns:

- package choice;
- exact version;
- dependency impact;
- runtime compatibility;
- lifecycle script status;
- license impact;
- warnings;
- alternatives;
- evidence.

AI coding agents should use install plans instead of blindly installing guessed packages.

### 16.6 MCP Server

JSM should eventually provide an official MCP server for coding agents.

Possible tools:

```text
search_packages
get_package_context
get_release_manifest
get_verified_examples
get_install_plan
check_runtime_compatibility
get_migration_recipe
verify_package_status
```

The MCP server is a facade. The core remains open HTTP APIs and content-addressed artifacts.

### 16.7 Prompt Injection Defense

Package content is untrusted input.

AI context chunks should distinguish:

```text
registry-generated fact
author-provided claim
untrusted package content
third-party signed signal
AI-generated text
```

AI-generated content must be labeled as such and should never silently become the source of truth.

## 17. Governance Model

### 17.1 Bootstrap Governance

Initial governance should be lightweight.

Suggested policy:

```text
During bootstrap, JSM is maintainer-led.
Maintainers may make product and technical decisions quickly.
All policy decisions must be public.
All major protocol changes require an RFC.
Security or abuse actions may be taken immediately but must be documented.
Sponsors do not receive veto power.
The project will transition to more formal neutral governance after adoption milestones.
```

### 17.2 Transition Triggers

Formal governance transition may begin when any two or three occur:

- 1,000 published packages;
- 100 active maintainers;
- 3 independent infrastructure sponsors;
- 1M monthly downloads;
- integration by one major runtime or package manager;
- multiple independent mirrors operating continuously;
- multiple independent witnesses signing checkpoints.

### 17.3 Company Incubation

JSM may be incubated inside a company, but public infrastructure guarantees must be explicit.

Required commitments:

- open-source implementation;
- open protocol;
- exportable public state;
- mirror protocol;
- no sponsor veto over package policy;
- no paid search ranking for public packages;
- no unilateral control over root keys;
- path to independent governance.

## 18. Root of Trust and Keys

Operator and root-of-trust must be separate.

Suggested key hierarchy:

### Root Keys

Threshold-controlled.

Used to authorize:

- registry operator key;
- log public key;
- witness set;
- policy version;
- migration/fork metadata.

No single company should control the root keys.

### Operator Key

Used by the active operator to sign checkpoints and operational metadata.

Can be revoked by root-key threshold if the operator fails or acts maliciously.

### Witness Keys

Used by independent witnesses to countersign observed checkpoints.

## 19. Legal and Content Realities

Immutable logs conflict with real-world deletion requirements.

JSM should distinguish:

```text
historical fact
public distribution
restricted archive
```

If a package contains secrets, malware, personal data, or infringing material:

- the event and digest should remain in the log;
- ordinary public distribution may stop;
- content may move to restricted archive;
- policy action should be logged;
- clients should respect release status.

The registry should not pretend that immutability removes legal obligations.

## 20. Milestones

### Milestone 0: Specification Skeleton

Deliverables:

- package naming policy;
- release manifest schema;
- event schema;
- object addressing scheme;
- basic protocol draft;
- bootstrap governance draft;
- threat model;
- domain scope verification design.

### Milestone 1: Minimal Registry Kernel

Goal: publish and install one source-native TS/JS package.

Deliverables:

- domain scope verification;
- source upload;
- content-addressed object storage;
- release manifest;
- generated npm tarball;
- package page;
- basic docs generation;
- npm-compatible install;
- immutable releases.

### Milestone 2: Event Log and Verification

Deliverables:

- append-only event log;
- canonical event encoding;
- signed checkpoints;
- basic verify CLI;
- public event export;
- metadata mirror CLI.

Example command:

```sh
jsm verify @example.com/foo@1.0.0
```

### Milestone 3: Native Protocol and Projections

Deliverables:

- native package API;
- version manifest API;
- object API;
- generated npm packument projection;
- version sharding;
- dist-tag projection;
- package state replay tooling.

### Milestone 4: AI Context and Package Intelligence

Deliverables:

- package intelligence manifest;
- AI context bundle;
- docs JSON;
- API export JSON;
- examples index;
- runtime metadata;
- machine-readable package page API.

### Milestone 5: Security Signal Network

Deliverables:

- real-time publish feed;
- audit bundle;
- registered auditor identity;
- signed verdict submission API;
- security signal log;
- warned/quarantined/blocked states;
- appeal/retraction events.

### Milestone 6: Mirror and Availability Layer

Deliverables:

- object inventory by epoch;
- metadata mirror;
- partial object mirror;
- mirror attestation;
- object availability dashboard;
- rescue import tooling.

### Milestone 7: Witnesses and Stronger Trust

Deliverables:

- inclusion proofs;
- consistency proofs;
- witness protocol;
- witness threshold policy;
- root metadata;
- operator key rotation;
- fork proof tooling.

### Milestone 8: Broader Ecosystem Integration

Deliverables:

- package manager plugins;
- verified install mode;
- MCP server;
- semantic search;
- install plans;
- intent resolution;
- independent mirrors;
- independent governance transition.

## 21. Risks

### 21.1 Scope Creep

The architecture is ambitious.

The first version must stay narrow:

```text
domain-scoped source package
+ generated npm artifact
+ release manifest
+ event log
+ basic verification
```

Everything else builds on that.

### 21.2 Adoption Friction

Domain scopes are higher-friction than npm names.

This is intentional for v0 quality and anti-squatting, but it may slow adoption among casual package authors.

### 21.3 Governance Disputes

Short scopes and trademark claims will be political.

Mitigation:

- reserve short scopes by default;
- use public claim process;
- treat short scopes as aliases;
- keep canonical identity domain-based.

### 21.4 Builder Trust

Registry-built artifacts centralize trust in the builder.

Mitigation:

- record builder identity and image digest;
- preserve source archive;
- make builds reproducible where possible;
- allow independent rebuild verification;
- eventually support multiple builders.

### 21.5 Transparency Misunderstanding

Transparency logs do not prove a package is safe.

They prove what happened and whether history was changed.

Messaging must be clear:

```text
Transparency gives accountability, not innocence.
```

### 21.6 Object Storage Cost

Full mirroring everything forever is expensive.

Mitigation:

- prioritize source archives and manifests;
- define object tiers;
- allow partial mirrors;
- publish availability health;
- use cold storage for archival data.

### 21.7 npm Compatibility Limits

Existing npm clients will not verify JSM's transparency log.

Mitigation:

- support npm-compatible mode;
- develop verified mode;
- provide lock verification tooling;
- integrate with package managers over time.

## 22. Success Criteria

Early success should not be measured by total package count alone.

Better early metrics:

- source-native publish flow works end-to-end;
- npm-compatible install works;
- release manifest is stable;
- event log can be exported and replayed;
- metadata mirror can run independently;
- package page and docs work;
- AI context bundle is generated;
- at least one third-party tool consumes the event feed;
- at least one independent mirror exists;
- high-quality packages choose JSM for first-class publishing.

Long-term success:

- multiple independent witnesses;
- multiple independent mirrors;
- package manager integrations;
- external security auditors publishing signed signals;
- AI agents using JSM package intelligence instead of scraping;
- formal neutral governance;
- credible forkability.

## 23. Summary

JSM should be built as a registry kernel first.

The kernel is:

```text
source-native publishing
content-addressed objects
release manifests
append-only public event log
signed checkpoints
mirror/replay/fork protocols
domain-based identity
machine-readable package intelligence
```

The user-facing experience should be simple:

```sh
jsm publish
npm install @example.com/foo --registry=...
jsm verify @example.com/foo@1.0.0
```

The underlying architecture should be strong enough that other registries will eventually have to answer the questions JSM raises:

- Can your registry history be audited?
- Can your package state be replayed?
- Can your objects survive your operator?
- Can your community fork if the operator fails?
- Can AI agents consume verified package knowledge instead of guessing?

That is the reason to build JSM.
