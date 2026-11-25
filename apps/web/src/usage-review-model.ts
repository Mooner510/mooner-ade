// Periods for the usage review. Monday is the first day, in the computer's local time.
export type ReviewPreset = 'all' | '7' | '30' | 'this' | 'last' | 'custom';

const DAY = 86_400_000;

export function reviewRange(preset: ReviewPreset, now: number, custom?: { from?: number; to?: number }) {
  if (preset === '7') return { from: now - 7 * DAY, to: now };
  if (preset === '30') return { from: now - 30 * DAY, to: now };
  if (preset === 'this' || preset === 'last') {
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    if (preset === 'this') return { from: monday.getTime(), to: now };
    return { from: monday.getTime() - 7 * DAY, to: monday.getTime() - 1 };
  }
  if (preset === 'custom') {
    const from = Number.isFinite(custom?.from) ? custom!.from! : 0;
    const to = Number.isFinite(custom?.to) ? custom!.to! : now;
    return { from, to: to < from ? from : to };
  }
  return { from: 0, to: now };
}

export const dayStamp = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 ? date.getTime() : null;
};

export function activityBuckets(rows: { date: string; value: number }[], from: number, to: number, timeZone: string, weekly: boolean) {
  if (!rows.length) return [];
  const formatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone });
  const bucketAt = (at: number) => {
    const parts = formatter.formatToParts(at);
    const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const day = new Date(Date.UTC(read('year'), read('month') - 1, read('day')));
    if (weekly) day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day.getTime();
  };
  const stride = weekly ? 7 * DAY : DAY;
  const last = bucketAt(to);
  const limit = weekly ? 8 : 14;
  const first = Math.max(last - (limit - 1) * stride, from > 0 ? bucketAt(from) : Date.parse(rows[0].date));
  const byDate = new Map(rows.map(row => [row.date, row.value]));
  const buckets = [];
  for (let at = first; at <= last; at += stride) {
    const date = new Date(at).toISOString().slice(0, 10);
    buckets.push({ date, value: byDate.get(date) ?? 0 });
  }
  return buckets;
}
