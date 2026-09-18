export class QueueCancelled extends Error {}
export class CapacityUnavailable extends Error {}
interface Job {
  branchId: string;
  projectId: string;
  workspace: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/** Bounded worker pool; jobs sharing files serialize, isolated jobs can overlap. */
export class TurnScheduler {
  private queue: Job[] = [];
  private active = new Map<string, Job>();
  private closing = false;
  constructor(readonly maxConcurrent = 5, readonly perProject = 5, readonly maxQueued = 200) {
    for (const n of [maxConcurrent, perProject, maxQueued]) {
      if (!Number.isInteger(n) || n < 1) throw new Error("scheduler limits must be positive integers");
    }
  }
  submit(input: { branchId: string; projectId: string; workspace: string; run: () => Promise<void> }): Promise<void> {
    if (this.closing) return Promise.reject(new Error("server is shutting down"));
    if (this.queue.length >= this.maxQueued) return Promise.reject(new Error("execution queue is full"));
    if (this.active.has(input.branchId) || this.queue.some(j => j.branchId === input.branchId)) {
      return Promise.reject(new Error("branch already scheduled"));
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ ...input, resolve, reject });
      this.pump();
    });
  }
  /** Synchronous fork RPCs must not wait behind the parent holding a slot. */
  submitImmediate(input: { branchId: string; projectId: string; workspace: string; run: () => Promise<void> }): Promise<void> {
    const running = [...this.active.values()];
    if (this.closing || this.queue.length || running.length >= this.maxConcurrent ||
        running.filter(j => j.projectId === input.projectId).length >= this.perProject ||
        running.some(j => j.workspace === input.workspace)) {
      return Promise.reject(new CapacityUnavailable("execution capacity unavailable; retry fork after active work completes"));
    }
    return this.submit(input);
  }
  cancelQueued(branchId: string): boolean {
    const index = this.queue.findIndex(j => j.branchId === branchId);
    if (index < 0) return false;
    this.queue.splice(index, 1)[0].reject(new QueueCancelled("queued turn cancelled"));
    return true;
  }
  snapshot() {
    return { maxConcurrent: this.maxConcurrent, perProject: this.perProject, maxQueued: this.maxQueued,
      closing: this.closing, running: [...this.active.keys()], queued: this.queue.map(j => j.branchId) };
  }
  close(): void {
    this.closing = true;
    for (const job of this.queue.splice(0)) job.reject(new QueueCancelled("server shutting down"));
  }
  async drain(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.active.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    return this.active.size === 0;
  }
  private pump(): void {
    if (this.closing) return;
    while (this.active.size < this.maxConcurrent) {
      const index = this.queue.findIndex(j => {
        const running = [...this.active.values()];
        return running.filter(a => a.projectId === j.projectId).length < this.perProject &&
          !running.some(a => a.workspace === j.workspace);
      });
      if (index < 0) return;
      const job = this.queue.splice(index, 1)[0];
      this.active.set(job.branchId, job);
      void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        this.active.delete(job.branchId);
        this.pump();
      });
    }
  }
}
