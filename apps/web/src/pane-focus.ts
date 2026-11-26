// Moving the keyboard into a pane. Terminals and chats take the focus themselves when they become the focused pane, but editors, diffs,
// launchers and plugin consoles do not, and a pane whose node moved (a maximize that ended) loses the DOM focus without its state changing.
// So a key that moves the focus (Alt+Shift+]/[, pane numbers, the chat key, the next-attention key) also calls this after the render.

// What to focus inside each kind of pane, first match wins: the chat's message box, the terminal, the editor's text, then any control.
// An editor group whose diff is still loading has no editor yet: its open file's tab (the strip's one Tab stop, where ←/→ and Delete work),
// never a control taken out of the Tab order such as a tab's close button (Enter there would close a file).
const TARGETS = ['.chat-composer textarea[aria-label="메시지 입력"]', '.xterm-helper-textarea', '.monaco-editor textarea', '.launchers button', 'input:not([type=hidden]), textarea',
  '[role=tab][aria-selected=true]', 'button:not(:disabled):not([tabindex="-1"]), [href], [tabindex]:not([tabindex="-1"])'];

export function paneHost(id: string): HTMLElement | null {
  return typeof document === 'undefined' || !id ? null : document.querySelector<HTMLElement>(`.pane-content[data-pane-id="${CSS.escape(id)}"]`);
}

// Next frame: the pane may only now be mounted (another tab, a maximize that ended). `force` focuses it even when the focus already sits
// inside it (a click on its header), which keeps typing going to its input.
export function focusPane(id: string, { force = false } = {}) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const host = paneHost(id); if (!host || host.closest('[hidden]')) return;
    const active = document.activeElement;
    if (!force && active && host.contains(active) && active !== host) return;
    for (const selector of TARGETS) {
      const target = host.querySelector<HTMLElement>(selector);
      if (target && !target.closest('[hidden], [inert]')) { target.focus({ preventScroll: true }); if (host.contains(document.activeElement)) return; }
    }
    // Nothing focusable (a diff still loading): the pane's own section, so the next key at least starts from here.
    const section = host.firstElementChild as HTMLElement | null;
    if (section) { if (!section.hasAttribute('tabindex')) section.tabIndex = -1; section.focus({ preventScroll: true }); }
  }));
}

// The window's focus is in this project's panes, or nowhere (the body): a maximize that ended may move it back without stealing it from
// the sidebar, a dialog or the palette.
export function focusInPanes(container: Element | null) {
  const active = document.activeElement;
  return !active || active === document.body || Boolean(container && container.contains(active));
}
