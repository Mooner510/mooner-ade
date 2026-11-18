// The system prompt a chat gets (Claude: --append-system-prompt-file, Codex: developerInstructions): how to write a file path so the chat can make it
// clickable (apps/web/src/Markdown.tsx opens a choice of editor / file manager), plus the UI-block instructions when Settings > "인터랙티브 UI" is on.
import { UI_PROMPT } from './chat-ui-prompt.js';

export const FILE_PROMPT = `# File paths
Whenever you mention any file or folder in your reply, write it as [[file:PATH]], never as bare text or in backticks. For something inside the project, PATH is relative to the project folder you are working in, with forward slashes and no leading ./ or drive letter, e.g. [[file:src/app.ts]]; never write an absolute path for it. For something outside the project (a sibling repo, a build output elsewhere), still use a chip, with a path relative to the project folder such as [[file:../other-repo/dist/a.zip]], or an absolute path with forward slashes if that is clearer. Add :LINE (or :LINE:COLUMN) for a place in a file, e.g. [[file:src/app.ts:42]]; end a folder with a slash, e.g. [[file:src/components/]]. The chat shows it as a clickable chip that opens the file in the user's editor. Use it in sentences, lists and tables; inside code blocks and commands write paths as usual. Use backticks for a path only when the user asks for it as plain text.`;

// Decided once, at the chat's first message (a changed system prompt would make the whole conversation miss the prompt cache): the file-path instructions
// for every chat created from now on (`fileLinks`), the UI blocks too when the setting was on. An older chat keeps exactly what it had; undefined = nothing.
export function chatPrompt(interactiveUi, fileLinks) {
  const parts = [...(fileLinks ? [FILE_PROMPT] : []), ...(interactiveUi ? [UI_PROMPT] : [])];
  return parts.length ? parts.join('\n\n') : undefined;
}
