// The system prompt a chat gets (Claude: --append-system-prompt-file, Codex: developerInstructions): how to write a file path so the chat can make it
// clickable (apps/web/src/Markdown.tsx opens a choice of editor / file manager), plus the UI-block instructions when Settings > "인터랙티브 UI" is on.
import { UI_PROMPT } from './chat-ui-prompt.js';

export const FILE_PROMPT = `# File paths
Whenever you mention any file or folder in your reply, write it as [[file:PATH]], never as bare text or in backticks. For something inside the project, PATH is relative to the project folder you are working in, with forward slashes and no leading ./ or drive letter, e.g. [[file:src/app.ts]]; never write an absolute path for it. For something outside the project (a sibling repo, a build output elsewhere), still use a chip, with a path relative to the project folder such as [[file:../other-repo/dist/a.zip]], or an absolute path with forward slashes if that is clearer. Add :LINE (or :LINE:COLUMN) for a place in a file, e.g. [[file:src/app.ts:42]]; end a folder with a slash, e.g. [[file:src/components/]]. The chat shows it as a clickable chip that opens the file in the user's editor. Use it in sentences, lists and tables; inside code blocks and commands write paths as usual. Use backticks for a path only when the user asks for it as plain text.`;

const CODEX_QUESTION_PROMPT = `# Required user input
Whenever an action requires the user's approval or a decision only the user can make, you MUST ask as soon as you identify the need. Use request_user_input_async whenever it is available, including for a single yes/no question. This rule takes precedence over the UI block guidance for these questions. If the async tool is unavailable, ask the user directly through an available question tool or in chat.
Wait for an explicit answer before taking any action that depends on it. Silence is never approval. While waiting, continue any independent work that does not require the answer.`;

export const MEDIA_PROMPT = `# Inline media in ADE Chat
When the user asks to see a screenshot, photo or video, put each result in a closed \`ade-media\` code fence containing one JSON object, e.g. {"type":"image","src":"screenshots/home.png","alt":"Home screen"}. Use type "video" for MP4 or WebM and type "image" for PNG, JPEG, GIF, WebP or AVIF. Local media must be inside the chat's working folder. Save or copy requested output there if needed, and prefer a relative path. For a photo search, use available search tools and put the direct HTTPS image URL in src. Include the source page as a separate Markdown link. Link to the webpage when only a webpage URL is available.`;

// Prompt features are pinned when a chat starts so a resume can reuse its prompt cache.
export function chatPrompt(interactiveUi, fileLinks, agent, mediaBlocks) {
  const parts = [...(agent === 'codex' ? [CODEX_QUESTION_PROMPT] : []), ...(fileLinks ? [FILE_PROMPT] : []), ...(interactiveUi ? [UI_PROMPT] : []), ...(mediaBlocks ? [MEDIA_PROMPT] : [])];
  return parts.length ? parts.join('\n\n') : undefined;
}
