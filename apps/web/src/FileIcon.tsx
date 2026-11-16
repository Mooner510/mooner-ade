import associations from '../node_modules/atom-material-icons/public/icon_associations.json';
import folderAssociations from '../node_modules/atom-material-icons/public/folder_associations.json';

// Atom Material Icons (mallowigi, MIT). The SVGs are served as files (see vite.config.js) so 640 of them never land in the JS bundle.
const urls = import.meta.glob<string>('../node_modules/atom-material-icons/public/icons/files/*.svg', { eager: true, query: '?url', import: 'default' });
const folderUrls = import.meta.glob<string>('../node_modules/atom-material-icons/public/icons/folders/*.svg', { eager: true, query: '?url', import: 'default' });
const folderByName = new Map(Object.entries(folderUrls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));
const byName = new Map(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));

type Rule = { pattern: RegExp; file: string };
// The association list is ordered by specificity (`*.test.ts` before `*.ts`), so the first match wins.
const rules: Rule[] = associations.associations.associations.regex.flatMap(rule => {
  try { return [{ pattern: new RegExp(rule.pattern, 'i'), file: rule.icon.slice(rule.icon.lastIndexOf('/') + 1) }]; } catch { return []; }
});
const folderRules: Rule[] = folderAssociations.associations.associations.regex.flatMap(rule => {
  try { return [{ pattern: new RegExp(rule.pattern, 'i'), file: rule.icon.slice(rule.icon.lastIndexOf('/') + 1) }]; } catch { return []; }
});
const cache = new Map<string, string | undefined>();

function resolve(name: string, folder: boolean) {
  const key = folder ? `${name}/` : name;
  if (!cache.has(key)) {
    const [list, urls] = folder ? [folderRules, folderByName] : [rules, byName];
    const hit = list.find(rule => rule.pattern.test(name) && urls.has(rule.file));
    cache.set(key, urls.get(hit?.file ?? 'default.svg'));
  }
  return cache.get(key);
}

export function FileIcon({ name, size = 16, folder = false }: { name: string; size?: number; folder?: boolean }) {
  return <img className="file-glyph" src={resolve(name, folder)} width={size} height={size} alt="" draggable={false} />;
}
