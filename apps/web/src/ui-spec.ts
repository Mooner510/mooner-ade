// Native chat UI blocks: a ```ui fence holding positional JSON arrays that the app draws itself (stats, charts, steps, forms). No model-written code runs, and with no key
// names repeated it is the cheapest thing for the model to write. Pure, so tests load it directly. Everything is model output: coerced and capped here, never trusted.
//   ["stats", [label, value, tone?, sub?], ...]            tone: ok|warn|err|info
//   ["chart", "line|bar|pie", title, [x labels], [name, v1, v2, ...], ...]
//   ["steps", [name, "done|active|todo", detail?], ...]
//   ["form"|"draft", title, submit, field, ...]           field: [type, key, label, ...]; draft only fills the message box instead of sending
//     text|number|area|date|check: [type, key, label, default?]   slider: [.., min, max, default?]   select|radio: [.., option, option, ...]
// A fence holds one component or an array of them.
export const NATIVE_LANG = 'ui';
export type Field = { k: string; label: string; type: 'text' | 'number' | 'area' | 'select' | 'radio' | 'check' | 'slider' | 'date'; options: string[]; value: string; min: number; max: number; step: number };
export type Spec =
  | { t: 'stats'; items: { label: string; value: string; sub: string; tone: string }[] }
  | { t: 'chart'; kind: 'line' | 'bar' | 'pie'; title: string; x: string[]; y: [string, number[]][] }
  | { t: 'steps'; items: [string, 'done' | 'active' | 'todo', string][] }
  | { t: 'form'; title: string; fields: Field[]; submit: string; fill: boolean };

const str = (v: unknown, max = 200) => typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : '';
const list = (v: unknown, max: number): unknown[] => Array.isArray(v) ? v.slice(0, max) : [];
const num = (v: unknown, fallback = 0) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const pick = <T extends string>(v: unknown, all: readonly T[], fallback: T): T => all.includes(v as T) ? v as T : fallback;
const FIELDS = ['text', 'number', 'area', 'select', 'radio', 'check', 'slider', 'date'] as const;

function field(raw: unknown): Field {
  const [kind, key, name, ...rest] = list(raw, 30), type = pick(kind, FIELDS, 'text'), label = str(name, 80) || str(key, 40), min = num(rest[0], 0);
  const options = type === 'select' || type === 'radio' ? rest.slice(0, 20).map(opt => str(opt, 60)) : [];
  const value = type === 'slider' ? str(rest[2]) || String(min) : type === 'check' ? String(rest[0] === true || rest[0] === 'true') : options[0] ?? str(rest[0], 500);
  return { k: str(key, 40) || label, label, type, options, value, min, max: Math.max(min, num(rest[1], 100)), step: 1 };
}

function one(raw: unknown): Spec | null {
  const [t, ...r] = list(raw, 60);
  switch (t) {
    case 'stats': return { t, items: r.slice(0, 12).map(i => { const [label, value, a, b] = list(i, 4), tone = pick(a, ['ok', 'warn', 'err', 'info', ''], ''); return { label: str(label), value: str(value), tone, sub: str(tone ? b : a) }; }) };
    case 'chart': { const [kind, title, x, ...series] = r; return { t, kind: pick(kind, ['line', 'bar', 'pie'], 'bar'), title: str(title), x: list(x, 100).map(label => str(label, 40)), y: series.slice(0, 6).map(s => { const [name, ...values] = list(s, 101); return [str(name, 60), values.map(n => num(n))]; }) }; }
    case 'steps': return { t, items: r.slice(0, 30).map(i => { const [name, state, detail] = Array.isArray(i) ? i : [i]; return [str(name), pick(state, ['done', 'active', 'todo'], 'todo'), str(detail)]; }) };
    case 'form': case 'draft': { const [title, submit, ...fields] = r; return { t: 'form', title: str(title), submit: str(submit, 40) || '보내기', fill: t === 'draft', fields: fields.slice(0, 12).map(field).filter(f => f.label) }; }
    default: return null;
  }
}

// null when the fence is not valid JSON or holds no known component: the caller shows it as a plain code block.
export function parseUi(code: string): Spec[] | null {
  let json: unknown;
  try { json = JSON.parse(code); } catch { return null; }
  const specs = (Array.isArray(json) && typeof json[0] === 'string' ? [json] : list(json, 8)).map(one).filter((spec): spec is Spec => spec !== null);
  return specs.length ? specs : null;
}

// What a submitted form says to the agent: a normal user message.
export function formMessage(form: Extract<Spec, { t: 'form' }>, values: Record<string, string>) {
  const rows = form.fields
    .filter(f => f.type === 'check' || (values[f.k] ?? '').trim()) // empty answers are left out
    .map(f => `- ${f.label}: ${f.type === 'check' ? (values[f.k] === 'true' ? 'yes' : 'no') : values[f.k]}`).join('\n');
  return (form.title ? `${form.title}\n` : '') + rows;
}

// Round axis steps (1, 2, 5 × 10ⁿ) covering lo..hi, about `count` of them, so the gridlines read as 0 · 2 · 4 · 6 · 8 rather than one odd maximum.
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map(k => k * mag).find(k => k >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(+v.toPrecision(12));
  if (ticks[ticks.length - 1] < hi) ticks.push(+(ticks[ticks.length - 1] + step).toPrecision(12));
  return ticks;
}
