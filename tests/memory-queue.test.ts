import { describe, expect, it } from 'vitest';
import { MemoryQueue, NonRetryableJobError } from '../src/core/queue/memory-queue.js';

describe('in-process job queue (no Redis)', () => {
  it('runs jobs and retries failures with backoff until they succeed', async () => {
    const queue = new MemoryQueue<{ n: number }>('test', 1);
    const attempts: number[] = [];
    queue.process((_data, context) => {
      attempts.push(context.attempt);
      return context.attempt < 3 ? Promise.reject(new Error('temporary')) : Promise.resolve();
    });
    queue.add('job-1', { n: 1 }, { attempts: 3, backoffMs: 5 });
    await queue.onIdle();
    expect(attempts).toEqual([1, 2, 3]);
    await queue.close();
  });

  it('does not retry permanent errors and gives up after the last attempt', async () => {
    const queue = new MemoryQueue<string>('test', 2);
    const calls: string[] = [];
    queue.process((data) => {
      calls.push(data);
      return Promise.reject(
        data === 'permanent' ? new NonRetryableJobError('not a video') : new Error('always fails'),
      );
    });
    queue.add('a', 'permanent', { attempts: 5, backoffMs: 1 });
    queue.add('b', 'flaky', { attempts: 2, backoffMs: 1 });
    await queue.onIdle();
    expect(calls.filter((c) => c === 'permanent')).toHaveLength(1);
    expect(calls.filter((c) => c === 'flaky')).toHaveLength(2);
    await queue.close();
  });

  it('ignores a duplicate job id while the first one is pending', async () => {
    const queue = new MemoryQueue<number>('test', 1);
    expect(queue.add('same', 1, { attempts: 1, backoffMs: 0 })).toBe(true);
    expect(queue.add('same', 2, { attempts: 1, backoffMs: 0 })).toBe(false);
    expect(queue.getWaiting('same')).toBe(1);
    const seen: number[] = [];
    queue.process((data) => {
      seen.push(data);
      return Promise.resolve();
    });
    await queue.onIdle();
    expect(seen).toEqual([1]);
    // Finished jobs can be queued again (e.g. a retried upload).
    expect(queue.add('same', 3, { attempts: 1, backoffMs: 0 })).toBe(true);
    await queue.onIdle();
    expect(seen).toEqual([1, 3]);
    await queue.close();
  });

  it('never runs more jobs at once than its concurrency', async () => {
    const queue = new MemoryQueue<number>('test', 2);
    let running = 0;
    let peak = 0;
    queue.process(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
    });
    for (let i = 0; i < 6; i += 1) queue.add(`job-${i}`, i, { attempts: 1, backoffMs: 0 });
    await queue.onIdle();
    expect(peak).toBe(2);
    await queue.close();
  });

  it('close() aborts running jobs through their signal', async () => {
    const queue = new MemoryQueue<number>('test', 1);
    let aborted = false;
    queue.process(
      (_data, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    queue.add('long', 1, { attempts: 3, backoffMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await queue.close();
    expect(aborted).toBe(true);
    expect(queue.pendingCount).toBe(0);
  });
});
