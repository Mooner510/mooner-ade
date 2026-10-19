import { useEffect, useImperativeHandle } from 'react';

export const showKeys = keys => keys;
export function Workspace({ ref, root, onStatus }) {
  useImperativeHandle(ref, () => Object.fromEntries(['selectTab', 'selectPane', 'closePane', 'moveTab', 'mergeTabs', 'movePane', 'closeTab'].map(name => [name, (...args) => window.calls.push([name, ...args])])));
  useEffect(() => {
    const tabs = [
      { id: 'group', label: 'Group', panes: [{ id: 'one', label: 'Terminal one', kind: 'terminal', focused: true }, { id: 'two', label: 'Terminal two', kind: 'terminal', agent: 'codex' }] },
      { id: 'other', label: 'Other terminal', panes: [] }
    ];
    onStatus(root, { id: 'project', name: 'Project', loaded: true, attention: 0, dirty: 0, activeTab: 'group', tabs: location.pathname === '/reverse' ? tabs.reverse() : tabs });
  }, [root, onStatus]);
  return null;
}
