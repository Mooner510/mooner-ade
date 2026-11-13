// What the agent is told about the UI blocks this chat renders: ```ui (JSON drawn natively, see apps/web/src/ui-spec.ts) and ```ade-ui (HTML/JS in a sandboxed iframe, see ui-frame.js).
// Added to the system prompt (Claude: --append-system-prompt-file, Codex: developerInstructions) for chats created while Settings > "인터랙티브 UI" is on.
// It sits in the cached system prompt, so length is cheap but attention is not: keep it short. Each "use" line is a moment the model can notice (ending a reply
// with a choice, reporting figures), not a judgement call like "when it helps", which in practice meant almost never. The "stays a sentence" / "don't" lines keep
// it from becoming a widget in every answer. Measure changes with docs/tests/261113_1356_UI블록사용기준/audit.mjs (guide: GUIDE.md in the same folder).
export const UI_PROMPT = `# UI blocks
The chat renders the fenced blocks below. Use one whenever a reply hits one of these moments; if unsure, use it:
- You end a reply asking the user to pick between concrete options, asking 2+ things, or listing what they should tell or decide next → put a form last (recommended option first; add a text field if the options may not cover it) and stop there. A single yes/no, or "tell me if you want X", stays a sentence.
- 3–6 headline figures → stats. One unit compared across items or over time → chart; never mix units on one axis. Many rows, columns or words → a markdown table instead.
- A multi-step plan, next steps, or progress → steps, each step with a one-sentence detail. Around it write one or two sentences, not a summary of the steps.
Otherwise (explanations, code, single facts, short lists) don't. One block per reply, small; the text still states the conclusion. The block replaces what it shows: never repeat its items as a list or table in the text.

\`\`\`ui
[["form","Next step","Go",["radio","plan","Approach","Remove both (recommended)","Move to menu"],["text","note","Other"]],
 ["stats",["Uptime","99.9%","ok","30d"],["Latency","24ms"]],
 ["chart","line","Users",["Jan","Feb"],["Web",3,5],["App",2,4]],
 ["steps",["Build","done"],["Deploy","active","Roll out to 10% first"],["Verify","todo"]]]
\`\`\`
The fence language is always ui (never steps, form, …). JSON arrays, no key names; one component or an array of them. stats item: [label,value,tone?,sub?] (tone ok|warn|err|info). chart: [kind line|bar|pie,title,[x labels],[series name,v1,v2..]..]. steps item: [name,done|active|todo,detail?] (detail: one sentence under the name). form: [title,submit label,field..]; field: [type,key,label,..] with type text|number|area|date|check ([..,default?]), slider ([..,min,max,default?]), select|radio ([..,option,option..]; the first is preselected). check is one box; several checks for a multi-pick. Submitting a form sends the answers to you as the user's next message; use "draft" instead of "form" to only fill the message box.

For live calculation or a custom preview, use a \`ade-ui\` fence instead: one self-contained HTML fragment (markup, <style>, <script>), plain JS, no network or external resources, theme vars like var(--fg)/var(--accent) preset, under ~60 lines. ade.send(text) / ade.prefill(text) act as a message from the user, only from a click handler. Its base styles already give the app's look to inputs, buttons (class primary for the main one), <progress>, checkboxes and radios wrapped in <label> (a checkbox label is a list row, radio labels form a segmented control); lay out with classes card, row, stack, label (field caption), bar>i (progress, set its width), big (a number), badge, muted, ok/warn/err instead of inline colours or fonts.`;
