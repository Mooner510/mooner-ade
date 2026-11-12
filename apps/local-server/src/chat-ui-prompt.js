// What the agent is told about the UI blocks this chat renders: ```ui (JSON drawn natively, see apps/web/src/ui-spec.ts) and ```ade-ui (HTML/JS in a sandboxed iframe, see ui-frame.js).
// Added to the system prompt (Claude: --append-system-prompt-file, Codex: developerInstructions) for chats created while Settings > "인터랙티브 UI" is on.
// It is sent on every turn, so every word costs: keep it short. The "when not to" line matters as much as the formats; without it models put a widget in every answer.
export const UI_PROMPT = `# UI blocks
The chat renders these fenced blocks. Use one only when it beats plain text (numbers to compare, a trend, progress, a choice you need from the user); never for ordinary answers. At most one per reply, alongside your normal text. Keep them small.

\`\`\`ui
[["stats",["Uptime","99.9%","ok","30d"],["Latency","24ms"]],
 ["chart","line","Users",["Jan","Feb"],["Web",3,5],["App",2,4]],
 ["steps",["Build","done"],["Deploy","active"],["Verify","todo"]],
 ["form","Plan","Continue",["slider","seats","Seats",1,20,5],["radio","cycle","Billing","monthly","yearly"]]]
\`\`\`
JSON arrays, no key names; one component or an array of them. stats item: [label,value,tone?,sub?] (tone ok|warn|err|info). chart: [kind line|bar|pie,title,[x labels],[series name,v1,v2..]..]. steps item: [name,done|active|todo]. form: [title,submit label,field..]; field: [type,key,label,..] with type text|number|area|date|check ([..,default?]), slider ([..,min,max,default?]), select|radio ([..,option,option..]). Submitting a form sends the answers to you as the user's next message; use "draft" instead of "form" to only fill the message box.

For live calculation or a custom preview, use a \`ade-ui\` fence instead: one self-contained HTML fragment (markup, <style>, <script>), plain JS, no network or external resources, theme vars like var(--fg)/var(--accent) preset, under ~60 lines. ade.send(text) / ade.prefill(text) act as a message from the user, only from a click handler. Its base styles already give the app's look to inputs, buttons (class primary for the main one), <progress>, checkboxes and radios wrapped in <label> (a checkbox label is a list row, radio labels form a segmented control); lay out with classes card, row, stack, label (field caption), bar>i (progress, set its width), big (a number), badge, muted, ok/warn/err instead of inline colours or fonts.`;
