import { Icon } from './Icon';
import { copyText } from './toast';

export type UsageReport = { suggestions: { id: string; tone: 'good' | 'improve'; title: string; text: string }[] };

export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="stats-tile" title={hint || value}>
    <small>{label}</small>
    <b>{value}</b>
  </div>;
}

export function UsageAssessment({ report, copy }: { report?: UsageReport; copy?: boolean }) {
  const findings = report?.suggestions?.filter(item => item.tone === 'good' || item.tone === 'improve') ?? [];
  return <section className="stats-assessment">
    <div className="stats-section-head"><h3>사용 평가</h3>
      {copy && findings.length > 0 && <button type="button" className="stats-text-button" onClick={() => copyText(findings.map(item => `${item.title} — ${item.text}`).join('\n'))}><Icon name="copy" size={14} />복사</button>}
    </div>
    {findings.length > 0 ? <div className="stats-assessment-grid">
      {([{ tone: 'good', label: '잘한 점', icon: 'check', empty: '뚜렷한 강점 없음' }, { tone: 'improve', label: '개선할 점', icon: 'alert', empty: '뚜렷한 개선점 없음' }] as const).map(group => {
        const items = findings.filter(item => item.tone === group.tone);
        return <div key={group.tone} data-tone={group.tone}>
          <h4><Icon name={group.icon} size={15} />{group.label}</h4>
          {items.length ? <ul>{items.map(item => <li key={item.id}><strong>{item.title}</strong><span>{item.text}</span></li>)}</ul> : <p>{group.empty}</p>}
        </div>;
      })}
    </div> : <p className="stats-empty">현재 기록에서 뚜렷한 강점이나 개선점을 확인하기 어려워요.</p>}
  </section>;
}
