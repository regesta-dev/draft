---
layout: home

hero:
  name: Regesta
  text: Universal Package Registry Kernel
  tagline: Transparent, secure, modern, scalable, and community-driven.
  actions:
    - theme: brand
      text: Why Regesta
      link: /why-regesta
    - theme: alt
      text: Explore the protocol
      link: /protocol

features:
  - title: Transparent by default
    details: Releases, objects, channels, and events are public facts that can be independently verified.
  - title: Domain-bound identity
    details: Package ownership is anchored in domains instead of operator-owned usernames or one registry namespace.
  - title: Ecosystem-neutral core
    details: npm, PyPI, Cargo, Go, OCI, and future protocols are projections over Regesta-native data.
  - title: Scalable public infrastructure
    details: Content-addressed objects, deterministic projections, and storage adapters keep the protocol portable.
---

::: warning Project Status
Regesta is an early draft and experimental implementation, not a production
registry.
:::

## What Regesta Is

Regesta is a draft architecture for a transparent universal package registry.
It is not an attempt to clone one package manager with a different API surface.
It is a registry kernel where package identity, release state, object storage,
authorization, and auditability are shared primitives.

The core model is broader than any single ecosystem. npm, PyPI, Cargo, Go, OCI,
and future package managers should be able to consume projections over the same
Regesta-native objects.

## Core Ideas

- **Transparent:** release manifests, objects, channels, and events are
  addressable and auditable.
- **Secure:** write authority is tied to explicit trust proofs, starting from
  domain ownership.
- **Modern:** source, artifacts, metadata, and verification data are structured
  for package managers, humans, security tools, and AI agents.
- **Scalable:** immutable objects and deterministic projections are naturally
  cacheable and can be backed by different storage systems.
- **Community-driven:** the registry should not be controlled by one company,
  operator, or package ecosystem.

## Documentation Map

- [Why Regesta](./why-regesta.md) explains the philosophy and long-term goals.
- [Architecture](./architecture.md) describes the registry kernel and layer
  boundaries.
- [Roadmap](./roadmap.md) tracks the broader direction.
- [Protocol](./protocol.md), [Schema](./schema.md), and [API](./api.md) describe
  the implementation-facing model.
- [Getting Started](./getting-started.md) shows how to run the implementation.
