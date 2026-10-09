# P2 UX specification — terminal grid and optional worktrees

Implementation is now present in `apps/web` and `apps/local-server`. ADE panes now hold terminals and editor groups in one split tree (see [LOCAL_IDE.md](LOCAL_IDE.md)). Verified so far: a real PTY echoes input through the server (test), a terminal pane auto-opens and an editor pane can be added next to it in headless Chrome. Items 1–5 below are still **not** run end to end (the 2×3 grid, repeated Ctrl+D splitting, layout restore after reload, parallel worktree tasks, macOS/Windows shortcut interception). See [LOCAL_IDE.md](LOCAL_IDE.md).

## Intent

The local ADE defaults to a **single shared working tree**, including when multiple Codex and Claude sessions run in parallel. It must not create a Git worktree without an explicit owner action. Because parallel edits to a single workspace can race, show file ownership/activity and warn when sessions edit overlapping files. Provide an opt-in per-task worktree mode, not a mandatory worktree pipeline or implicit merging process.

## Terminal layout

The primary terminal view must support an iTerm-style nested split model, not a fixed array of windows. The user's habitual starting layout is **2 rows × 3 columns (6 PTY sessions)**, with independently active panes and persisted size/position metadata.

- `Ctrl+D`: split the **focused pane left/right**, with the new pane to its right. A second invocation on the relevant pane yields three side-by-side columns of equal width. Horizontal column splits grow dynamically beyond 3.
- `Ctrl+Shift+D`: split the **focused pane top/bottom**, with the new pane beneath it. Row splits also grow dynamically.
- Allow mouse drag divider resizing, equalize panes, keyboard pane focus navigation, terminal close, and layout save/restore.
- Keyboard shortcuts are captured only when the terminal has focus, and must prevent browser default behavior only in that context. Editor focus retains editor shortcuts.
- Every pane owns an independent PTY session, cwd, scrollback, input stream and resize measurement. Pane switching must not detach or terminate a running process.
- Provide **2 × 3 preset** and support creating it from nested splits. The preset must not implicitly start additional AI agents.
- Persist pane tree separately from PTY process state. A saved pane tree cannot promise a native PTY process survives ADE application restart.

## Parallel agent orchestration

Each task chooses `workspaceMode: 'shared' | 'worktree'`, default `shared`. No unrequested checkout, branch creation, stashing or automatic merge. With explicit `worktree`, the IDE creates a task-scoped Git worktree, displays its branch and working path, offers diff review, and asks before removing or integrating it. Task state and terminal sessions remain separately identifiable, including when multiple tasks target the same files.

## Definition of done (P2)

1. UI integration test: build six independent PTY panes in a 2×3 grid, type and receive output separately.
2. Shortcut E2E: repeated Ctrl+D splits the focused pane into balanced columns; Ctrl+Shift+D divides rows; editor focus unaffected.
3. Pane resize/persistence E2E: save layout, restore ratios and focus, reattach only when actual PTY is available.
4. Parallel tasks E2E: no worktree is created by default; opt-in worktree uses independent paths; no silent merges.
5. macOS and Windows real-device acceptance tests for shortcut interception and PTY behavior.
