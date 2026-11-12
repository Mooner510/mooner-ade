import { useId, useState } from 'react';
import { formMessage, type Field, type Spec } from './ui-spec';
import { MAX_SEND } from './ui-frame-protocol';

// Draws the ```ui fence (see ui-spec.ts) with the app's own styles: React elements only, nothing from the model is run or injected as HTML.
const COLORS = ['var(--accent)', 'var(--warn)', 'var(--add)', 'var(--del)', 'var(--term-magenta)', 'var(--info)'];

function Chart({ spec }: { spec: Extract<Spec, { t: 'chart' }> }) {
  const { kind, title, x, y } = spec, all = y.flatMap(([, values]) => values), n = Math.max(x.length, ...y.map(([, values]) => values.length));
  if (!n || !all.length) return null;
  const W = 320, H = 150, L = 34, T = 8, B = 20, R = 6, hi = Math.max(0, ...all), lo = Math.min(0, ...all), at = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B), step = (W - L - R) / n;
  const legend = y.length > 1 && <div className="ui-legend">{y.map(([name], i) => <span key={name}><i style={{ background: COLORS[i] }} />{name}</span>)}</div>;
  let body;
  if (kind === 'pie') {
    const values = (y[0]?.[1] ?? []).map(v => Math.max(0, v)), total = values.reduce((a, b) => a + b, 0);
    let angle = -Math.PI / 2;
    body = <div className="ui-pie"><svg viewBox="0 0 160 160" role="img" aria-label={title || 'chart'}>{total > 0 && values.map((v, i) => {
      const next = angle + v / total * 2 * Math.PI, point = (a: number) => `${80 + 70 * Math.cos(a)} ${80 + 70 * Math.sin(a)}`, d = v / total > .9999 ? undefined : `M80 80L${point(angle)}A70 70 0 ${next - angle > Math.PI ? 1 : 0} 1 ${point(next)}Z`;
      angle = next;
      return v ? d ? <path key={i} d={d} fill={COLORS[i % 6]} /> : <circle key={i} cx="80" cy="80" r="70" fill={COLORS[i % 6]} /> : null;
    })}</svg><ul className="ui-legend">{values.map((v, i) => <li key={i}><i style={{ background: COLORS[i % 6] }} />{x[i] ?? i + 1} <b>{total ? Math.round(v / total * 100) : 0}%</b></li>)}</ul></div>;
  } else {
    body = <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title || 'chart'}>
      <line x1={L} x2={W - R} y1={at(0)} y2={at(0)} stroke="var(--border-strong)" />
      <text x={L - 4} y={at(hi) + 4} textAnchor="end" className="ui-axis">{+hi.toPrecision(3)}</text>{lo < 0 && <text x={L - 4} y={at(lo)} textAnchor="end" className="ui-axis">{+lo.toPrecision(3)}</text>}
      {Array.from({ length: n }, (_, i) => <text key={i} x={L + step * (i + .5)} y={H - 5} textAnchor="middle" className="ui-axis">{n > 12 && i % 2 ? '' : x[i] ?? ''}</text>)}
      {y.map(([name, values], s) => kind === 'line'
        ? <g key={name} fill={COLORS[s]} stroke={COLORS[s]}><polyline fill="none" strokeWidth="2" points={values.map((v, i) => `${L + step * (i + .5)},${at(v)}`).join(' ')} />{values.map((v, i) => <circle key={i} cx={L + step * (i + .5)} cy={at(v)} r="2.5" stroke="none"><title>{`${name} ${x[i] ?? ''}: ${v}`}</title></circle>)}</g>
        : values.map((v, i) => { const w = step * .7 / y.length, top = Math.min(at(v), at(0)); return <rect key={`${name}${i}`} x={L + step * i + step * .15 + w * s} y={top} width={w} height={Math.abs(at(v) - at(0))} fill={COLORS[s]}><title>{`${name} ${x[i] ?? ''}: ${v}`}</title></rect>; }))}
    </svg>;
  }
  return <div className="ui-card">{title && <h4>{title}</h4>}{body}{legend}</div>;
}

function Control({ f, value, set }: { f: Field; value: string; set: (value: string) => void }) {
  const group = useId(), common = { value, onChange: (event: { target: { value: string } }) => set(event.target.value) };
  switch (f.type) {
    case 'area': return <textarea rows={3} {...common} />;
    case 'select': return <select {...common}>{f.options.map(opt => <option key={opt}>{opt}</option>)}</select>;
    case 'radio': return <div className="ui-opts">{f.options.map(opt => <label key={opt}><input type="radio" name={group} checked={value === opt} onChange={() => set(opt)} />{opt}</label>)}</div>;
    case 'check': return <input type="checkbox" checked={value === 'true'} onChange={event => set(String(event.target.checked))} />;
    case 'slider': return <span className="ui-slider"><input type="range" min={f.min} max={f.max} step={f.step} {...common} /><output>{value}</output></span>;
    default: return <input type={f.type} {...common} />;
  }
}

function Form({ chatId, spec }: { chatId: string; spec: Extract<Spec, { t: 'form' }> }) {
  const [values, setValues] = useState(() => Object.fromEntries(spec.fields.map(f => [f.k, f.value]))), [sent, setSent] = useState(false);
  const submit = () => { window.dispatchEvent(new CustomEvent(spec.fill ? 'ade:ui-prefill' : 'ade:ui-send', { detail: { chatId, text: formMessage(spec, values).slice(0, MAX_SEND) } })); setSent(true); };
  return <form className="ui-card ui-form" onSubmit={event => { event.preventDefault(); submit(); }} onChange={() => setSent(false)}>
    {spec.title && <h4>{spec.title}</h4>}
    {spec.fields.map(f => <label key={f.k} className={`ui-field ui-${f.type}`}><span>{f.label}</span><Control f={f} value={values[f.k] ?? ''} set={value => setValues(current => ({ ...current, [f.k]: value }))} /></label>)}
    <button type="submit" className="primary">{sent ? '✓ ' : ''}{spec.submit}</button>
  </form>;
}

export function UiSpecView({ chatId, specs }: { chatId: string; specs: Spec[] }) {
  return <>{specs.map((spec, i) => {
    switch (spec.t) {
      case 'stats': return <div key={i} className="ui-stats">{spec.items.map((item, j) => <div key={j} className="ui-card" data-tone={item.tone || undefined}><small>{item.label}</small><strong>{item.value}</strong>{item.sub && <small>{item.sub}</small>}</div>)}</div>;
      case 'steps': return <ol key={i} className="ui-steps">{spec.items.map(([name, state], j) => <li key={j} data-state={state}><i>{state === 'done' ? '✓' : j + 1}</i>{name}</li>)}</ol>;
      case 'chart': return <Chart key={i} spec={spec} />;
      default: return <Form key={i} chatId={chatId} spec={spec} />;
    }
  })}</>;
}
