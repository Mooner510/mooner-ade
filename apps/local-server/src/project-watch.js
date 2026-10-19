import fs from 'node:fs';
import path from 'node:path';

// Watching is only an accelerator: Git polling and open-file revision checks remain active in the UI.
export function watchProjectFiles(root, notify) {
  let watcher, timer, closed = false;
  const changed = new Set();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    changed.clear();
    watcher?.close();
  };
  const failed = error => {
    close();
    console.warn(`파일 감시를 중지합니다 (${error.code || 'WATCH_FAILED'}). Git 및 열린 파일은 폴링으로 확인합니다.`);
  };
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      if (closed || !name || /(^|[\\/])(\.git|node_modules|dist|\.idea)([\\/]|$)/.test(name)) return;
      // Bound the batch before debounce, including during a continuous stream of changes.
      if (changed.size < 200) changed.add(String(name).split(path.sep).join('/'));
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const paths = [...changed]; changed.clear();
        if (!closed) notify(paths);
      }, 150);
      timer.unref();
    });
    watcher.on('error', failed);
  } catch (error) { failed(error); }
  return { close };
}
