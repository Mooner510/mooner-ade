// Stable ids for the Claude, Codex and Cursor logins a chat actually used.
// The ledger stores the key, never a token, an API key or a credential file.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const hash = value => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';
const pick = (object, path) => path.split('.').reduce((current, key) => current?.[key], object);

export const providers = ['claude', 'codex', 'cursor'];
const names = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

// A folder we saw, not a confirmed login. Backfill uses this because the chat log never stored who was signed in.
export const dirAccountKey = (provider, configDir) => `unknown:${provider}:${hash(configDir || `default:${provider}`)}`;

export const keyAccountKey = (provider, configDir) => `unknown:key:${provider}:${hash(configDir || 'default')}`;

// `profile` is whatever the provider login can say without the secret: Claude's OAuth profile, Codex account_id, Cursor user id.
export function identityFromProfile(provider, profile, configDir = '') {
  const plan = text(profile?.organization?.plan_display_name || profile?.plan, 80);
  const stableId = provider === 'codex' ? text(profile?.accountId, 120)
    : provider === 'cursor' ? text(profile?.userId, 120)
      : text(pick(profile, 'account.uuid') || pick(profile, 'account.id') || pick(profile, 'organization.uuid') || pick(profile, 'organization.id'), 120);
  const name = names[provider] || provider;
  if (stableId) return { accountKey: `${provider}:${stableId}`, label: plan ? `${name} (${plan})` : `${name} (${stableId.slice(0, 8)})`, plan, stable: true, provider, auth: 'login' };
  return { accountKey: dirAccountKey(provider, configDir), label: plan ? `${name} (${plan})` : `${name} (계정 미확정)`, plan, stable: false, provider, auth: 'login' };
}

// `id` is api-spend's `agent:<sha256 prefix>`, never the key.
export function keyAccount(provider, id) {
  const suffix = text(String(id).split(':')[1], 16);
  return { accountKey: text(id, 80), label: `API 키 (${suffix || '키'})`, plan: '', stable: true, provider, auth: 'key' };
}

export function unknownKeyAccount(provider, configDir) {
  return { accountKey: keyAccountKey(provider, configDir), label: 'API 키 (어느 키인지 기록 없음)', plan: '', stable: false, provider, auth: 'key' };
}

const emptyBook = () => ({ accounts: {}, aliases: {}, blocked: {} });

// aliases.json is a read-time map. Ledger lines are never rewritten when a folder later matches one login.
export function createAccountBook({ file, now = Date.now }) {
  let book = emptyBook();
  let writing = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(book);
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, file);
    }).catch(error => console.warn(`계정 목록을 저장하지 못했습니다: ${error.message}`));
    return writing;
  };
  return {
    async load() {
      try { book = { ...emptyBook(), ...JSON.parse(await fs.readFile(file, 'utf8')) }; }
      catch (error) { if (error.code !== 'ENOENT') console.warn(`계정 목록을 읽지 못했습니다: ${error.message}`); book = emptyBook(); }
      book.accounts ??= {}; book.aliases ??= {}; book.blocked ??= {};
    },
    note(identity) {
      if (!identity?.accountKey) return;
      const previous = book.accounts[identity.accountKey] ?? {};
      book.accounts[identity.accountKey] = { ...identity, seen: now(), firstSeen: previous.firstSeen || now() };
      void save();
    },
    // One confirmed login for a folder may stand in for that folder's older unknown key.
    // A second confirmed login removes the link and never adds it again.
    aliasSingle(dirKey, stableKey) {
      if (!dirKey || !stableKey || dirKey === stableKey || book.blocked[dirKey]) return false;
      const current = book.aliases[dirKey];
      if (current && current !== stableKey) {
        delete book.aliases[dirKey];
        book.blocked[dirKey] = true;
        void save();
        return false;
      }
      if (current === stableKey) return true;
      book.aliases[dirKey] = stableKey;
      void save();
      return true;
    },
    resolve(accountKey) {
      if (!accountKey || book.blocked[accountKey]) return accountKey;
      return book.aliases[accountKey] || accountKey;
    },
    get(accountKey) {
      const key = this.resolve(accountKey);
      return book.accounts[key] || book.accounts[accountKey] || null;
    },
    list() { return Object.values(book.accounts); },
    aliased(accountKey) { return Boolean(accountKey && book.aliases[accountKey] && !book.blocked[accountKey]); },
    flush: () => writing
  };
}
