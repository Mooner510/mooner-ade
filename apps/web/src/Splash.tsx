import { useEffect, useState } from 'react';

// The app icon (apps/desktop/assets/icon.svg), split into parts the splash animates one by one.
export function Logo({ size = 96 }: { size?: number }) {
  return <svg className="logo" width={size} height={size} viewBox="64 64 896 896" aria-hidden="true">
    <defs>
      <linearGradient id="logo-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#23262c" /><stop offset="1" stopColor="#0c0d0f" /></linearGradient>
      <linearGradient id="logo-moon" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stopColor="#9ae6f8" /><stop offset="0.55" stopColor="#5ec8e5" /><stop offset="1" stopColor="#2fb3d6" /></linearGradient>
      <mask id="logo-crescent"><rect width="1024" height="1024" fill="#fff" /><circle cx="560" cy="370" r="225" fill="#000" /></mask>
    </defs>
    <rect className="logo-tile" x="64" y="64" width="896" height="896" rx="212" fill="url(#logo-bg)" stroke="#ffffff14" strokeWidth="3" />
    <circle className="logo-moon" cx="415" cy="440" r="265" fill="url(#logo-moon)" mask="url(#logo-crescent)" />
    <g className="logo-prompt" fill="none" stroke="#e4e6ea" strokeWidth="58" strokeLinecap="round" strokeLinejoin="round">
      <path d="M630 600 L720 670 L630 740" pathLength={1} /><path d="M760 775 H860" pathLength={1} />
    </g>
  </svg>;
}

// Launch animation: the icon assembles, the wordmark rises, then everything lifts away onto the app that rendered underneath.
// Click or any key skips ahead. `onDone` runs once it has faded out.
export function Splash({ onDone }: { onDone(): void }) {
  const [out, setOut] = useState(false);
  useEffect(() => {
    const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(() => setOut(true), quick ? 500 : 2000);
    const skip = () => setOut(true);
    addEventListener('keydown', skip, true);
    return () => { clearTimeout(timer); removeEventListener('keydown', skip, true); };
  }, []);
  useEffect(() => { if (!out) return; const timer = setTimeout(onDone, 700); return () => clearTimeout(timer); }, [out]);
  return <div className={`splash ${out ? 'out' : ''}`} role="presentation" onPointerDown={() => setOut(true)}>
    <div className="splash-glow" />
    <div className="splash-mark">
      <Logo size={112} />
      <h1 className="splash-word" aria-label="MoonerADE">{[...'Mooner'].map((ch, i) => <span key={i} style={{ '--i': i } as React.CSSProperties}>{ch}</span>)}<b>ADE</b></h1>
      <p className="splash-tag">AI Development Environment</p>
    </div>
  </div>;
}
