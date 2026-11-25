export interface NormalizedTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export function normalizeTokenUsage(
  kind: 'openai' | 'anthropic' | 'gemini' | string,
  usage: unknown,
): NormalizedTokenUsage | null;
