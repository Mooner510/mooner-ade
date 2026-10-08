# Porting the ADE framework to webai

`webai` must consume versioned `@mooner/ade-*` packages; it must not run or depend on a mooner-ade daemon. Initially prefer a single repository subtree or artifact/package release, later distribute independently versioned packages when public contracts are stable.

## Adapters webai must provide

1. `ContainerWorkspace`: file actions inside the user's assigned container; physical backing paths must not be reachable through APIs.
2. `ContainerProcesses`: execute commands as the unprivileged session user in the assigned container. The host daemon must not execute arbitrary user shell commands.
3. `ContainerGit`: read/update the user's repository in that container only.
4. `ContainerTerminal`: PTY attached exclusively to that session container, not the host.
5. `CapabilityPolicy`: an explicit deny-first policy plus revalidation at the runtime boundary; do not assume the outer core policy stops an AI agent's tool usage.
6. Identity provider / credential boundary: every user supplies their **own** allowed AI credentials, scoped to that container and never accidentally inherited from host/user `mooner-ade` sessions.
7. OS resource and network isolation: CPU, memory, storage, process and outbound network restrictions, container lifecycle, cleanup, and authenticated messaging.

## Security invariants

- Do not reuse `AllowAllPolicy`, `scope: 'root'`, host `LocalProcesses`, host `LocalTerminal`, personal SSH agent sockets, or the owner's Codex/Claude sign-in in the hosted service.
- Container isolation must remain effective if a user submits `..`, symlinks, process arguments, hostile Git repositories, shell escape sequences, and malicious agent prompts.
- Never bind a host Docker/Podman socket or host home directory into user containers.
- Native CLI flags `--dangerously-bypass-approvals-and-sandbox` and `--dangerously-skip-permissions` are local-only opt-ins; hosted policy must prohibit them independent of client-supplied fields.
- Persist event history and model/tool traces only according to the hosted product's separately defined retention and privacy policy.

## Contract test sequence

The same `AdeEngine` tests must pass using a mock `ContainerRuntime`, then container integration should verify per-user isolation, credential segregation, path traversal attempts, cancellation, resource limit enforcement and runtime destruction. **Passing an in-memory mock is not proof of multitenant isolation.**
