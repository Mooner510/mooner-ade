import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChangelogDemo, demoWide } from './ChangelogDemo';
import { Icon } from './Icon';
import { Modal } from './views';
import changelog from './changelog.json';
import kinds from './changelog-kinds.json';
import { changelogIsBeta, changelogIsFresh, changelogIsRich, changelogNewer, changelogPlaysIntro, changelogSeen, hasUnreadChangelogVersions, markChangelogSeen, readChangelogViewed, syncChangelogVersion, writeChangelogViewed } from './changelog-state';

type Entry = { version: string; date: string; time?: string; intro?: { hue: number; tagline: string }; items: { kind: string; title: string; text: string; icon?: string; image?: string; demo?: string }[] };
// Items are listed by kind, in the order of changelog-kinds.json (the release notes use the same order).
const rank = (kind: string) => kinds.indexOf(kind);
export const entries = (changelog as Entry[]).map(entry => ({ ...entry, items: [...entry.items].sort((a, b) => rank(a.kind) - rank(b.kind)) }));
// One section per kind (same order as the release notes), so a long version reads as a patch-note page instead of one flat list.
const groups = (entry: Entry) => kinds.map(kind => ({ kind, items: entry.items.filter(item => item.kind === kind) })).filter(group => group.items.length);
const seenVersion = changelogSeen;
const readViewed = readChangelogViewed;
const writeViewed = writeChangelogViewed;
// How long ago a release was, in the words the sidebar shows. `date` and `time` are the KST clock time written in changelog.json.
const ago = (date: string, time: string, now = Date.now()) => {
  const minutes = (now - Date.parse(`${date}T${time}:00+09:00`)) / 60_000;
  if (minutes < 10) return '방금';
  if (minutes < 60) return `${Math.floor(minutes)}분 전`;
  const days = minutes / 1440;
  if (days < 1) return `${Math.floor(minutes / 60)}시간 전`;
  if (days < 7) return `${Math.floor(days)}일 전`;
  if (days < 30) return `${Math.floor(days / 7)}주 전`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30.4))}달 전`;
  return `${Math.floor(days / 365)}년 전`;
};
const newer = changelogNewer;
const isBeta = changelogIsBeta;
const isFresh = changelogIsFresh;
// From 0.6.0 on a note shows live UI demos (older notes keep the plain page). Only a minor/major version also opens with the full-screen
// version intro: a patch version never plays one, and every minor/major gets its own new one (rules in changelog-state.ts, next to changelogPlaysIntro).
export const isRich = changelogIsRich;
const playsIntro = changelogPlaysIntro;
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// The first intro of a version the app just updated to (it has a red dot: fresh and never opened) plays to the end: a click cannot skip it, so one that lands as the window opens cannot cut it short.
const playsThrough = (version: string, opened: string[]) => playsIntro(version) && !calm() && !opened.includes(version) && isFresh(version);
// Run once at startup with the real app version (the desktop app's; the bundle's newest entry in a plain browser). True only when this launch recorded an update.
export { syncChangelogVersion };
export { changelogDue, setChangelogDue } from './changelog-state';
// Same rule as the red dots in the window: some version of the latest update has never been opened (the sidebar button shows a dot for it).
export { hasUnreadChangelog } from './changelog-meta';

// The version as one box per character: the intro animates them in one after another, the header copy lays out the same boxes so the intro lands exactly on it.
const Letters = ({ text }: { text: string }) => <>{[...text].map((char, index) => <span key={index} style={{ '--i': index } as CSSProperties}>{char}</span>)}</>;

// The sidebar lists the versions; one version is shown at a time. A version never opened gets a red dot; opening it clears the dot. Closing the window still marks the latest version as seen for the 새 소식 tag.
// A minor/major version from 0.6.0 on first plays its intro: the version fills the screen, shrinks a little, then travels to the header slot while the page below builds up.
export function Changelog({ onClose }: { onClose(): void }) {
  const seen = seenVersion();
  const [selected, setSelected] = useState(entries[0]?.version);
  const [viewed, setViewed] = useState<string[]>(readViewed);
  const entry = entries.find(item => item.version === selected) ?? entries[0];
  const rich = Boolean(entry && isRich(entry.version)), hasIntro = Boolean(entry && playsIntro(entry.version)), intro = hasIntro ? entry?.intro : undefined;
  const [phase, setPhase] = useState<'intro' | 'page'>(() => hasIntro && !calm() ? 'intro' : 'page'), [locked, setLocked] = useState(() => Boolean(entry) && playsThrough(entry.version, viewed));
  // The intro's version sits on the header slot it ends on (`--hx`, `--hy`); `--t0` moves it big to the middle, `--t1` a little smaller.
  const [hero, setHero] = useState<CSSProperties>();
  const slot = useRef<HTMLSpanElement>(null);
  const isNew = (version: string) => !viewed.includes(version) && isFresh(version);
  // Opening a version (including the one shown first) marks it viewed, so its red dot goes away. Picking another version replays its intro (not the one already open).
  const view = (version: string) => {
    if (version !== selected) { setSelected(version); setHero(undefined); setPhase(playsIntro(version) && !calm() ? 'intro' : 'page'); setLocked(playsThrough(version, viewed)); }
    setViewed(previous => { if (previous.includes(version)) return previous; const next = [...previous, version]; writeViewed(next); return next; });
  };
  useEffect(() => { if (entry) view(entry.version); }, [entry?.version]);
  // An effect, not a layout effect: the dialog opens in Modal's effect, and a closed dialog has no boxes to measure.
  useEffect(() => {
    if (phase !== 'intro' || !slot.current) return;
    const box = slot.current.getBoundingClientRect(), width = innerWidth, height = innerHeight;
    if (!box.width || !box.height) return setPhase('page');
    const big = Math.max(1, Math.min(Math.min(width * 0.16, 200) / box.height, (width * 0.86) / box.width)), small = big * 0.6;
    const at = (scale: number) => `translate(${width / 2 - box.width * scale / 2 - box.left}px, ${height / 2 - box.height * scale / 2 - box.top}px) scale(${scale})`;
    setHero({ '--hx': `${box.left}px`, '--hy': `${box.top}px`, '--t0': at(big), '--t1': at(small), '--tag-top': `${height / 2 + box.height * big / 2 + 26}px` } as CSSProperties);
    // Never leave the screen on the intro if its animation does not report back.
    const fallback = setTimeout(() => setPhase('page'), 4500);
    return () => clearTimeout(fallback);
  }, [phase, entry?.version]);
  const skip = () => setPhase('page');
  const leave = () => { if (entries[0]) markChangelogSeen(entries[0].version); onClose(); };
  // Esc first cuts the intro short (also the one a click cannot skip), then closes.
  const dismiss = () => phase === 'intro' ? skip() : leave();
  let order = 0; // position of each note on the page: the notes rise in one after another (--i), capped so a long version does not take long to settle
  return <Modal className="changelog" labelledBy="changelog-title" onClose={dismiss} region="변경 내역">
    <h2 id="changelog-title" className="changelog-title">변경 내역</h2><button className="icon-btn changelog-close" aria-label="닫기" onClick={leave}><Icon name="x" size={16} /></button>
    <div className="changelog-main" data-rich={rich ? '' : undefined} data-phase={phase} style={{ '--intro-hue': intro?.hue ?? 268 } as CSSProperties}>
      <nav className="changelog-nav" aria-label="버전">
        {entries.map((item, index) => {
          const beta = isBeta(item.version), base = item.version.split('-')[0];
          // The betas of one version hang under one "v0.6.3 beta" row as v3, v2, v1 (newest first); the full version still heads the page.
          const first = beta && !(index && isBeta(entries[index - 1].version) && entries[index - 1].version.split('-')[0] === base);
          return <Fragment key={item.version}>
            {first && <div className="changelog-nav-group"><span className="changelog-nav-version">v{base}</span><span className="changelog-nav-tag">beta</span></div>}
            <button aria-pressed={item.version === entry?.version} data-read={!isNew(item.version)} data-beta={beta || undefined} onClick={() => view(item.version)}>
              <span className="changelog-nav-version">{beta ? `v${/\d+$/.exec(item.version)?.[0]}` : `v${item.version}`}</span><time className="changelog-nav-date" dateTime={item.date} title={item.time ? `${item.date} ${item.time}` : undefined}>{item.time ? ago(item.date, item.time) : item.date}</time>{isNew(item.version) && <span className="changelog-new-dot" role="img" aria-label="한 번도 보지 않은 버전" />}
            </button>
          </Fragment>;
        })}
      </nav>
      <div className="changelog-body">
        {entry && <section key={entry.version} className="changelog-entry" data-rich={rich ? '' : undefined} data-beta={isBeta(entry.version) ? '' : undefined} aria-label={`v${entry.version}`}>
          <h3><span className="changelog-version" ref={slot}>{rich ? <Letters text={`v${entry.version}`} /> : `v${entry.version}`}</span>{isBeta(entry.version) && <span className="changelog-beta">BETA</span>}{seen && newer(entry.version, seen) && <span className="changelog-new">새 소식</span>}<time>{entry.time ? `${entry.date} ${entry.time}` : entry.date}</time></h3>
          {phase === 'page' && <>
            {intro?.tagline && <p className="changelog-tagline">{intro.tagline}</p>}
            <p className="changelog-summary">{groups(entry).map(group => <span key={group.kind} data-kind={group.kind}>{group.kind} <b>{group.items.length}</b></span>)}</p>
            {groups(entry).map(group => <div key={group.kind} className="changelog-group" data-kind={group.kind}>
              <h4>{group.kind}<small>{group.items.length}</small></h4>
              <ul>{group.items.map(item => {
                const demo = rich ? item.demo : undefined;
                return <li key={item.title} style={{ '--i': Math.min(order++, 10) } as CSSProperties} data-kind={item.kind} data-image={!rich && item.image ? '' : undefined} data-demo={demo ? '' : undefined} data-wide={demo && demoWide(demo) ? '' : undefined}>
                  <Icon name={(item.icon ?? 'sparkles') as Parameters<typeof Icon>[0]['name']} size={18} />
                  <div><strong>{item.title}</strong><p>{item.text}</p>{demo && <ChangelogDemo name={demo} />}{!rich && item.image && <img src={`/changelog/${item.image}`} alt={item.title} loading="lazy" />}</div>
                </li>;
              })}</ul>
            </div>)}
          </>}
        </section>}
      </div>
      {hasIntro && phase === 'intro' && entry && <div className="changelog-intro" data-locked={locked || undefined} onClick={locked ? undefined : skip} aria-hidden="true">
        <div className="changelog-intro-bg" />
        {hero && <>
          <div className="changelog-hero" style={hero} onAnimationEnd={event => { if (event.target === event.currentTarget) setPhase('page'); }}><Letters text={`v${entry.version}`} /></div>
          {intro?.tagline && <p className="changelog-intro-tagline" style={hero}>{intro.tagline}</p>}
        </>}
      </div>}
    </div>
  </Modal>;
}
