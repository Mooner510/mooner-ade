// The system prompt a chat gets (Claude: --append-system-prompt-file, Codex: developerInstructions): how to write a file path so the chat can make it
// clickable (apps/web/src/Markdown.tsx opens a choice of editor / file manager), plus the UI-block instructions when Settings > "인터랙티브 UI" is on.
import { UI_PROMPT } from './chat-ui-prompt.js';

export const FILE_PROMPT = `# File paths
Whenever you mention a file or folder of this project in your reply, write it as [[file:PATH]], never as bare text or in backticks. PATH is relative to the project folder you are working in, with forward slashes and no leading ./ or drive letter, e.g. [[file:src/app.ts]]. Add :LINE (or :LINE:COLUMN) for a place in a file, e.g. [[file:src/app.ts:42]]; end a folder with a slash, e.g. [[file:src/components/]]. The chat shows it as a clickable chip that opens the file in the user's editor. Use it in sentences, lists and tables; inside code blocks and commands write paths as usual. Never write an absolute path for something inside the project. A file outside the project stays in backticks.`;

// Decided once, at the chat's first message (a changed system prompt would make the whole conversation miss the prompt cache): the file-path instructions
// for every chat created from now on (`fileLinks`), the UI blocks too when the setting was on. An older chat keeps exactly what it had; undefined = nothing.
export function chatPrompt(interactiveUi, fileLinks) {
  const parts = [...(fileLinks ? [FILE_PROMPT] : []), ...(interactiveUi ? [UI_PROMPT] : [])];
  return parts.length ? parts.join('\n\n') : undefined;
}
