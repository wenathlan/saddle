import { describe, it, expect } from 'vitest';
import { WebScrapeCache, createCache } from "../acquisition.js";

describe('WebScrapeCache', () => {
  it('stores and retrieves values', () => {
    const cache = new WebScrapeCache();
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('returns undefined for missing keys', () => {
    const cache = new WebScrapeCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('respects TTL', () => {
    const cache = new WebScrapeCache();
    cache.set('key1', 'value1', 1); // 1ms TTL
    expect(cache.get('key1')).toBe('value1');
    // After TTL, should be undefined (lazy cleanup)
    setTimeout(() => {
      expect(cache.get('key1')).toBeUndefined();
    }, 10);
  });

  it('implements getOrSet', async () => {
    const cache = new WebScrapeCache();
    const result = await cache.getOrSet('key1', async () => 'computed');
    expect(result).toBe('computed');
    expect(cache.get('key1')).toBe('computed');
  });

  it('getOrSet returns cached value', async () => {
    const cache = new WebScrapeCache();
    cache.set('key1', 'cached');
    let called = false;
    const result = await cache.getOrSet('key1', async () => { called = true; return 'new'; });
    expect(result).toBe('cached');
    expect(called).toBe(false);
  });

  it('clears all entries', () => {
    const cache = new WebScrapeCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('tracks size', () => {
    const cache = new WebScrapeCache();
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size()).toBe(2);
    cache.delete('a');
    expect(cache.size()).toBe(1);
  });
});
