// Anonymous feedback to the Hub leaves from this process (feedback-hub.js). Plugin children and the app process apply the same switch to their own Hub calls.
// The settings switch wins both ways: on forces the flag, off removes one inherited from the shell.
export function localServerEnv(env, enabled) {
  const next = { ...env };
  if (enabled) next.NODE_USE_SYSTEM_CA = '1';
  else delete next.NODE_USE_SYSTEM_CA;
  return next;
}
