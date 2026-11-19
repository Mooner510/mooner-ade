// Node trusts its bundled roots, not the OS store, unless told to. Hub calls in this process (market, sign-in,
// plugin download) use that default, so the system-certificate switch adds the OS roots here. Plugin children and the
// local server get NODE_USE_SYSTEM_CA instead; a change still needs a restart because those processes are already up.
import tls from 'node:tls';

export function useSystemTrustStore(tlsApi = tls) {
  if (typeof tlsApi.getCACertificates !== 'function' || typeof tlsApi.setDefaultCACertificates !== 'function') return false;
  const current = tlsApi.getCACertificates('default');
  const system = tlsApi.getCACertificates('system');
  const have = new Set(current);
  const extra = system.filter(cert => !have.has(cert));
  if (!extra.length) return false;
  tlsApi.setDefaultCACertificates([...current, ...extra]);
  return true;
}

// The switch is off. Node may already have merged the OS roots because NODE_USE_SYSTEM_CA was set in the shell at startup.
// Put the default store back to the bundled roots (plus NODE_EXTRA_CA_CERTS, which is a different switch).
export function useBundledTrustStore(tlsApi = tls) {
  if (typeof tlsApi.getCACertificates !== 'function' || typeof tlsApi.setDefaultCACertificates !== 'function') return false;
  let bundled;
  try { bundled = tlsApi.getCACertificates('bundled'); } catch { return false; }
  if (!bundled?.length) return false;
  let extra = [];
  try { extra = tlsApi.getCACertificates('extra') ?? []; } catch { extra = []; }
  const seen = new Set();
  const certs = [];
  for (const cert of [...bundled, ...extra]) {
    if (!cert || seen.has(cert)) continue;
    seen.add(cert);
    certs.push(cert);
  }
  tlsApi.setDefaultCACertificates(certs);
  return true;
}
