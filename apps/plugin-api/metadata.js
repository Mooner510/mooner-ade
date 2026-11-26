// Minimum identity shared by every package, including installed packages whose API was removed.
import { validSource } from '../desktop/src/plugin-updates.js';

export const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const fail = (message, code = 'PLUGIN_INVALID') => Object.assign(new Error(message), { code });
// The name and description appear in MoonerADE's own approval dialog: no control or bidirectional formatting characters
// that could fake its layout or reorder what it says (the description keeps single line breaks).
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
export const plainText = text => text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(new RegExp(UNSAFE_TEXT.source, 'g'), '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
export const str = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

export const isPluginApiVersion = value => Number.isSafeInteger(value) && value > 0;

export function pluginIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('plugin.json이 객체가 아닙니다.');
  if (!isPluginApiVersion(value.apiVersion)) throw fail('플러그인 API 버전은 양의 정수여야 합니다.');
  if (!str(value.id, 40) || !ID.test(value.id)) throw fail('플러그인 id가 올바르지 않습니다.');
  if (!str(value.name, 60) || UNSAFE_TEXT.test(value.name) || !value.name.trim()) throw fail('플러그인 이름이 없거나 쓸 수 없는 문자가 있습니다.');
  if (!str(value.version, 32) || !/^[0-9A-Za-z.+-]+$/.test(value.version)) throw fail('플러그인 버전이 올바르지 않습니다.');
  return { id: value.id, name: value.name, version: value.version, apiVersion: value.apiVersion,
    description: typeof value.description === 'string' ? plainText(value.description.slice(0, 300)) : '' };
}

// The update source is shared transport metadata. It never authorizes loading a removed API.
export function pluginSource(value, id) {
  return value.source === undefined ? undefined : validSource(value.source, id);
}
