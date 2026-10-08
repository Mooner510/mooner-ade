# Environment variables

The ADE framework is a **local-only non-deploy** project. It has no production service, production runtime environment variables, database or secret files.

## Local / development reference

The local runtime inherits its invoking user's normal process environment. Codex and Claude Code use their own official CLI authentication/configuration. The framework does not require new environment variables or copy credentials into the repository. Do not commit `.env` files.

When a future consumer introduces host/deployment environment variables, that consumer must document its own environment and credential contract separately.
