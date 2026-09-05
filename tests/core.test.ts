import { describe, it, expect } from 'vitest';
import { extractContent, extractReadable } from "../acquisition.js";
import { serializeHtml, serializeResult } from "../acquisition.js";
import { resolveFormat, extensionForFormat, buildSerializeOptions, detectContentType } from "../acquisition.js";

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Test Page</title>
<meta name="description" content="A test page">
<meta name="author" content="Test Author">
</head>
<body>
  <h1>Hello World</h1>
  <p>This is a paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
  <a href="https://example.com">Example Link</a>
  <img src="https://example.com/img.png" alt="Test Image">
  <ul>
    <li>Item 1</li>
    <li>Item 2</li>
  </ul>
  <table>
    <thead><tr><th>Name</th><th>Age</th></tr></thead>
    <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
  </table>
</body>
</html>`;

// ──────────── Extract ────────────

describe('extractContent', () => {
  it('extracts metadata', async () => {
    const result = await extractContent(SAMPLE_HTML);
    expect(result.metadata.title).toBe('Test Page');
    expect(result.metadata.description).toBe('A test page');
    expect(result.metadata.author).toBe('Test Author');
  });

  it('extracts links', async () => {
    const result = await extractContent(SAMPLE_HTML, { preserveLinks: true });
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.links[0].href).toBe('https://example.com');
  });

  it('extracts images', async () => {
    const result = await extractContent(SAMPLE_HTML, { preserveImages: true });
    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images[0].src).toBe('https://example.com/img.png');
  });

  it('extracts tables', async () => {
    const result = await extractContent(SAMPLE_HTML, { preserveTables: true });
    expect(result.tables.length).toBeGreaterThan(0);
    expect(result.tables[0].headers).toContain('Name');
    expect(result.tables[0].rows[0]).toContain('Alice');
  });

  it('extracts readable text', async () => {
    const result = await extractContent(SAMPLE_HTML, { readable: true });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain('Hello World');
  });

  it('removes selectors', async () => {
    const html = '<html><body><div class="ad">AD</div><p>Content</p></body></html>';
    const result = await extractContent(html, { removeSelectors: ['.ad'] });
    expect(result.text).not.toContain('AD');
    expect(result.text).toContain('Content');
  });
});

describe('extractReadable', () => {
  it('returns readable text content', async () => {
    const text = await extractReadable(SAMPLE_HTML);
    expect(text).toContain('Hello World');
    expect(text).toContain('Example Link');
  });
});

// ──────────── Serialize ────────────

describe('serializeHtml', () => {
  const HTML = '<html><head><title>Test</title></head><body><h1>Hello</h1><p>World</p></body></html>';

  it('serializes to markdown', () => {
    const result = serializeHtml(HTML, { format: 'markdown' });
    expect(result.format).toBe('markdown');
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('World');
  });

  it('serializes to plain text', () => {
    const result = serializeHtml(HTML, { format: 'text' });
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('World');
  });

  it('creates chunks when maxChunkSize is set', () => {
    const result = serializeHtml(HTML, { format: 'markdown', maxChunkSize: 5 });
    expect(result.chunks).toBeDefined();
    expect(result.chunks!.length).toBeGreaterThan(1);
  });
});

describe('serializeResult', () => {
  const sample = {
    url: 'https://example.com',
    title: 'Test Page',
    content: 'Hello World',
    format: 'markdown',
    text: 'Hello World',
    links: [{ href: 'https://example.com/link', text: 'Link', isInternal: true, isExternal: false }],
    images: [{ src: 'https://example.com/img.png', alt: 'Image', width: 100, height: 50 }],
    tables: [{ headers: ['Name', 'Age'], rows: [['Alice', '30']], caption: 'People' }],
    metadata: { title: 'Test Page', description: 'A test page', author: 'Test Author' },
    extractedAt: '2025-01-01T00:00:00Z',
    duration: 100,
    size: 100,
  };

  it('includes metadata by default', () => {
    const result = serializeResult(sample, { format: 'markdown' });
    expect(result.content).toContain('Test Page');
    expect(result.content).toContain('example.com');
  });

  it('serializes to JSON', () => {
    const result = serializeResult(sample, { format: 'json' });
    const parsed = JSON.parse(result.content);
    expect(parsed.title).toBe('Test Page');
    expect(parsed.url).toBe('https://example.com');
  });

  it('serializes to XML', () => {
    const result = serializeResult(sample, { format: 'xml', xmlRoot: 'page' });
    expect(result.content).toContain('<?xml');
    expect(result.content).toContain('<page>');
    expect(result.content).toContain('</page>');
  });
});

// ──────────── Formats ────────────

describe('resolveFormat', () => {
  it('resolves common format names', () => {
    expect(resolveFormat('markdown')).toBe('markdown');
    expect(resolveFormat('md')).toBe('markdown');
    expect(resolveFormat('json')).toBe('json');
    expect(resolveFormat('xml')).toBe('xml');
    expect(resolveFormat('redis')).toBe('redis');
    expect(resolveFormat('text')).toBe('text');
    expect(resolveFormat('txt')).toBe('text');
  });

  it('resolves html', () => {
    expect(resolveFormat('html')).toBe('html');
    expect(resolveFormat('h')).toBe('html');
  });
});

describe('extensionForFormat', () => {
  it('returns correct extensions', () => {
    expect(extensionForFormat('markdown')).toBe('.md');
    expect(extensionForFormat('json')).toBe('.json');
    expect(extensionForFormat('xml')).toBe('.xml');
    expect(extensionForFormat('text')).toBe('.txt');
  });
});

describe('buildSerializeOptions', () => {
  it('builds correct serialize options', () => {
    const opts = buildSerializeOptions('markdown');
    expect(opts.format).toBe('markdown');
    expect(opts.includeMetadata).toBe(true);
  });

  it('maps html to markdown', () => {
    const opts = buildSerializeOptions('html');
    expect(opts.format).toBe('markdown');
  });
});

describe('detectContentType', () => {
  it('detects articles', () => {
    expect(detectContentType('<article>content</article>')).toBe('article');
  });

  it('detects lists', () => {
    const manyItems = '<li>x</li>'.repeat(25);
    expect(detectContentType(manyItems)).toBe('list');
  });

  it('detects regular pages', () => {
    expect(detectContentType('<p>simple page</p>')).toBe('page');
  });
});
