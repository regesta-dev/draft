---
layout: home

hero:
  name: Regesta
  text: Universal Package Registry Kernel
  tagline: Transparent, secure, modern, scalable, and community-driven.
  actions:
    - theme: brand
      text: Run the local demo
      link: /getting-started
    - theme: alt
      text: Read the architecture
      link: /architecture

features:
  - title: Transparent by default
    details: Releases, objects, channels, and events are public facts that can be independently verified.
  - title: Domain-bound security
    details: V0 uses domain well-known discovery and signed write intents instead of a user account system.
  - title: Ecosystem-neutral core
    details: npm is a projection over Regesta-native data, not the internal registry model.
  - title: Container-portable
    details: The current server runs as a Node.js application in an OCI image with persistent external state.
---

## What Regesta Is

Regesta is a draft registry architecture for packages and artifacts across
ecosystems. The goal is not to clone npm with a different UI. The goal is to
build a registry kernel where package identity, release state, object storage,
authorization, and auditability are shared primitives.

V0 is intentionally narrow:

- TypeScript-first implementation.
- npm-first publish and install demo.
- SQLite plus filesystem storage for local persistence.
- OCI container deployment.
- domain-bound Ed25519 publish authorization.
- public release and event-log verification.

The core model remains broader than npm. PyPI, Cargo, Go, OCI, and future
ecosystems should become projections over the same Regesta-native objects.

## Core Ideas

- **Transparent:** release manifests, objects, channels, and events are
  addressable and auditable.
- **Secure:** write authority is tied to domain ownership in v0.
- **Modern:** the implementation is TypeScript-first and container-portable.
- **Scalable:** persistent state sits behind adapters so local storage can be
  replaced by production services later.
- **Community-driven:** the registry should not be controlled by one company,
  operator, or package ecosystem.

## Current Status

Regesta is currently a PoC/MVP. It can publish, verify, and install one
npm-compatible example package through a local or Docker-backed server.

It does not yet claim:

- trusted or reproducible builds;
- complete transparency-log checkpoints;
- inclusion or consistency proofs;
- production storage durability;
- non-npm ecosystem projections.
