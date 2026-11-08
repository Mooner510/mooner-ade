// The Hub's HTTP API as the desktop app uses it (contract in docs/REMOTE_ACCESS.md, "Hub API"). The Hub only finds devices,
// relays and revokes; it can never grant access to this PC, so nothing it returns is trusted beyond the account link.
const TIMEOUT_MS = 15_000;

export class HubError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function createHubClient(baseUrl, { fetchImpl = fetch } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  async function call(method, path, { body, token } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
        ...(body && { body: JSON.stringify(body) })
      });
    } catch (error) { throw new HubError(0, 'HUB_UNREACHABLE', `원격 접속 서버에 연결하지 못했습니다: ${error.message}`); }
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!response.ok) throw new HubError(response.status, value?.error?.code ?? `HTTP_${response.status}`, value?.error?.message ?? `원격 접속 서버 오류 (${response.status})`);
    return value;
  }
  return {
    // Device-code style: the user signs in with Authentik in the browser at verifyUrl, this side polls for the result.
    enrollStart: input => call('POST', '/v1/enroll/start', { body: input }),
    enrollPoll: ({ enrollId, pollToken }) => call('POST', '/v1/enroll/poll', { body: { enrollId, pollToken } }),
    refresh: refreshToken => call('POST', '/v1/token/refresh', { body: { refreshToken } }),
    me: token => call('GET', '/v1/me', { token }),
    unlink: token => call('DELETE', '/v1/me', { token }),
    deviceStatus: (token, id) => call('GET', `/v1/devices/${encodeURIComponent(id)}/status`, { token })
  };
}
