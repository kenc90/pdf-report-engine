import { describe, expect, it } from 'vitest';
import { normalizeTokenUsage } from '../docs/editor-ai.js';

describe('editor AI token usage', () => {
  it('normalizes OpenAI usage and derives a missing total', () => {
    expect(normalizeTokenUsage('openai', { prompt_tokens: 120, completion_tokens: 18 })).toEqual({
      inputTokens: 120,
      outputTokens: 18,
      totalTokens: 138,
    });
  });

  it('includes Anthropic cache tokens in the input count', () => {
    expect(normalizeTokenUsage('anthropic', {
      input_tokens: 100,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 20,
      output_tokens: 8,
    })).toEqual({
      inputTokens: 132,
      outputTokens: 8,
      totalTokens: 140,
    });
  });

  it('normalizes Gemini usage metadata', () => {
    expect(normalizeTokenUsage('gemini', {
      promptTokenCount: 65,
      candidatesTokenCount: 9,
      totalTokenCount: 74,
    })).toEqual({
      inputTokens: 65,
      outputTokens: 9,
      totalTokens: 74,
    });
  });

  it('returns no usage when the provider omits token counts', () => {
    expect(normalizeTokenUsage('openai', {})).toBeNull();
    expect(normalizeTokenUsage('gemini', null)).toBeNull();
  });
});
