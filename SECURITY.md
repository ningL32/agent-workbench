# Security Policy / 安全策略

Super Workbench is a local-first, single-user plugin — but it does read agent session stores and makes outbound requests to configured feeds, so its security posture is part of the product contract.

## Supported versions / 支持版本

| Version | Supported |
|---|---|
| 2.9.x | ✅ |

## Reporting a vulnerability / 报告漏洞

Please use **GitHub private vulnerability reporting** on this repository (Security tab → Report a vulnerability) rather than a public issue — especially for anything involving:

- credential handling (the git-config runtime-read path, `lib/redact.js` output discipline)
- the SSRF allowlist (`lib/ssrfGuard.js`) / egress surface
- the DSH auth token or instance lock

We will respond within a week, and credit reporters in the release notes unless they prefer otherwise.

请优先使用 GitHub 的私下漏洞报告入口而不是公开 issue——尤其涉及凭据读取、SSRF 白名单、认证 token 相关的问题时。一周内响应，默认在发布说明中致谢（可要求匿名）。

## Design invariants you can rely on / 可依赖的设计红线

These are enforced by review and by `npm test` (see `AGENTS.md`):

- Zero third-party runtime dependencies — supply-chain surface is Node built-ins only.
- Credentials are read at runtime from git config into memory: never written to disk, never passed through child-process env, never logged.
- Every outbound URL passes `lib/ssrfGuard.js` (protocol allowlist, exact host allowlist, dangerous-literal rejection).
- Everything that leaves the process goes through `lib/redact.js` first.
