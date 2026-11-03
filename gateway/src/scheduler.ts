/**
 * 格级并发调度（backend-design §6）：全局 maxConcurrentCells 个执行槽，
 * 超出的格排队（保持 CREATED 态），格完成/失败即释放额度。
 */
export class Scheduler {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get running(): number {
    return this.active;
  }

  get pending(): number {
    return this.queue.length;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await job();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      next?.();
    }
  }
}
