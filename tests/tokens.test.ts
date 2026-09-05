import { describe, it, expect } from 'vitest';
import { estimateTokens, countTokens, fitsInContext, truncateToTokens } from "../webscrape.js";

describe('estimateTokens', () => {
  it('estimates tokens for default model', () => {
    const tokens = estimateTokens('Hello World');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(5);
  });

  it('estimates tokens for gpt-4o', () => {
    const tokens = estimateTokens('Hello World', 'gpt-4o');
    expect(tokens).toBeGreaterThan(0);
  });

  it('estimates tokens for claude', () => {
    const tokens = estimateTokens('Hello World', 'claude');
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('countTokens', () => {
  it('returns positive number', () => {
    expect(countTokens('test')).toBeGreaterThan(0);
  });
});

describe('fitsInContext', () => {
  it('returns true for short text', () => {
    expect(fitsInContext('hi', 100)).toBe(true);
  });

  it('returns false for long text', () => {
    expect(fitsInContext('x'.repeat(10000), 10)).toBe(false);
  });
});

describe('truncateToTokens', () => {
  it('returns original if fits', () => {
    expect(truncateToTokens('hello', 100)).toBe('hello');
  });

  it('truncates long text', () => {
    const result = truncateToTokens('x'.repeat(10000), 10);
    expect(result.length).toBeLessThan(10000);
    expect(result).toContain('...');
  });
});
