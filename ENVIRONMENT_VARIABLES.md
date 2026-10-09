# Environment variables

The ADE framework is a **local-only non-deploy** project. It has no production service, production runtime environment variables, database or secret files.

## Local / development reference

The local runtime inherits its invoking user's normal process environment. Codex and Claude Code use their own official CLI authentication/configuration. The framework does not require new environment variables or copy credentials into the repository. Do not commit `.env` files.

When a future consumer introduces host/deployment environment variables, that consumer must document its own environment and credential contract separately.

## mooner-ade local server

| Variable | Default | Meaning |
|---|---|---|
| `ADE_PORT` | random free port | Port on `127.0.0.1` |
| `ADE_DATA_DIR` | OS app-data dir (`~/Library/Application Support/mooner-ade` on macOS) | Projects, runs, UI state and the access `token` file (0600, reused across restarts) |
| `ADE_LIVE_TEST` | unset | Set to `1` to allow `pnpm test:live` to make real model calls |
| `CHROME_PATH` | auto-detected | Chrome binary for `pnpm e2e` |
