import type { CSSProperties } from 'react';
import { Icon } from './Icon';
import { ideIcon, ideMark, type IdeInfo } from './ide-open';

// IDE 아이콘: JetBrains 제품은 모두 같은 "F" 글리프라 구분이 안 되어, 제품별 두 글자와 색으로 그린다(나머지는 기존 아이콘).
export function IdeIcon({ ide, size = 14 }: { ide: Pick<IdeInfo, 'id' | 'kind' | 'label'>; size?: number }) {
  const mark = ide.kind === 'jetbrains' ? ideMark(ide.label) : null;
  if (!mark) return <Icon name={ideIcon(ide)} size={size} />;
  const box = size + 4;
  // a JetBrains product icon: gradient square, black square in front (CSS ::before), white letters and bar (::after)
  if (mark.gradient) return <span className="ide-mark jb" aria-hidden="true" style={{ '--jb': mark.gradient, width: box, height: box, fontSize: box * 0.38 } as CSSProperties}><span>{mark.text}</span></span>;
  return <span className="ide-mark" aria-hidden="true" style={{ background: mark.color, color: mark.ink, width: box, height: box, fontSize: Math.max(7, size - 5) }}>{mark.text}</span>;
}
