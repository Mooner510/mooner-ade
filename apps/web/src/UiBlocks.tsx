import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { formMessage, niceTicks, type Field, type Spec } from './ui-spec';
import { MAX_SEND } from './ui-frame-protocol';
import { subscribeUiSent, uiSendActive, uiSendOf } from './ui-sent';
import { Tick } from './Icon';
import { Dropdown } from './views';

// Draws the ```ui fence (see ui-spec.ts) with the app's own styles: React elements only, nothing from the model is run or injected as HTML.
const COLORS = ['var(--accent)', 'var(--warn)', 'var(--add)', 'var(--del)', 'var(--term-magenta)', 'var(--info)'];

const short = (v: number) => Math.abs(v) >= 1e4 ? `${+(v / 1e3).toPrecision(3)}k` : String(+v.toPrecision(4));

function Chart({ spec }: { spec: Extract<Spec, { t: 'chart' }> }) {
  // Drawn at the card's real width (not a fixed picture scaled up), so the bars use the room and the labels keep their size.
  const box = useRef<HTMLDivElement>(null), [W, setW] = useState(480);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setW(Math.max(220, Math.round(el.clientWidth)));
    measure(); const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect();
  }, []);
  const { kind, title, x, y } = spec, all = y.flatMap(([, values]) => values), n = Math.max(x.length, ...y.map(([, values]) => values.length));
  if (!n || !all.length) return null;
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all)), lo = ticks[0], hi = ticks[ticks.length - 1];
  const H = 180, L = 8 + 6.5 * Math.max(...ticks.map(t => short(t).length)), T = 16, B = 22, R = 8;
  const at = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B), step = (W - L - R) / n;
  const bars = kind !== 'line' && kind !== 'pie', labelled = bars && n * y.length <= 24 && step * .7 / y.length >= 18;
  const legend = y.length > 1 && <div className="ui-legend">{y.map(([name], i) => <span key={name}><i style={{ background: COLORS[i] }} />{name}</span>)}</div>;
  let body;
  if (kind === 'pie') {
    const values = (y[0]?.[1] ?? []).map(v => Math.max(0, v)), total = values.reduce((a, b) => a + b, 0);
    let angle = -Math.PI / 2;
    body = <div className="ui-pie"><svg viewBox="0 0 160 160" role="img" aria-label={title || 'chart'}>{total > 0 && values.map((v, i) => {
      const next = angle + v / total * 2 * Math.PI, point = (a: number) => `${80 + 70 * Math.cos(a)} ${80 + 70 * Math.sin(a)}`, d = v / total > .9999 ? undefined : `M80 80L${point(angle)}A70 70 0 ${next - angle > Math.PI ? 1 : 0} 1 ${point(next)}Z`;
      angle = next;
      return v ? d ? <path key={i} d={d} fill={COLORS[i % 6]} /> : <circle key={i} cx="80" cy="80" r="70" fill={COLORS[i % 6]} /> : null;
    })}{total > 0 && <circle cx="80" cy="80" r="44" fill="var(--surface)" />}</svg><ul className="ui-legend">{values.map((v, i) => <li key={i}><i style={{ background: COLORS[i % 6] }} />{x[i] ?? i + 1} <b>{total ? Math.round(v / total * 100) : 0}%</b></li>)}</ul></div>;
  } else {
    body = <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={title || 'chart'}>
      {ticks.map(t => <g key={t}><line x1={L} x2={W - R} y1={at(t)} y2={at(t)} stroke={t === 0 ? 'var(--border-strong)' : 'var(--border)'} strokeDasharray={t === 0 ? undefined : '2 3'} />
        <text x={L - 6} y={at(t) + 3.5} textAnchor="end" className="ui-axis">{short(t)}</text></g>)}
      {Array.from({ length: n }, (_, i) => <text key={i} x={L + step * (i + .5)} y={H - 5} textAnchor="middle" className="ui-axis">{n > 12 && i % 2 ? '' : x[i] ?? ''}</text>)}
      {y.map(([name, values], s) => kind === 'line'
        ? <g key={name} fill={COLORS[s]} stroke={COLORS[s]}><polyline fill="none" strokeWidth="2" points={values.map((v, i) => `${L + step * (i + .5)},${at(v)}`).join(' ')} />{values.map((v, i) => <circle key={i} cx={L + step * (i + .5)} cy={at(v)} r="2.5" stroke="none"><title>{`${name} ${x[i] ?? ''}: ${v}`}</title></circle>)}</g>
        : values.map((v, i) => { const w = Math.min(step * .7 / y.length, 72), left = L + step * i + (step - w * y.length) / 2 + w * s, top = Math.min(at(v), at(0));
          return <g key={`${name}${i}`}><rect x={left} y={top} width={w} height={Math.abs(at(v) - at(0))} rx="2" fill={COLORS[s]}><title>{`${name} ${x[i] ?? ''}: ${v}`}</title></rect>
            {labelled && <text x={left + w / 2} y={v < 0 ? at(v) + 12 : top - 4} textAnchor="middle" className="ui-value">{short(v)}</text>}</g>; }))}
    </svg>;
  }
  return <div className="ui-card">{title && <h4>{title}</h4>}<div ref={box} className="ui-chart">{body}</div>{legend}</div>;
}

function Control({ f, value, set }: { f: Field; value: string; set: (value: string) => void }) {
  const group = useId(), common = { value, onChange: (event: { target: { value: string } }) => set(event.target.value) };
  switch (f.type) {
    case 'area': return <textarea rows={3} {...common} />;
    // The app's own dropdown (the native list is the platform's, not ours).
    case 'select': return <Dropdown className="ui-dd" label={f.label} value={value} options={f.options.map(opt => ({ value: opt, label: opt }))} onChange={set} />;
    // Radios and checkboxes are the app's own marks (like the question card's options); the native input stays for keyboard and screen readers.
    case 'radio': return <div className="ui-opts">{f.options.map(opt => <label key={opt} className="ui-choice"><input className="ui-native" type="radio" name={group} checked={value === opt} onChange={() => set(opt)} /><span className="ui-mark ui-dot" aria-hidden="true" />{opt}</label>)}</div>;
    case 'check': return <><input className="ui-native" type="checkbox" checked={value === 'true'} onChange={event => set(String(event.target.checked))} /><span className="ui-mark ui-box" aria-hidden="true"><Tick size={11} /></span></>;
    // The track is drawn (a thin line filled in the accent colour up to the value), so --fill follows the value.
    case 'slider': return <span className="ui-range" style={{ '--fill': `${Math.max(0, Math.min(100, ((Number(value) - f.min) / ((f.max - f.min) || 1)) * 100))}%` } as CSSProperties}><input type="range" min={f.min} max={f.max} step={f.step} {...common} /><output>{value}</output></span>;
    default: return <input type={f.type} data-empty={value === '' || undefined} {...common} />;
  }
}

const SEND_LABEL = { pending: '대기열에서 기다리는 중…', working: '처리 중…', done: '✓ 처리 완료' } as const;

function Form({ chatId, spec }: { chatId: string; spec: Extract<Spec, { t: 'form' }> }) {
  const [values, setValues] = useState(() => Object.fromEntries(spec.fields.map(f => [f.k, f.value]))), [sent, setSent] = useState<'fill' | null>(null);
  // What became of the last "바로 보내기" of this form lives outside the component (it survives a remount), so one choice is not sent twice: while the answer is queued or the
  // turn runs the button is a status, and once done it stays so until the answers change. The user interrupting the turn frees it (ui-sent.ts).
  const formId = JSON.stringify(spec), message = formMessage(spec, values).slice(0, MAX_SEND);
  const send = useSyncExternalStore(subscribeUiSent, () => uiSendOf(chatId, formId));
  const sendLocked = uiSendActive(send) || (send?.stage === 'done' && send.text === message);
  // Every form has two actions: fill the composer (replace, so a second click updates it instead of stacking a copy; the user edits and sends),
  // or send the answers at once. Enter in a field fills the composer, the safer of the two.
  const submit = (fill: boolean) => {
    if (!fill && sendLocked) return;
    window.dispatchEvent(new CustomEvent(fill ? 'ade:ui-prefill' : 'ade:ui-send', { detail: { chatId, text: message, form: formId, ...(fill && { replace: true }) } }));
    if (fill) setSent('fill');
  };
  return <form className="ui-card ui-form" onSubmit={event => { event.preventDefault(); submit(true); }} onChange={() => setSent(null)}>
    {spec.title && <h4>{spec.title}</h4>}
    {spec.fields.map(f => {
      const control = <Control f={f} value={values[f.k] ?? ''} set={value => { setSent(null); setValues(current => ({ ...current, [f.k]: value })); }} />;
      // Radio options carry their own labels, so their field is a group, not a label wrapped around labels (which would also pick the first option on a click of the title).
      return f.type === 'radio' ? <div key={f.k} className="ui-field ui-radio" role="radiogroup" aria-label={f.label}><span>{f.label}</span>{control}</div>
        : f.type === 'check' ? <label key={f.k} className="ui-field ui-check ui-choice">{control}<span>{f.label}</span></label>
        : f.type === 'select' ? <div key={f.k} className="ui-field ui-select" role="group" aria-label={f.label}><span>{f.label}</span>{control}</div>
        : <label key={f.k} className={`ui-field ui-${f.type}`}><span>{f.label}</span>{control}</label>;
    })}
    <div className="ui-form-actions"><button type="button" className="secondary" disabled={sendLocked} aria-live="polite" data-send={send && sendLocked ? send.stage : undefined} onClick={() => submit(false)}>{send && sendLocked ? SEND_LABEL[send.stage] : '바로 보내기'}</button>{/* 이 버튼은 늘 입력창에 채우기만 한다(Enter도 같다). AI가 붙인 라벨('선택 보내기' 등)은 보내기로 읽혀 "바로 보내기"와 헷갈리므로 동작 그대로 적고, AI의 라벨은 표시하지 않는다. */}<button type="submit" className="primary">{sent === 'fill' ? '✓ 입력창에 채웠어요' : '입력창에 채우기'}</button></div>
  </form>;
}

export function UiSpecView({ chatId, specs }: { chatId: string; specs: Spec[] }) {
  return <>{specs.map((spec, i) => {
    switch (spec.t) {
      // One strip of figures split by hairlines (not a box per number); a tone is a small dot by the label.
      case 'stats': return <div key={i} className="ui-stats">{spec.items.map((item, j) => <div key={j} className="ui-stat" data-tone={item.tone || undefined}>
        <small className="ui-stat-label">{item.label}</small><strong>{item.value}</strong>{item.sub && <small className="ui-stat-sub">{item.sub}</small>}</div>)}</div>;
      // A timeline: the same check / number badges as the question card's tabs, joined by a line, the current step in the accent colour.
      case 'steps': return <ol key={i} className="ui-steps">{spec.items.map(([name, state, detail], j) => <li key={j} data-state={state}>
        <span className="ui-step-mark">{state === 'done' ? <Tick size={11} /> : j + 1}</span><span className="ui-step-text"><span className="ui-step-name">{name}</span>{detail && <span className="ui-step-detail">{detail}</span>}</span></li>)}</ol>;
      case 'chart': return <Chart key={i} spec={spec} />;
      default: return <Form key={i} chatId={chatId} spec={spec} />;
    }
  })}</>;
}
