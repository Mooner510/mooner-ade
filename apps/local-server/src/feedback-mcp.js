#!/usr/bin/env node
// MCP server (stdio) that MoonerADE gives the agents it starts: `ade_feedback_draft` leaves a feedback draft about MoonerADE
// itself in the feedback inbox (feedback-store.js imports it from <dataRoot>/feedback/incoming). It can only add a draft:
// a person reviews every agent draft in the app before it can be submitted, and nothing here talks to the network.
// Usage: node feedback-mcp.js <incoming folder>
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MAX_BODY, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TITLE, imageInfo } from './feedback-store.js';
import { ADE_OVERVIEW, OVERVIEW_RULE } from './ade-overview.js';

export const TOOL = {
  name: 'ade_feedback_draft',
  description: 'MoonerADE(지금 이 에이전트를 실행 중인 데스크톱 개발 환경) 자체의 UI/UX 문제나 개선점을 발견했을 때만, 개발자에게 보낼 피드백 초안을 MoonerADE의 피드백 요청에 넣습니다. '
    + '사용자가 작업 중인 프로젝트의 버그나 할 일에는 쓰지 마세요. 초안은 사람이 검토한 뒤에만 제출됩니다. 본문은 한국어 마크다운으로 문제, 기대 동작, 개선 제안을 적으세요. '
    + `${OVERVIEW_RULE}\n\nMoonerADE 개요:\n${ADE_OVERVIEW}`,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: `한 줄 요약 (${MAX_TITLE}자 이하)` },
      body: { type: 'string', description: '마크다운 본문: 문제, 기대 동작, 개선 제안, 재현 방법' },
      imagePaths: { type: 'array', items: { type: 'string' }, description: `첨부할 PNG/JPEG 스크린샷의 절대 경로 (${MAX_IMAGES}장 이하, 장당 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 이하)` }
    },
    required: ['title', 'body'],
    additionalProperties: false
  }
};

// Writes the images first and the .json last (atomically), so the app never imports half a draft.
export async function writeDraft(incoming, { title, body, imagePaths = [] }) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('title이 필요합니다.');
  if (typeof body !== 'string' || !body.trim()) throw new Error('body가 필요합니다.');
  if (Buffer.byteLength(body) > MAX_BODY) throw new Error(`body는 ${MAX_BODY / 1024}KB 이하여야 합니다.`);
  if (!Array.isArray(imagePaths) || imagePaths.length > MAX_IMAGES || !imagePaths.every(file => typeof file === 'string' && path.isAbsolute(file))) throw new Error(`imagePaths는 절대 경로 ${MAX_IMAGES}개 이하여야 합니다.`);
  await fs.mkdir(incoming, { recursive: true, mode: 0o700 });
  const key = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`, images = [];
  try {
    for (const [index, file] of imagePaths.entries()) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error(`${file}: ${MAX_IMAGE_BYTES / 1024 / 1024}MB 이하의 파일이 아닙니다.`);
      const bytes = await fs.readFile(file), info = imageInfo(bytes);
      if (!info) throw new Error(`${file}: PNG 또는 JPEG가 아닙니다.`);
      const name = `${key}-${index + 1}.${info.ext}`;
      await fs.writeFile(path.join(incoming, name), bytes, { flag: 'wx', mode: 0o600 });
      images.push(name);
    }
    const target = path.join(incoming, `${key}.json`), tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ title: title.trim().slice(0, MAX_TITLE), body, images }), { flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (error) {
    for (const name of images) await fs.rm(path.join(incoming, name), { force: true });
    throw error;
  }
  return { key, images: images.length };
}

// Newline-delimited JSON-RPC 2.0 over stdio, the MCP stdio transport.
export function createFeedbackMcp({ incoming, write = line => process.stdout.write(`${line}\n`) }) {
  const reply = (id, result) => write(JSON.stringify({ jsonrpc: '2.0', id, result }));
  const failure = (id, code, message) => write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  return async function handle(line) {
    let message;
    try { message = JSON.parse(line); } catch { return failure(null, -32700, 'Parse error'); }
    const { id, method, params } = message ?? {};
    if (id === undefined || id === null) return; // notifications (initialized, cancelled) need no answer
    switch (method) {
      case 'initialize':
        return reply(id, { protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ade_feedback', version: '1.0.0' } });
      case 'ping': return reply(id, {});
      case 'tools/list': return reply(id, { tools: [TOOL] });
      case 'tools/call': {
        if (params?.name !== TOOL.name) return failure(id, -32602, `알 수 없는 도구입니다: ${params?.name}`);
        try {
          const result = await writeDraft(incoming, params.arguments ?? {});
          return reply(id, { content: [{ type: 'text', text: `MoonerADE 피드백 요청에 초안을 넣었습니다(이미지 ${result.images}장). 사용자가 검토한 뒤 제출합니다.` }] });
        } catch (error) {
          return reply(id, { isError: true, content: [{ type: 'text', text: `초안을 넣지 못했습니다: ${error.message}` }] });
        }
      }
      default: return failure(id, -32601, `Method not found: ${method}`);
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const incoming = process.argv[2];
  if (!incoming || !path.isAbsolute(incoming)) { process.stderr.write('usage: feedback-mcp.js <incoming folder>\n'); process.exit(2); }
  const handle = createFeedbackMcp({ incoming });
  let buffer = '', queue = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (line) queue = queue.then(() => handle(line)).catch(() => {});
    }
  });
  process.stdin.on('end', () => void queue.then(() => process.exit(0)));
}
