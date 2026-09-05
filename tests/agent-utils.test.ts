import { describe, it, expect } from 'vitest';
import { formatForAgent, buildContext } from "../acquisition.js";
import { slugify, truncate, legacyestimatetokens, legacychunktext, isValidUrl, isInternalUrl } from "../acquisition.js";

const SAMPLE_RESULT = {
  url: 'https://example.com',
  title: 'Test Page',
  content: 'Hello World from agent test',
  format: 'markdown',
  text: 'Hello World from agent test',
  links: [
    { href: 'https://external.com', text: 'External', isInternal: false, isExternal: true },
    { href: 'https://example.com/internal', text: 'Internal', isInternal: true, isExternal: false },
  ],
  images: [],
  tables: [],
  metadata: { title: 'Test Page', description: 'A test page', author: 'Tester' },
  extractedAt: '2025-01-01T00:00:00Z',
  duration: 50,
  size: 100,
};

// ──────────── Agent ────────────

describe('formatForAgent', () => {
  it('returns structured output for AI agents', () => {
    const output = formatForAgent(SAMPLE_RESULT);
    expect(output.summary.length).toBeGreaterThan(0);
    expect(output.keyPoints.length).toBeGreaterThan(0);
    expect(output.content.length).toBeGreaterThan(0);
    expect(output.relevantUrls.length).toBeGreaterThan(0);
    expect(output.tokens).toBeGreaterThan(0);
  });
});

describe('buildContext', () => {
  it('builds context string', () => {
    const context = buildContext(SAMPLE_RESULT);
    expect(context).toContain('Test Page');
  });
});

// ──────────── Utils ────────────

describe('utils', () => {
  it('slugify works', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('truncate works', () => {
    expect(truncate('Hello World', 5)).toBe('He...');
  });

  it('estimateTokens works', () => {
    expect(legacyestimatetokens('Hello World')).toBe(3);
  });

  it('chunkText splits correctly', () => {
    const chunks = legacychunktext('Hello\nWorld\nTest\nFour', 10);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('isValidUrl works', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('not-a-url')).toBe(false);
  });

  it('isInternalUrl works', () => {
    expect(isInternalUrl('https://example.com/page', 'https://example.com')).toBe(true);
    expect(isInternalUrl('https://other.com', 'https://example.com')).toBe(false);
  });
});
