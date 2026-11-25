import type { McpTrust } from './Editor';

// Trusting a whole server makes its single-tool entries redundant, and an entry already covered by the list is not added twice.
export function addTrust(list: McpTrust[], entry: McpTrust): McpTrust[] {
  if (list.some(item => item.server === entry.server && (item.tool === undefined || item.tool === entry.tool))) return list;
  return [...(entry.tool === undefined ? list.filter(item => item.server !== entry.server) : list), entry];
}
export const trustLabel = (entry: McpTrust) => entry.tool === undefined ? `${entry.server}: 모든 도구` : `${entry.server}: ${entry.tool}`;
