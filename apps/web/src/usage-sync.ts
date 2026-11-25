import { api } from './api';

type Sync = (body: object) => Promise<{ signedIn?: boolean; failed?: boolean; batches?: { localId: string; name?: string; platform?: string; records: unknown[]; since?: number; after?: string }[] }>;

// The desktop process holds the Hub token. A failed push is not acknowledged, so the same rows are offered again.
export async function syncUsageLedger() {
  const desktop = (window as unknown as { adeDesktop?: { plugins?: { usageSync?: Sync } } }).adeDesktop?.plugins?.usageSync;
  if (!desktop) return;
  const pending = await api<{ deviceId: string; deviceName: string; platform: string; records: unknown[]; upto: number; remoteSince: Record<string, number>; remoteAfter: Record<string, string> }>('usage/ledger/pending', { limit: 80 });
  if (pending.records?.length) {
    const pushed = await desktop({ op: 'push', localId: pending.deviceId, name: pending.deviceName, platform: pending.platform, records: pending.records });
    if (pushed?.signedIn && !pushed.failed) await api('usage/ledger/ack', { n: pending.upto });
  }
  const pulled = await desktop({ op: 'pull', localId: pending.deviceId, since: pending.remoteSince || {}, after: pending.remoteAfter || {} });
  if (pulled?.signedIn && !pulled.failed && pulled.batches?.length) await api('usage/ledger/import', { batches: pulled.batches });
}
