// Claude Code as a headless child: `claude -p` with stream-json in and out. The official binary is only spawned; its login,
// tokens and model calls stay entirely inside it. This file turns its JSONL into the events the chat tab draws.
// Control-request shapes follow the Agent SDK's stdio protocol; tests/fixtures/claude-stream.jsonl (scripts/record-claude-stream.mjs)
// is the real capture they should be checked against. Anything not recognised passes through as `raw`.

import { cleanChatTitle } from "./chat-title.js";

const titleEvent = (source, text) => {
  const cleaned = cleanChatTitle(text);
  return cleaned ? [{ kind: "title", source, text: cleaned }] : [];
};

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
];
export const cliPermissionMode = (mode) =>
  !mode || mode === "default" ? "manual" : mode;
export const uiPermissionMode = (mode) =>
  mode === "manual" || mode === "defaultMode" ? "default" : mode;
// A plan answered with feedback: the model reads this as the tool error, so say what to do with it.
export const planRevision = (feedback) => `The user rejected this plan and asks for changes. Stay in plan mode, revise the plan to address the feedback, and present it again.\n\nUser feedback:\n${feedback}`;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"]; // `claude --effort`

export const validMessageUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
// `resumeAt` + `fork` start a new session holding the old one only up to that assistant message (Branch, Rewind); the old session stays untouched.
export function buildClaudeArgs({
  sessionId,
  model,
  effort,
  worktree,
  addDirs,
  permissionMode,
  settingsFile,
  mcpFile,
  promptFile,
  resumeAt,
  fork,
} = {}) {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-prompts",
    "host",
    "--permission-prompt-tool",
    "stdio",
    "--allow-dangerously-skip-permissions",
    "--replay-user-messages",
  ]; // echoes a queued (steering) message back with its uuid once the turn takes it in
  if (sessionId) {
    args.push("--resume", sessionId);
    if (validMessageUuid(resumeAt)) args.push("--resume-session-at", resumeAt);
    if (fork) args.push("--fork-session");
  }
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  // A new session can start in its own git worktree; a resumed one re-enters the worktree it was created in.
  if (worktree && !sessionId) args.push("--worktree");
  if (addDirs?.length) args.push("--add-dir", ...addDirs);
  // Only a mode the user picked in this chat is passed. Left out, the CLI follows its own settings (defaultMode), like a plain `claude`.
  // The CLI's own name for "ask me" is `manual` (its init event reports it as `default`).
  if (permissionMode) args.push("--permission-mode", cliPermissionMode(permissionMode));
  if (settingsFile) args.push("--settings", settingsFile);
  if (mcpFile) args.push("--mcp-config", mcpFile);
  if (promptFile) args.push("--append-system-prompt-file", promptFile);
  return args;
}

// One stdin line for a user turn. `images` are { mime, data(base64) }.
export function userLine(text, images = [], uuid) {
  const content = [
    ...images.map(({ mime, data }) => ({
      type: "image",
      source: { type: "base64", media_type: mime, data },
    })),
    { type: "text", text },
  ];
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content },
      ...(uuid && { uuid }),
    }) + "\n"
  );
}
// The Artifact tools cost ~12.9k tokens per request (measured, claude 2.1.322) and `claude -p` leaves them off, so a chat turns them on only
// once the user asks for one (or the setting says always). Starting a turn that mentions it is enough; the CLI takes the env from a flag-settings update.
export const wantsArtifact = (text) => /artifact|아티팩트/i.test(text);
export const ARTIFACT_FLAG_SETTINGS = { env: { CLAUDE_CODE_ARTIFACT: "1" } };
export const controlLine = (requestId, request) =>
  JSON.stringify({ type: "control_request", request_id: requestId, request }) +
  "\n";
// AskUserQuestion: the CLI asks its host to put 1-4 questions to the user (each with a header, 2-4 options with descriptions, optionally multi-select).
// They become the same `questions` every agent's question uses. The user may always type an answer of their own ("Other" in the CLI).
export function claudeQuestions(input) {
  if (!Array.isArray(input?.questions)) return null;
  const questions = input.questions.slice(0, 8).flatMap((item, index) => {
    if (!item || typeof item.question !== "string" || !item.question.trim()) return [];
    const options = (Array.isArray(item.options) ? item.options : []).slice(0, 16).flatMap((option) =>
      typeof option?.label === "string" && option.label
        ? [{ id: option.label, label: option.label, ...(typeof option.description === "string" && option.description && { description: option.description }) }]
        : [],
    );
    return [{ id: `q${index}`, prompt: item.question, ...(typeof item.header === "string" && item.header && { header: item.header }), allowMultiple: item.multiSelect === true, allowOther: true, options }];
  });
  return questions.length ? questions : null;
}
// The answer goes back inside the tool input: { answers: { "<question text>": "<label, or labels joined with ', ', or the user's own text>" } }.
export const askUserInput = (input, questions, answers) => ({
  ...input,
  answers: Object.fromEntries(questions.map((question) => [question.prompt, (answers[question.id] ?? []).join(", ")])),
});
export const ASK_SKIPPED = "The user chose not to answer these questions. Do not ask them again right away: continue with your best judgment, or ask in plain text if you cannot proceed without an answer.";
export function approvalLine(
  requestId,
  { allow, input, message, suggestions, mode },
) {
  const response = allow
    ? {
        behavior: "allow",
        updatedInput: input ?? {},
        ...((suggestions?.length || mode) && { updatedPermissions: [...(suggestions ?? []), ...(mode ? [{ type: "setMode", mode: cliPermissionMode(mode), destination: "session" }] : [])] }),
      }
    : { behavior: "deny", message: message || "사용자가 거부했습니다." };
  return (
    JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    }) + "\n"
  );
}

const blocks = (content) =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content
      : [];
const usageOf = (usage) =>
  usage
    ? {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreate: usage.cache_creation_input_tokens ?? 0,
      }
    : null;

const compactEvent = (meta, at) => ({
  kind: "compact",
  trigger: meta?.trigger === "auto" ? "auto" : "manual",
  preTokens: Number.isFinite(meta?.pre_tokens ?? meta?.preTokens) ? (meta.pre_tokens ?? meta.preTokens) : null,
  postTokens: Number.isFinite(meta?.post_tokens ?? meta?.postTokens) ? (meta.post_tokens ?? meta.postTokens) : null,
  ...(at && { at }),
});

const TASK_PHASES = { task_started: "start", task_progress: "progress", task_notification: "end" };
function taskEvent(raw) {
  const phase = TASK_PHASES[raw.subtype], usage = raw.usage ?? {};
  return {
    kind: "task",
    phase,
    toolUseId: raw.tool_use_id,
    ...(phase === "start" && { description: raw.description ?? "", agentType: raw.subagent_type ?? "", background: raw.is_backgrounded === true }),
    // A progress `description` is what it is doing now ("Running …"), not its name.
    ...(phase === "progress" && { activity: raw.description ?? "", lastTool: raw.last_tool_name ?? "" }),
    ...(phase === "end" && { status: raw.status ?? "completed", report: String(raw.handback_report?.text ?? raw.summary ?? "").slice(0, 64_000) }),
    ...(Number.isFinite(usage.total_tokens) && { tokens: usage.total_tokens, toolUses: usage.tool_uses ?? 0, durationMs: usage.duration_ms ?? 0 }),
  };
}

// What a local slash command printed (/compact, /context, /cost, /mcp, ...): the CLI echoes it as a user message wrapped in these tags.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const LOCAL_OUTPUT = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g;
export function localCommandOutput(text) {
  if (typeof text !== "string" || !text.includes("<local-command-")) return [];
  return [...text.matchAll(LOCAL_OUTPUT)].flatMap((match) => {
    const output = match[2].replace(ANSI, "").replace(/\r\n?/g, "\n").trim().slice(0, 64_000);
    return output || match[1] === "stdout" ? [{ kind: "command_output", text: output, isError: match[1] === "stderr" }] : [];
  });
}
const textOf = (content) =>
  blocks(content)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

// raw JSON object from stdout -> list of events. `delta` events are live-only; the rest are stored in the transcript.
export function normalizeClaude(raw) {
  if (!raw || typeof raw !== "object") return [];
  if (raw.type === "custom-title" && raw.customTitle) return titleEvent("custom", raw.customTitle);
  if (raw.type === "ai-title" && raw.aiTitle) return titleEvent("ai", raw.aiTitle);
  if (raw.type === "system" && raw.subtype === "init") {
    return [
      {
        kind: "session",
        sessionId: raw.session_id,
        model: raw.model,
        permissionMode: raw.permissionMode,
        cwd: raw.cwd,
        tools: Array.isArray(raw.tools) ? raw.tools : [],
        slashCommands: Array.isArray(raw.slash_commands)
          ? raw.slash_commands
          : [],
      },
    ];
  }
  // The CLI reports no thinking text for current models, only a running token estimate; it is the one "what is it doing" signal there is.
  if (raw.type === "system" && raw.subtype === "thinking_tokens")
    return Number.isFinite(raw.estimated_tokens)
      ? [
          {
            kind: "delta",
            phase: "thinkingTokens",
            tokens: raw.estimated_tokens,
          },
        ]
      : [];
  // /compact and auto compact: the CLI says when it starts and ends (status), then reports the boundary with the sizes before and after.
  if (raw.type === "system" && raw.subtype === "status" && (raw.status === "compacting" || raw.compact_result))
    return [{ kind: "delta", phase: "compacting", active: raw.status === "compacting" }];
  if (raw.type === "system" && raw.subtype === "compact_boundary")
    return [compactEvent(raw.compact_metadata)];
  // A subagent (Agent/Task call) started, made progress (live only) or ended. Keyed by its Agent call's tool_use id, which the pane tracks it by.
  if (raw.type === "system" && TASK_PHASES[raw.subtype] && typeof raw.tool_use_id === "string")
    return [taskEvent(raw)];
  if (raw.type === "stream_event") {
    // Every live event names its subagent (null for the main thread), so the server can keep parallel streams apart.
    const event = raw.event ?? {},
      parentToolUseId = raw.parent_tool_use_id ?? null;
    if (event.type === "message_start") {
      const started = [
        {
          kind: "delta",
          phase: "start",
          messageId: event.message?.id,
          parentToolUseId,
        },
      ];
      const usage = usageOf(event.message?.usage);
      if (
        usage &&
        (usage.input || usage.output || usage.cacheRead || usage.cacheCreate)
      )
        started.push({ kind: "delta", phase: "usage", usage, parentToolUseId });
      return started;
    }
    if (event.type === "message_delta") {
      const usage = usageOf(event.usage);
      if (
        usage &&
        (usage.input || usage.output || usage.cacheRead || usage.cacheCreate)
      )
        return [{ kind: "delta", phase: "usage", usage, parentToolUseId }];
      return [];
    }
    if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta")
        return [
          {
            kind: "delta",
            phase: "text",
            index: event.index,
            text: event.delta.text,
            parentToolUseId,
          },
        ];
      if (event.delta?.type === "thinking_delta")
        return [
          {
            kind: "delta",
            phase: "thinking",
            index: event.index,
            text: event.delta.thinking,
            parentToolUseId,
          },
        ];
      // A tool's input arrives as JSON pieces; the card shows the command or path from them before the call is complete.
      if (event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string" && event.delta.partial_json)
        return [
          {
            kind: "delta",
            phase: "toolInput",
            index: event.index,
            text: event.delta.partial_json,
            parentToolUseId,
          },
        ];
    }
    if (
      event.type === "content_block_start" &&
      event.content_block?.type === "tool_use"
    ) {
      return [
        {
          kind: "delta",
          phase: "tool",
          index: event.index,
          id: event.content_block.id,
          name: event.content_block.name,
          parentToolUseId,
        },
      ];
    }
    return [];
  }
  if (raw.type === "assistant") {
    const message = raw.message ?? {};
    return [
      {
        kind: "message",
        role: "assistant",
        id: message.id ?? raw.uuid,
        ...(typeof raw.uuid === "string" && { uuid: raw.uuid }),
        model: message.model,
        parentToolUseId: raw.parent_tool_use_id ?? null,
        blocks: blocks(message.content).map((block) =>
          block.type === "tool_use"
            ? {
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: block.input,
              }
            : block.type === "thinking"
              ? { type: "thinking", text: block.thinking ?? "" }
              : block.type === "text"
                ? { type: "text", text: block.text ?? "" }
                : { type: "other", original: block.type },
        ),
        usage: usageOf(message.usage),
      },
    ];
  }
  if (raw.type === "user") {
    // Tool results come back as user messages; plain user text is already recorded by the server when it is sent. A local command's output is kept.
    const content = raw.message?.content;
    return blocks(content)
      .filter((block) => block.type === "tool_result")
      .map((block) => ({
        kind: "tool_result",
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        content:
          typeof block.content === "string"
            ? block.content
            : blocks(block.content)
                .map((part) =>
                  part.type === "text" ? part.text : `[${part.type}]`,
                )
                .join("\n"),
      }))
      .concat(localCommandOutput(textOf(content)));
  }
  if (raw.type === "result") {
    return [
      {
        kind: "result", // An interrupt ends the turn with is_error and terminal_reason `aborted_*`; that is the user's own stop, not a failure.
        status: !raw.is_error
          ? "success"
          : /^aborted/.test(raw.terminal_reason ?? "")
            ? "interrupted"
            : "failed",
        text: typeof raw.result === "string" ? raw.result : "",
        sessionId: raw.session_id,
        costUsd: raw.total_cost_usd ?? null,
        usage: usageOf(raw.usage),
        contextWindow:
          Object.values(raw.modelUsage ?? {})
            .map((item) => item?.contextWindow)
            .find(Number.isFinite) ?? null,
        durationMs: raw.duration_ms ?? null,
        turns: raw.num_turns ?? null,
      },
    ];
  }
  if (
    raw.type === "control_request" &&
    raw.request?.subtype === "can_use_tool"
  ) {
    const request = raw.request;
    const questions = request.tool_name === "AskUserQuestion" ? claudeQuestions(request.input) : null;
    return [
      {
        kind: "approval",
        phase: "request",
        requestId: raw.request_id,
        tool: request.tool_name,
        input: request.input ?? {},
        ...(questions && { questions }),
        toolUseId: request.tool_use_id,
        suggestions: Array.isArray(request.permission_suggestions)
          ? request.permission_suggestions
          : [],
      },
    ];
  }
  if (raw.type === "control_cancel_request")
    return [{ kind: "approval", phase: "cancel", requestId: raw.request_id }];
  if (raw.type === "control_response" || raw.type === "keep_alive") return [];
  return [{ kind: "raw", original: raw.type ?? null }];
}

// Claude Code's own transcript (<config>/projects/<slug>/<session>.jsonl) -> the events a chat stores, so a terminal conversation can continue as a chat.
// Assistant and tool_result lines already have the stream-json shape. Skipped: subagent lines, meta/compact-summary users, hook/command noise.
// ponytail: abandoned branches of the transcript tree (after a CLI rewind) are not pruned; walk parentUuid from the last line if that shows up.
const NOISE =
  /^<(?:local-command-caveat|local-command-stdout|system-reminder|command-message)\b/;
export function transcriptEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    } // torn first line of a tail, or a line being written
    if (!raw || raw.isSidechain) continue;
    const at = Date.parse(raw.timestamp) || undefined;
    if (raw.type === "custom-title" && raw.customTitle) {
      events.push(...titleEvent("custom", raw.customTitle).map(event => ({ ...event, at })));
      continue;
    }
    if (raw.type === "ai-title" && raw.aiTitle) {
      events.push(...titleEvent("ai", raw.aiTitle).map(event => ({ ...event, at })));
      continue;
    }
    if (raw.type === "system" && raw.subtype === "compact_boundary")
      events.push(compactEvent(raw.compactMetadata, at));
    else if (raw.type === "assistant")
      for (const event of normalizeClaude(raw)) events.push({ ...event, at });
    else if (raw.type === "user" && !raw.isMeta && !raw.isCompactSummary) {
      const parts = blocks(raw.message?.content),
        results = normalizeClaude(raw);
      if (results.length) {
        for (const event of results) events.push({ ...event, at });
        continue;
      }
      const command = textOf(raw.message?.content).trim();
      const name = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(
          command,
        )?.[1],
        args = /<command-args>([^<]*)<\/command-args>/
          .exec(command)?.[1]
          ?.trim();
      const shown = name ? `${name} ${args ?? ""}`.trim() : command;
      if (shown && !NOISE.test(shown))
        events.push({
          kind: "user",
          text: shown,
          images: parts.filter((part) => part.type === "image").length,
          at,
        });
    }
  }
  return events;
}
