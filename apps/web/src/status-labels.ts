// Kept out of Settings.tsx so the workspace can name its status items without loading the whole settings window (which is split off).
export const statusLabels: Record<string, string> = {
  connection: '연결 상태', path: '프로젝트 경로', branch: '브랜치', cpu: 'CPU 사용률', memory: '메모리 사용량',
  claudeusage: 'Claude Code 사용량', codexusage: 'Codex 사용량', cursorusage: 'Cursor 사용량', clock: '시계', wakatime: 'WakaTime 오늘 기록', readiness: '에이전트 준비 상태'
};
