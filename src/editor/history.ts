export interface HistoryEntry {
  apply(): void;
}

export class History {
  private readonly stack: HistoryEntry[] = [];
  private readonly limit: number;

  constructor(limit = 128) {
    this.limit = limit;
  }

  push(undo: () => void): void {
    this.stack.push({ apply: undo });
    while (this.stack.length > this.limit) this.stack.shift();
  }

  undo(): void {
    const top = this.stack.pop();
    if (top) top.apply();
  }

  clear(): void {
    this.stack.length = 0;
  }

  get size(): number {
    return this.stack.length;
  }
}
