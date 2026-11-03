import { useEffect, useImperativeHandle } from 'react';
import { ApiError } from './api';

export const showKeys = keys => keys;
// Roots name their fate: "locked" fails like a project held by another server, "deleted" like a folder that is gone.
export function Workspace({ ref, root, onStatus, onFailed }) {
  useImperativeHandle(ref, () => ({}));
  useEffect(() => {
    if (root.includes('locked')) onFailed(root, new ApiError('PROJECT_LOCKED', 'locked'));
    else if (root.includes('deleted')) onFailed(root, new ApiError('ENOENT', 'gone'));
    else onStatus(root, { id: root.slice(1), name: root.slice(1), loaded: true, attention: 0, dirty: 0, activeTab: '', tabs: [] });
  }, [root, onStatus, onFailed]);
  return null;
}
