import { describe, it, expect } from 'vitest';
import { MiddlewarePipeline, createPipeline, loggingMiddleware, timeoutMiddleware } from "../acquisition.js";

describe('MiddlewarePipeline', () => {
  it('executes middleware in order', async () => {
    const order: number[] = [];
    const pipeline = createPipeline();
    pipeline.use(async (_ctx, next) => { order.push(1); await next(); order.push(4); });
    pipeline.use(async (_ctx, next) => { order.push(2); await next(); order.push(3); });
    await pipeline.execute({});
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('can modify context data', async () => {
    const pipeline = createPipeline<{ count: number }>();
    pipeline.use(async (ctx, next) => { ctx.data.count++; await next(); });
    pipeline.use(async (ctx, next) => { ctx.data.count *= 2; await next(); });
    const ctx = await pipeline.execute({ count: 5 });
    expect(ctx.data.count).toBe(12);
  });

  it('can short-circuit', async () => {
    const pipeline = createPipeline();
    let secondCalled = false;
    pipeline.use(async (_ctx, _next) => { /* don't call next */ });
    pipeline.use(async (_ctx, _next) => { secondCalled = true; });
    await pipeline.execute({});
    expect(secondCalled).toBe(false);
  });

  it('can abort', async () => {
    const pipeline = createPipeline();
    pipeline.use(async (ctx, _next) => { ctx.abort(); });
    const ctx = await pipeline.execute({});
    expect(ctx.aborted).toBe(true);
  });
});

describe('timeoutMiddleware', () => {
  it('aborts after timeout', async () => {
    const pipeline = createPipeline();
    pipeline.use(timeoutMiddleware(50));
    pipeline.use(async (ctx) => {
      await new Promise(r => setTimeout(r, 200));
    });
    const ctx = await pipeline.execute({});
    expect(ctx.aborted).toBe(true);
  });
});
