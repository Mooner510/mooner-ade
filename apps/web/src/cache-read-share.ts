// Cache-read price as a share of the base input price, from Anthropic's pricing and prompt-caching docs (checked 2026-11-24): 0.025x for Fable/Mythos 5.1 and 5.2,
// 0.05x for Opus 5.5 and Sonnet 5.5, 0.1x for every other model. Update when prices move.
export const cacheReadShare = (model: string) =>
  /(?:fable|mythos)-5-[12](?!\d)/.test(model) ? 0.025 : /(?:opus|sonnet)-5-5(?!\d)/.test(model) ? 0.05 : 0.1;
