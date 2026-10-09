import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const AGENT_EVENT_SCHEMA_VERSION = 1;

export class AdeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AdeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function envelope(channel, kind, payload, id = randomUUID()) {
  if (!/^[a-z][a-z0-9.-]*$/.test(channel) || !/^[a-z][a-z0-9.-]*$/.test(kind)) {
    throw new AdeError('INVALID_ENVELOPE', 'Invalid channel or kind');
  }
  return { v: PROTOCOL_VERSION, id, channel, kind, payload, timestamp: Date.now() };
}

export function parseEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== PROTOCOL_VERSION ||
      typeof value.id !== 'string' || !value.id || typeof value.channel !== 'string' ||
      typeof value.kind !== 'string' || !('payload' in value) ||
      !/^[a-z][a-z0-9.-]*$/.test(value.channel) || !/^[a-z][a-z0-9.-]*$/.test(value.kind)) {
    throw new AdeError('INVALID_ENVELOPE', 'Unsupported or malformed ADE message');
  }
  return value;
}

const eventKinds = new Set(['lifecycle', 'session', 'text', 'tool', 'usage', 'result', 'error', 'raw', 'progress', 'approval']);
const lifecyclePhases = new Set(['started', 'completed', 'failed', 'cancelled']);

/** Validate the host-owned event envelope while keeping CLI-specific extensions opaque. */
export function parseAgentEvent(value, { allowLegacy = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdeError('INVALID_AGENT_EVENT', 'ADE agent event must be an object');
  }
  if (value.schemaVersion === undefined && allowLegacy === true) {
    value = { ...value, schemaVersion: AGENT_EVENT_SCHEMA_VERSION };
  }
  if (value.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION) {
    throw new AdeError('UNSUPPORTED_AGENT_EVENT_VERSION', 'Unsupported ADE agent event schema version');
  }
  if (typeof value.sessionId !== 'string' || !value.sessionId ||
      typeof value.agent !== 'string' || !value.agent ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !Number.isSafeInteger(value.timestamp) || value.timestamp < 1 ||
      typeof value.kind !== 'string' || !eventKinds.has(value.kind)) {
    throw new AdeError('INVALID_AGENT_EVENT', 'Invalid ADE agent event metadata or kind');
  }
  if ((value.kind === 'lifecycle' && !lifecyclePhases.has(value.phase)) ||
      (value.kind === 'text' && typeof value.text !== 'string') ||
      (value.kind === 'text' && value.mode !== undefined && !['append', 'replace'].includes(value.mode)) ||
      (value.kind === 'approval' && (!['requested', 'approved', 'denied'].includes(value.phase) || typeof value.tool !== 'string')) ||
      (value.kind === 'error' && typeof value.message !== 'string')) {
    throw new AdeError('INVALID_AGENT_EVENT', 'Malformed ADE agent event payload');
  }
  return value;
}
