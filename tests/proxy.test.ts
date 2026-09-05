import { describe, it, expect } from 'vitest';
import { ProxyPool, createProxyPool } from "../acquisition.js";

describe('ProxyPool', () => {
  const proxies = [
    { url: 'http://proxy1:8080' },
    { url: 'http://proxy2:8080' },
    { url: 'http://proxy3:8080' },
  ];

  it('returns proxies round-robin', () => {
    const pool = new ProxyPool(proxies);
    const p1 = pool.next();
    const p2 = pool.next();
    expect(p1?.url).not.toBe(p2?.url);
  });

  it('reports success', () => {
    const pool = new ProxyPool(proxies);
    const p = pool.next()!;
    pool.reportSuccess(p);
    const status = pool.getStatus();
    expect(status.active).toBe(3);
  });

  it('disables proxy after max failures', () => {
    const pool = new ProxyPool(proxies, { maxFailures: 2 });
    const p = pool.next()!;
    pool.reportFailure(p);
    pool.reportFailure(p);
    const status = pool.getStatus();
    expect(status.disabled).toBe(1);
  });

  it('returns null when all disabled', () => {
    const pool = new ProxyPool([{ url: 'http://only:8080' }], { maxFailures: 1 });
    const p = pool.next()!;
    pool.reportFailure(p);
    expect(pool.next()).toBeNull();
  });
});
