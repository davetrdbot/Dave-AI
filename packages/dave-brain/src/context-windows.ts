/**
 * How many tokens a model can take in one request -- the "max" on the app's context panel.
 *
 * Two sources, in order:
 *   1. What the provider itself says. Baseten's GET /v1/models documents "pricing, context
 *      windows, and supported features" per model; OpenAI-compatible servers that expose it use
 *      one of a handful of field names (read by `contextWindowFromModelListing`).
 *   2. This table, taken from the providers' published model lists (Baseten Model APIs overview,
 *      checked 2026-09-23) and the model makers' own specs. Matched on the model id, case-blind.
 *
 * Unknown models return undefined -- the panel then shows tokens used without inventing a max.
 */

const KNOWN: [RegExp, number][] = [
  [/deepseek-v4/i, 1_048_000],
  [/deepseek-v3\.2/i, 163_840],
  [/deepseek-v3/i, 163_840],
  [/deepseek-r1/i, 163_840],
  [/glm-5/i, 1_048_000],
  [/glm-4\.[67]/i, 200_000],
  [/inkling/i, 1_048_000],
  [/kimi-k3/i, 1_048_000],
  [/kimi-k2\.[5-9]|kimi-k2-instruct-0905|kimi-k2-thinking/i, 262_144],
  [/kimi-k2/i, 131_072],
  [/nemotron-3-ultra/i, 202_000],
  [/gpt-oss/i, 128_000],
  [/qwen3-coder/i, 262_144],
  [/qwen3/i, 131_072],
  [/claude-(opus|sonnet|fable)-5/i, 1_000_000],
  [/claude/i, 200_000],
  [/gemini-(2\.5|3)/i, 1_048_576],
  [/gpt-5/i, 400_000],
  [/gpt-4\.1/i, 1_047_576],
  [/gpt-4o|o3|o4/i, 128_000],
  [/grok-4/i, 256_000],
  [/llama-4/i, 1_048_576],
  [/llama-3/i, 128_000],
  [/mistral-large|mistral-medium/i, 128_000],
];

export function knownContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  for (const [pattern, tokens] of KNOWN) if (pattern.test(model)) return tokens;
  return undefined;
}

const LISTING_FIELDS = ["context_window", "context_length", "max_context_length", "max_model_len", "max_input_tokens", "context_size"];

/** Reads a model's context window out of one entry of an OpenAI-style /models listing, whatever
 *  the provider happens to call the field (including one level down, e.g. `metadata`). */
export function contextWindowFromModelListing(entry: unknown): number | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  for (const f of LISTING_FIELDS) {
    const v = e[f];
    if (typeof v === "number" && v > 1000) return v;
    if (typeof v === "string" && /^\d+$/.test(v) && Number(v) > 1000) return Number(v);
  }
  for (const v of Object.values(e)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = contextWindowFromModelListing(v);
      if (nested) return nested;
    }
  }
  return undefined;
}
