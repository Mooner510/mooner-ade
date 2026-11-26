// What the project tree colours files by: one `git status` for the whole project, folded into a path → state map.
// Plain keys are files (and folders that hold changes); a key with a trailing "/" is a whole folder git reports as one entry
// (`node_modules/` ignored, a brand-new folder untracked), which covers everything under it.
//   ignored   !!  matches .gitignore            untracked  ??  not tracked, not ignored
//   added     new file staged in the index       modified   a tracked file that changed (and a folder that holds such files)

const stateOf = status => {
  if (status === '!!') return 'ignored';
  if (status === '??') return 'untracked';
  if (status[0] === 'A' || status[0] === 'C') return 'added';
  return 'modified';
};

// `output` is `git status --porcelain=v1 -z --ignored=matching`; `prefix` is where the project folder sits inside the repository ('' at its top, else "sub/dir/").
export function parseTreeStatus(output, prefix = '') {
  const states = {}, entries = output.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    let file = entry.slice(3);
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(status)) index++;
    if (prefix) {
      if (!file.startsWith(prefix)) continue;
      file = file.slice(prefix.length);
      if (!file) continue;
    }
    const state = stateOf(status), folder = file.endsWith('/');
    if (folder) file = file.slice(0, -1);
    states[folder ? `${file}/` : file] = state;
    if (state === 'ignored') continue;
    // Every folder above a change is marked as holding one (the project folder is '.').
    const parts = file.split('/');
    for (let depth = parts.length - 1; depth >= 1; depth--) states[parts.slice(0, depth).join('/')] = 'modified';
    states['.'] = 'modified';
  }
  return states;
}

export async function readTreeStates(runtime) {
  const prefix = await runtime.processes.exec('git', ['rev-parse', '--show-prefix']);
  if (prefix.exitCode !== 0) return {};
  const status = await runtime.processes.exec('git', ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal']);
  if (status.exitCode !== 0) return {};
  return parseTreeStatus(status.stdout, prefix.stdout.trim());
}
