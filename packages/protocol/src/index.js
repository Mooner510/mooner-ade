export const PROTOCOL_VERSION = 1;

export class AdeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AdeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function envelope(channel, kind, payload, id = crypto.randomUUID()) {
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
