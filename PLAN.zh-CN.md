# JSM 计划

JSM 是一个源码优先、可验证、面向现代 JavaScript 与 TypeScript 模块的包注册表。

本文档记录 JSM 的产品方向、架构、治理模型与阶段性实现计划。目标不是做一个更好看的 npm UI、一个安全 SaaS，或者另一个轻量 registry clone。目标是设计一个现代 registry kernel，让它能够成为未来十年 JavaScript 生态可信赖的公共基础设施。

## 1. 使命

JSM 的目标是让 JavaScript 包分发具备以下特性：

- 源码优先；
- 运行时中立；
- 内容寻址；
- 公开可审计；
- 可镜像；
- 可 fork；
- AI 可读；
- 治理友好；
- 在可能的情况下兼容现有 npm 工具链。

Registry 不应该只是托管包。它还应该发布关于包的可验证事实。

一个面向未来十年的包注册表应该能够回答：

- 这个 release 是由什么源码产生的？
- 从它生成了哪些 artifacts？
- 谁发布了它？
- 哪个域名或组织身份对它负责？
- 公共 registry 状态发生了什么变化？
- 有没有人能验证历史没有被重写？
- 有没有人能镜像足够多的数据，让生态继续存活？
- 工具和 AI agent 能否消费准确、结构化的包知识，而不是爬 README？

## 2. 核心论点

传统 registry 通常是一个内部数据库，对外暴露公共 API。

JSM 应该反过来成为一个公开、可验证的状态机：

```text
append-only event log
+ content-addressed objects
+ deterministic projections
+ open protocols
+ public mirrors
+ independent witnesses
```

数据库只是实现细节。公共事实来源是日志和对象。

这是最关键的架构差异。

## 3. v0 非目标

JSM v0 不应该试图替代整个 npm。

初始版本不应该支持：

- 任意 npm tarball 上传；
- 把 CommonJS authoring 作为主要包格式；
- lifecycle scripts；
- native addons；
- 任意 build scripts；
- postinstall downloads；
- 完整 npm mirror；
- 私有包托管；
- 企业 dashboard；
- 黑盒安全评分；
- P2P 分发；
- 庞大官僚式治理机构。

第一版应该证明 registry kernel，而不是模仿 npm 的所有遗留行为。

## 4. 产品定位

JSM 不是狭义安全厂商意义上的“更安全的 npm”。

它是：

```text
一个源码优先、可验证、面向现代 JavaScript 和 TypeScript 模块的 registry。
```

初始目标是高质量现代包：

- TypeScript libraries；
- ESM-first packages；
- 前端 libraries；
- SDKs；
- edge/runtime-neutral libraries；
- framework utilities；
- 受益于 provenance 和 source-native distribution 的包。

长期来看，JSM 可以演进成更广泛的 registry 和 trust infrastructure。但初始产品必须聚焦。

## 5. 命名与身份

项目名：

```text
JSM
```

建议含义：

```text
JavaScript Modules
```

建议 GitHub organization：

```text
github.com/jsm-project
```

建议项目结构：

```text
jsm-project/registry
jsm-project/cli
jsm-project/protocol
jsm-project/log
jsm-project/mirror
jsm-project/rfcs
```

避免依赖 `.io` 作为主品牌锚点。优先考虑 `.dev`、`.org`，或必要时使用更长但稳定的项目域名。

## 6. 设计原则

### 6.1 源码优先

作者发布源码，而不是不透明的构建产物。

Registry 验证源码，并生成以下 artifacts：

- npm-compatible tarballs；
- type declarations；
- documentation data；
- AI context bundles；
- package metadata projections。

source archive 是最高优先级需要保存的对象。

### 6.2 运行时中立

JSM 不是 Node、Deno、Bun、Cloudflare 或浏览器 registry。

它应该支持多种消费路径：

```text
npm-compatible protocol  -> npm / pnpm / Yarn / Bun
native JSM protocol      -> verified clients and tooling
HTTP/ESM delivery        -> browsers, Deno, edge runtimes
AI/MCP/API access        -> agents and IDEs
```

一个只使用 Bun、Node 或 Cloudflare Workers 的开发者，也应该能使用 JSM，而不会感觉自己在加入另一个 runtime 的生态。

### 6.3 内容寻址对象

所有不可变对象都通过 digest 标识：

- source archives；
- generated npm tarballs；
- release manifests；
- documentation artifacts；
- type artifacts；
- provenance attestations；
- audit bundles；
- AI context bundles。

对象身份是 digest，不是 URL。

Release manifest 应该引用：

```json
{
  "digest": "sha256:...",
  "size": 123456
}
```

而不是某个单一 canonical storage URL。

URL 只是获取 bytes 的线索。

### 6.4 追加式公共状态

每一个公共 registry 状态变化都必须表示为事件：

- publish release；
- yank release；
- deprecate release；
- mark malicious；
- restore release；
- update dist tag；
- create scope；
- verify domain；
- grant project scope；
- transfer scope；
- rotate key；
- register builder；
- change policy。

当前数据库表只是 event log 的 projection。它们不是公共事实来源。

### 6.5 可镜像与可 Fork

一个合规实现应该能够：

1. 导出公共 event log；
2. 导出 signed checkpoints；
3. 导出 object inventories；
4. 镜像公共 objects；
5. 从 log 重放 registry state；
6. 从可信 checkpoint fork。

Forkability 不是日常流程。它是治理上的兜底机制。

### 6.6 轻治理，强架构

JSM 应该避免过早官僚化，但也不能依赖对单一公司的信任。

Bootstrap 阶段应该由 maintainers 主导，快速推进，并保持透明。

架构必须确保没有单一 operator 能永久捕获生态：

- public log；
- signed checkpoints；
- independent witnesses；
- mirror protocol；
- root keys not controlled by one operator；
- replay/fork tooling；
- open implementation；
- open protocol。

## 7. 包模型

### 7.1 包坐标

JSM v0 应要求所有包都有 scope。

推荐 canonical identity：

```text
@domain/package
```

例子：

```text
@hono.dev/hono
@vuejs.org/router
@cloudflare.com/workers-types
```

Unscoped packages 不应成为 native package model 的一部分。

### 7.2 Domain Scopes

v0 应主要支持 domain scopes。

Domain scope 证明某个包与一个受域名控制的身份相关联。

验证方式：

- DNS TXT record；
- `.well-known` URL；
- 未来可选的 organization attestations。

示例 DNS record：

```text
_jsm.example.com TXT "jsm-scope=..."
```

域名验证是一种信号，而不是自动所有权转移机制。

如果一个域名过期并被其他人获得，新持有人不能自动获得现有包的发布权。

规则：

- 域名验证定期过期；
- 过期会降低信任或冻结部分操作；
- 过期不删除历史；
- 新域名持有人必须走公开 reclaim 流程；
- 已发布的 package coordinate 永不静默重新分配。

### 7.3 System Scopes

JSM 可以保留 system scopes，例如：

```text
@std/*
@types/*
@registry/*
@npm/*
```

这些只能通过明确 policy 创建。

### 7.4 Project Scopes 与 Short Scopes

Short scopes 不应该先到先得。

例子：

```text
@react/*
@vue/*
@vite/*
@hono/*
@zod/*
```

这些是稀缺的生态资源。

它们应该默认 reserved，只有当一个项目证明以下条件后才授予：

- 真实采用；
- 身份已验证；
- 用户混淆风险低；
- 没有活跃命名或商标争议；
- 可信 maintainership。

信号可以包括：

- 稳定下载量；
- public dependents；
- 现有 npm/JSR/GitHub 身份；
- verified domain；
- source provenance；
- 社区认可。

下载量本身不能自动授予 scope，因为下载量可以被操纵。

Project scopes 初期应作为 canonical domain-scoped packages 的 aliases。

示例：

```text
canonical: @hono.dev/hono
alias:     @hono/hono
```

Canonical identity 保持稳定；short scope 改善易用性。

## 8. Release 模型

Release 是不可变的。

发布 release 会创建 release manifest，并通过 digest 存储所有不可变对象。

之后 release 可以被：

- yanked；
- deprecated；
- quarantined；
- blocked；
- marked malicious；
- restored。

但 release 本身永不覆盖。

### 8.1 Release Manifest

Release manifest 是 release 的核心对象。

示例结构：

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

Manifest 应被 canonicalized，并进行内容寻址。

## 9. Transparency Log

JSM 应采用 transparency-log 模型，其灵感来自 Certificate Transparency、Go checksum database、Sigstore Rekor 和 Trillian/Tessera。

Log 是 tamper-evident，而不是物理上 tamper-proof。

它保证的是：如果 checkpoints 被见证和监控，篡改可以被检测并被证明。

### 9.1 Log Entries

公共 registry 操作变成 log entries。

例子：

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

每个事件被 canonicalized 并 hash：

```text
leafHash = sha256(canonical_event)
```

Leaf hashes 组成 Merkle tree。

Registry 定期发布 signed checkpoints：

```json
{
  "logId": "jsm-main",
  "treeSize": 1234567,
  "rootHash": "sha256:...",
  "timestamp": "2026-05-30T12:00:00Z",
  "signature": "..."
}
```

Clients 和 auditors 验证：

- inclusion proofs；
- consistency proofs；
- checkpoint signatures；
- witness signatures。

### 9.3 Witnesses

只有单一 operator 签 checkpoints 不够。

独立 witnesses 应该观察 checkpoints、验证 consistency，并 countersign。

未来可能的 witnesses：

- foundation 或 fiscal host；
- OpenJS 相关参与者；
- runtime 生态参与者；
- independent security labs；
- universities；
- cloud providers；
- community-run monitors。

Clients 最终可以要求 witness threshold，例如 `3-of-5`。

### 9.4 现有技术

JSM 不应该从零发明 Merkle log primitives。

相关项目和模型：

- Trillian；
- Trillian Tessera；
- Sigstore Rekor；
- Go checksum database；
- Certificate Transparency；
- TUF-style metadata，用于 anti-rollback protections。

JSM 应定义自己的 registry event schema，但尽可能使用经过验证的 transparency-log 概念和实现。

## 10. Object Availability

Transparency 证明哪些 bytes 是正确的。它不保证这些 bytes 仍然存在。

因此 JSM 需要 object availability strategy。

### 10.1 Object Inventory

JSM 应按 epoch 发布 object inventories。

示例：

```json
{
  "epoch": "2026-05-30",
  "objectCount": 42193,
  "totalBytes": 9812345678,
  "objectsRoot": "sha256:..."
}
```

Mirrors 可以按 epoch 同步并发布 attestations。

### 10.2 Mirror 类型

JSM 应支持多种 mirror 模式。

#### Metadata Mirror

保存：

- event log；
- checkpoints；
- release manifests；
- package indexes；
- object inventories。

成本低，应该让任何人都能轻松运行。

#### Canonical Object Mirror

保存：

- source archives；
- release manifests；
- provenance attestations；
- critical metadata。

这是最重要的 object layer。

#### Full Object Mirror

保存：

- source archives；
- generated npm tarballs；
- docs；
- types；
- AI artifacts；
- all public objects。

适合 foundations、universities、companies 和 cloud providers。

#### Hot Mirror

保存热门包或选定 scopes。

例子：

```text
--top=100000
@vuejs.org/*
@cloudflare.com/*
```

#### Rescue Mirror

灾难恢复时使用，用于从以下来源收集 objects：

- official mirrors；
- community mirrors；
- user package-manager caches；
- CI caches；
- authors；
- cold storage。

因为 objects 是 content-addressed，只要 bytes 匹配就有效。

### 10.3 长期存储

未来 storage backends 可以包括：

- S3-compatible mirrors；
- GCS；
- Azure Blob；
- Backblaze B2；
- self-hosted MinIO；
- Filecoin；
- IPFS；
- Arweave；
- Internet Archive；
- academic mirrors；
- BitTorrent-style snapshots。

这些是 availability layers，不是 trust roots。

信任来自 manifest digest 和 transparency log。

## 11. Forkability

如果 primary operator 失败、审查、删除数据或违反治理，社区必须能够 fork。

Fork 流程：

1. 选择最后可信 checkpoint；
2. 验证 witness signatures；
3. 同步到该 checkpoint 为止的 event log；
4. 验证 Merkle root；
5. 从 mirrors 和 caches 收集所需 objects；
6. 重放 event log；
7. 重建 projections；
8. 启动新的 operator；
9. 发布引用 fork point 的新 root metadata。

Fork 应以类似事件开始：

```json
{
  "type": "FORK_FROM",
  "previousLog": "jsm-main",
  "previousTreeSize": 12345678,
  "previousRootHash": "sha256:...",
  "newLogId": "jsm-community"
}
```

Forkability 需要：

- public event log；
- object mirrors；
- replay tooling；
- root keys not controlled by one company；
- open protocol；
- documented client trust-root migration。

## 12. 部署架构

JSM 应该可部署在不同基础设施提供商上。

基于 Cloudflare 的 reference deployment 可能有用，但协议不能依赖 Cloudflare-specific primitives。

### 12.1 逻辑组件

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

可能的映射：

```text
Workers          -> read APIs, lightweight publish endpoints
R2               -> content-addressed object storage
D1/Postgres      -> metadata and projections
Durable Objects  -> per-package publish coordination
Queues           -> build, docs, search, audit jobs
KV               -> hot cache only, never source of truth
Containers       -> sandboxed build/analysis workers
```

Durable Objects 对 per-package serialization 很有用，但抽象需求是 per-package transactional coordinator。

## 13. npm 兼容性

npm compatibility 对采用很重要，但 npm 的数据模型不应该定义 JSM 的内部架构。

Native JSM model：

```text
package summary
version shards
release manifest
object digests
event log
```

npm compatibility layer：

```text
generated packument
generated tarball URL
dist.integrity
semver-compatible metadata
```

npm packument 应该是 projection，而不是 source of truth。

重要限制：

现有 npm clients 不会验证 JSM transparency proofs。它们可能验证 tarball integrity，但不会验证 public log。

因此 JSM 应支持两种模式：

```text
npm-compatible mode   -> broad compatibility
verified mode         -> full manifest/log/status verification
```

未来工具：

```text
jsm install
jsm verify-lock
package-manager plugins
CI verification tools
```

## 14. 构建与发布流程

初始 publish flow：

1. CLI 读取 `jsm.json` 或兼容配置子集。
2. CLI 创建 source archive。
3. CLI 计算 source digest。
4. Source 上传到 object storage。
5. Server 验证 domain scope、package policy、exports 和 source layout。
6. Build job 生成 artifacts：
   - npm tarball；
   - package metadata；
   - docs JSON；
   - type declarations；
   - AI context bundle；
   - audit bundle。
7. 创建 release manifest 并计算 hash。
8. Package coordinator 原子提交：
   - release event；
   - release row/projection；
   - dist-tag update；
   - object inventory update；
   - npm adapter projection。
9. Release 变为 visible。

不变量：

```text
A release must not become visible until all referenced artifacts exist.
```

## 15. Security Signal Network

JSM 不应该试图亲自审计每一个包。

相反，它应该为 auditors、AI systems、安全公司和社区 monitors 提供实时、可验证的数据。

### 15.1 Audit Feed

Auditors 应能跟随：

```text
GET /v1/events?after=...
GET /v1/events/stream
log tiles / checkpoint feed
```

Feed 应快速暴露 publish events 和 release manifest references。

### 15.2 Audit Bundle

每个 release 应提供 machine-readable audit bundle：

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

第三方 auditors 可以提交 signed verdicts。

示例：

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

第三方 signals 应进入单独的 signal log。

主 registry log 记录执行动作：

```text
WARN_RELEASE
QUARANTINE_RELEASE
BLOCK_RELEASE
RESTORE_RELEASE
```

Security signal log 记录谁说了什么。

### 15.5 Release Status

可能状态：

```text
ACTIVE
AUDIT_PENDING
WARNED
QUARANTINED
BLOCKED
RESTORED
```

Blocking 意味着：

- official registry 不提供普通下载；
- verified clients 拒绝安装；
- mirrors 应尊重 blocked state；
- 内容可能仍保存在 restricted security archives。

Blocking 不会让已经被 mirror 的 bytes 从世界上消失。

### 15.6 Policy Engine

Auditors 不应该直接 block packages。

它们提交 signed evidence。JSM 应用公开 policy。

Policy 应考虑：

- severity；
- confidence；
- evidence quality；
- auditor class；
- auditor independence；
- signals 之间的相关性；
- emergency response rules。

简单多数投票不够，因为多个 auditors 可能共享同一个上游 signal 或 model。

## 16. AI-Native Registry Design

AI-native 不是加一个聊天机器人。

它意味着 registry 发布结构化、可验证的包知识，让 AI agents、IDEs、搜索系统、迁移工具和包管理器可靠消费。

原则：

```text
Do not make AI guess package facts. Let AI query package facts.
```

### 16.1 AI Context Bundle

每个 release 应生成 AI context bundle。

可能内容：

```text
ai-context.md
ai-context.chunks.json
package-intelligence.json
api-snapshot.json
examples.json
runtime-compat.json
migration-notes.json
```

Bundle 应被 content-addressed，并从 release manifest 引用。

### 16.2 Package Intelligence Manifest

示例：

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

Examples 应被版本化并可测试。

Registry 应优先使用满足以下条件的 examples：

- typecheck；
- 在声明 runtimes 中运行；
- 匹配当前 package version；
- 被 AI context bundle 引用。

这有助于 AI agents 避免生成幻觉或过期用法。

### 16.4 Intent-Based Discovery

未来 API：

```text
POST /v1/resolve/intent
```

示例 intent：

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

结果必须包含 evidence，而不只是 recommendations。

### 16.5 Agent-Safe Install Plan

未来 API：

```text
POST /v1/install-plan
```

Registry 返回：

- package choice；
- exact version；
- dependency impact；
- runtime compatibility；
- lifecycle script status；
- license impact；
- warnings；
- alternatives；
- evidence。

AI coding agents 应使用 install plans，而不是盲目安装猜出来的 packages。

### 16.6 MCP Server

JSM 最终应提供官方 MCP server 给 coding agents。

可能 tools：

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

MCP server 是 facade。核心仍然是开放 HTTP APIs 和 content-addressed artifacts。

### 16.7 Prompt Injection Defense

Package content 是不可信输入。

AI context chunks 应区分：

```text
registry-generated fact
author-provided claim
untrusted package content
third-party signed signal
AI-generated text
```

AI-generated content 必须标注，且不能静默成为 source of truth。

## 17. 治理模型

### 17.1 Bootstrap Governance

初始治理应保持轻量。

建议 policy：

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

当以下条件满足任意两个或三个时，可以开始 formal governance transition：

- 1,000 published packages；
- 100 active maintainers；
- 3 independent infrastructure sponsors；
- 1M monthly downloads；
- 被一个主要 runtime 或 package manager 集成；
- 多个 independent mirrors 持续运行；
- 多个 independent witnesses 签署 checkpoints。

### 17.3 公司孵化

JSM 可以在公司内部孵化，但公共基础设施保障必须明确。

必要承诺：

- open-source implementation；
- open protocol；
- exportable public state；
- mirror protocol；
- no sponsor veto over package policy；
- no paid search ranking for public packages；
- no unilateral control over root keys；
- path to independent governance。

## 18. Root of Trust 与 Keys

Operator 和 root-of-trust 必须分离。

建议 key hierarchy：

### Root Keys

Threshold-controlled。

用于授权：

- registry operator key；
- log public key；
- witness set；
- policy version；
- migration/fork metadata。

不能让单一公司控制 root keys。

### Operator Key

由 active operator 使用，用来签 checkpoints 和 operational metadata。

如果 operator 失败或作恶，可以由 root-key threshold 撤销。

### Witness Keys

由 independent witnesses 使用，用来 countersign observed checkpoints。

## 19. 法律与内容现实

不可变 logs 会和现实世界的删除需求冲突。

JSM 应区分：

```text
historical fact
public distribution
restricted archive
```

如果包包含 secrets、malware、personal data 或侵权材料：

- event 和 digest 应留在 log 中；
- ordinary public distribution 可以停止；
- content 可以进入 restricted archive；
- policy action 应被记录；
- clients 应尊重 release status。

Registry 不应该假装 immutability 可以消除法律义务。

## 20. Milestones

### Milestone 0: Specification Skeleton

Deliverables：

- package naming policy；
- release manifest schema；
- event schema；
- object addressing scheme；
- basic protocol draft；
- bootstrap governance draft；
- threat model；
- domain scope verification design。

### Milestone 1: Minimal Registry Kernel

目标：发布并安装一个 source-native TS/JS package。

Deliverables：

- domain scope verification；
- source upload；
- content-addressed object storage；
- release manifest；
- generated npm tarball；
- package page；
- basic docs generation；
- npm-compatible install；
- immutable releases。

### Milestone 2: Event Log and Verification

Deliverables：

- append-only event log；
- canonical event encoding；
- signed checkpoints；
- basic verify CLI；
- public event export；
- metadata mirror CLI。

示例命令：

```sh
jsm verify @example.com/foo@1.0.0
```

### Milestone 3: Native Protocol and Projections

Deliverables：

- native package API；
- version manifest API；
- object API；
- generated npm packument projection；
- version sharding；
- dist-tag projection；
- package state replay tooling。

### Milestone 4: AI Context and Package Intelligence

Deliverables：

- package intelligence manifest；
- AI context bundle；
- docs JSON；
- API export JSON；
- examples index；
- runtime metadata；
- machine-readable package page API。

### Milestone 5: Security Signal Network

Deliverables：

- real-time publish feed；
- audit bundle；
- registered auditor identity；
- signed verdict submission API；
- security signal log；
- warned/quarantined/blocked states；
- appeal/retraction events。

### Milestone 6: Mirror and Availability Layer

Deliverables：

- object inventory by epoch；
- metadata mirror；
- partial object mirror；
- mirror attestation；
- object availability dashboard；
- rescue import tooling。

### Milestone 7: Witnesses and Stronger Trust

Deliverables：

- inclusion proofs；
- consistency proofs；
- witness protocol；
- witness threshold policy；
- root metadata；
- operator key rotation；
- fork proof tooling。

### Milestone 8: Broader Ecosystem Integration

Deliverables：

- package manager plugins；
- verified install mode；
- MCP server；
- semantic search；
- install plans；
- intent resolution；
- independent mirrors；
- independent governance transition。

## 21. 风险

### 21.1 Scope Creep

架构很有野心。

第一版必须保持窄范围：

```text
domain-scoped source package
+ generated npm artifact
+ release manifest
+ event log
+ basic verification
```

其他都建立在此之上。

### 21.2 采用阻力

Domain scopes 比 npm names 门槛更高。

这是 v0 为质量和 anti-squatting 刻意选择的，但可能减慢普通作者采用。

### 21.3 治理争议

Short scopes 和 trademark claims 会变得政治化。

缓解方式：

- 默认 reserve short scopes；
- 使用 public claim process；
- 把 short scopes 作为 aliases；
- 保持 canonical identity domain-based。

### 21.4 Builder Trust

Registry-built artifacts 会把信任集中到 builder 上。

缓解方式：

- 记录 builder identity 和 image digest；
- 保存 source archive；
- 尽可能让 builds reproducible；
- 允许 independent rebuild verification；
- 最终支持 multiple builders。

### 21.5 Transparency Misunderstanding

Transparency logs 不证明一个包安全。

它们证明发生了什么，以及历史有没有被篡改。

对外表述必须清楚：

```text
Transparency gives accountability, not innocence.
```

### 21.6 Object Storage Cost

永远 full mirror 所有东西成本很高。

缓解方式：

- 优先保存 source archives 和 manifests；
- 定义 object tiers；
- 允许 partial mirrors；
- 发布 availability health；
- 使用 cold storage 保存归档数据。

### 21.7 npm Compatibility Limits

现有 npm clients 不会验证 JSM 的 transparency log。

缓解方式：

- 支持 npm-compatible mode；
- 开发 verified mode；
- 提供 lock verification tooling；
- 逐步与 package managers 集成。

## 22. 成功标准

早期成功不应该只看 package 总数。

更好的早期指标：

- source-native publish flow 端到端可用；
- npm-compatible install 可用；
- release manifest 稳定；
- event log 可导出和重放；
- metadata mirror 可独立运行；
- package page 和 docs 可用；
- AI context bundle 可生成；
- 至少一个第三方工具消费 event feed；
- 至少一个 independent mirror 存在；
- 高质量 packages 选择 JSM 作为一等发布渠道。

长期成功：

- 多个 independent witnesses；
- 多个 independent mirrors；
- package manager integrations；
- external security auditors 发布 signed signals；
- AI agents 使用 JSM package intelligence，而不是 scraping；
- formal neutral governance；
- credible forkability。

## 23. 总结

JSM 应该首先作为 registry kernel 构建。

这个 kernel 是：

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

面向用户的体验应该简单：

```sh
jsm publish
npm install @example.com/foo --registry=...
jsm verify @example.com/foo@1.0.0
```

底层架构应该足够强，让其他 registries 最终不得不回答 JSM 提出的问题：

- 你的 registry 历史能被审计吗？
- 你的 package state 能被重放吗？
- 你的 objects 能在 operator 之外存活吗？
- 如果 operator 失败，社区能 fork 吗？
- AI agents 能消费 verified package knowledge，而不是靠猜吗？

这就是构建 JSM 的理由。
