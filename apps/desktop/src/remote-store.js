// Where this PC keeps what remote-link.js must not lose or leak: the Hub tokens, this PC's Noise key and the PCs it is paired with.
// One JSON file sealed with the OS (Electron safeStorage; `crypto` is injected so tests run without it). Read once, on first use:
// on macOS every safeStorage call reads the Keychain, which asks for the login password, so nothing here runs at startup.
import fs from 'node:fs';
import path from 'node:path';

export function createRemoteStore({ file, crypto }) {
  let cache;
  return {
    read() {
      if (cache !== undefined) return cache;
      let value = null;
      try {
        const parsed = JSON.parse(crypto.decryptString(fs.readFileSync(file)));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
      } catch { /* no file, or one that cannot be opened (another user, a lost key): signed out */ }
      return cache = value;
    },
    write(value) {
      let sealed;
      try { sealed = crypto.encryptString(JSON.stringify(value)); }
      catch { throw Object.assign(new Error('이 PC에서는 보안 저장소를 쓸 수 없어 로그인 정보를 저장하지 못했습니다.'), { code: 'NO_SECURE_STORAGE' }); }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, sealed, { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      cache = value;
    }
  };
}
