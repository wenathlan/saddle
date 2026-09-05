import { describe, it, expect } from 'vitest';
import { chunkMarkdown, chunkText, formatChunksForRAG } from "../acquisition.js";

describe('chunkMarkdown', () => {
  it('chunks by headings', () => {
    const md = '# Title\n\nParagraph 1\n\n## Section 1\n\nParagraph 2\n\n## Section 2\n\nParagraph 3';
    const chunks = chunkMarkdown(md, { maxTokens: 100 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toContain('Title');
  });

  it('splits large sections by paragraphs', () => {
    const md = '# Title\n\n' + 'Long paragraph. '.repeat(100);
    const chunks = chunkMarkdown(md, { maxTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('tracks heading path', () => {
    const md = '# H1\n\n## H2\n\n### H3\n\nContent';
    const chunks = chunkMarkdown(md, { maxTokens: 1000 });
    expect(chunks[0].headingPath).toContain('H1');
  });
});

describe('chunkText', () => {
  it('chunks plain text', () => {
    const text = 'Paragraph 1\n\nParagraph 2\n\nParagraph 3';
    const chunks = chunkText(text, { maxTokens: 20 });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('returns single chunk for short text', () => {
    const chunks = chunkText('hello', { maxTokens: 100 });
    expect(chunks.length).toBe(1);
  });
});

describe('formatChunksForRAG', () => {
  it('formats chunks with separator', () => {
    const chunks = [
      { content: 'chunk 1', headingPath: ['H1'], tokenCount: 10, index: 0 },
      { content: 'chunk 2', headingPath: ['H2'], tokenCount: 10, index: 1 },
    ];
    const result = formatChunksForRAG(chunks);
    expect(result).toContain('chunk 1');
    expect(result).toContain('chunk 2');
    expect(result).toContain('---');
  });
});
