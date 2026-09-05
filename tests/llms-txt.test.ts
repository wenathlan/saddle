import { describe, it, expect } from 'vitest';
import { generateLlmsTxt, generateLlmsFullTxt } from "../webscrape.js";
import { ScrapeResult } from "../webscrape.js";

const mockResults: ScrapeResult[] = [
  {
    url: 'https://example.com',
    title: 'Home',
    content: 'Welcome to the site.',
    format: 'markdown',
    text: 'Welcome to the site.',
    links: [],
    images: [],
    tables: [],
    metadata: { title: 'Home', description: 'A test site' },
    extractedAt: '2025-01-01T00:00:00Z',
    duration: 100,
    size: 100,
  },
  {
    url: 'https://example.com/docs',
    title: 'Docs',
    content: 'Documentation content.',
    format: 'markdown',
    text: 'Documentation content.',
    links: [],
    images: [],
    tables: [],
    metadata: { title: 'Docs', description: 'API docs' },
    extractedAt: '2025-01-01T00:00:00Z',
    duration: 50,
    size: 50,
  },
];

describe('generateLlmsTxt', () => {
  it('generates valid llms.txt format', () => {
    const result = generateLlmsTxt(mockResults, { siteName: 'Test Site' });
    expect(result).toContain('# Test Site');
    expect(result).toContain('## Pages');
    expect(result).toContain('## Documentation');
  });

  it('includes description', () => {
    const result = generateLlmsTxt(mockResults, { description: 'My site' });
    expect(result).toContain('> My site');
  });
});

describe('generateLlmsFullTxt', () => {
  it('concatenates content with separators', () => {
    const result = generateLlmsFullTxt(mockResults);
    expect(result).toContain('Home');
    expect(result).toContain('Docs');
    expect(result).toContain('---');
    expect(result).toContain('Source: https://example.com');
  });
});
