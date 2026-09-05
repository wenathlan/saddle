import { describe, it, expect } from 'vitest';
import {
  WebScrapeError, ValidationError, TimeoutError, BlockedError,
  RateLimitError, ProxyError, ParseError, AuthError, NetworkError,
  BrowserNotAvailableError, ErrorCode
} from "../acquisition.js";

describe('WebScrapeError', () => {
  it('creates error with all properties', () => {
    const err = new WebScrapeError('test', ErrorCode.TIMEOUT, 504, true, { url: 'https://example.com' });
    expect(err.message).toBe('test');
    expect(err.code).toBe(ErrorCode.TIMEOUT);
    expect(err.statusCode).toBe(504);
    expect(err.isRetryable).toBe(true);
    expect(err.details).toEqual({ url: 'https://example.com' });
    expect(err.name).toBe('WebScrapeError');
    expect(err.timestamp).toBeDefined();
  });

  it('serializes to JSON', () => {
    const err = new WebScrapeError('test', ErrorCode.BLOCKED, 403, false);
    const json = err.toJSON();
    expect(json.error.code).toBe(ErrorCode.BLOCKED);
    expect(json.error.statusCode).toBe(403);
  });

  it('supports instanceof check', () => {
    const err = new ValidationError('bad input');
    expect(err instanceof WebScrapeError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe('Specific errors', () => {
  it('TimeoutError is retryable', () => {
    const err = new TimeoutError('timeout');
    expect(err.isRetryable).toBe(true);
    expect(err.statusCode).toBe(504);
  });

  it('BlockedError is not retryable', () => {
    const err = new BlockedError('blocked');
    expect(err.isRetryable).toBe(false);
    expect(err.statusCode).toBe(403);
  });

  it('RateLimitError has retryAfterMs', () => {
    const err = new RateLimitError('rate limited', 5000);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.isRetryable).toBe(true);
  });

  it('BrowserNotAvailableError has default message', () => {
    const err = new BrowserNotAvailableError();
    expect(err.message).toContain('Playwright');
  });
});
