import { hello } from './transport';

type Call = <T = any>(action: string, input?: object) => Promise<T>;
const desktopPath = () => (window as unknown as { adeDesktop?: { pathForFile?(file: File): string } }).adeDesktop?.pathForFile;

const base64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => { const url = String(reader.result); resolve(url.slice(url.indexOf(',') + 1)); };
  reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
});

// Files given to the window (dropped or picked) as paths the agents can read. The desktop shell knows a local file's path. A browser,
// the phone app and another PC's window (where the agents run on that PC, so a path on this one would mean nothing there) send the
// bytes to the ADE server instead, 8MB each, which keeps a copy and answers its path.
export async function filePaths(files: File[], call: Call): Promise<string[]> {
  const pathForFile = desktopPath();
  if (pathForFile) return files.map(file => pathForFile(file)).filter(Boolean);
  return Promise.all(files.map(async file => (await call<{ path: string }>('files/upload', { name: file.name, data: await base64(file) })).path));
}

// Whether the shell that receives a typed path is Windows: the PC the terminals run on (another PC's, in a remote window).
export const shellIsWindows = () => hello?.host?.platform ? hello.host.platform === 'win32' : /Windows/.test(navigator.userAgent);
export const quoteShellPath = (path: string) => shellIsWindows() ? (/[\s&()^%!,;=]/.test(path) ? `"${path}"` : path) : path.replace(/[\s'"\\$`!&|;()<>*?[\]{}#~^]/g, '\\$&');
