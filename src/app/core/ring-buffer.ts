/** Fixed-capacity FIFO ring buffer. O(1) push, never grows past `capacity`. */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    this.items[(this.head + this.count) % this.capacity] = item;
    if (this.count < this.capacity) this.count++;
    else this.head = (this.head + 1) % this.capacity;
  }

  /** Oldest → newest. */
  toArray(): T[] {
    const out: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.items[(this.head + i) % this.capacity] as T;
    return out;
  }

  /** Items (oldest → newest) for which `pred` holds, scanning only the tail that matches. */
  takeLastWhile(pred: (item: T) => boolean): T[] {
    let i = this.count - 1;
    while (i >= 0 && pred(this.items[(this.head + i) % this.capacity] as T)) i--;
    const out: T[] = [];
    for (let j = i + 1; j < this.count; j++) out.push(this.items[(this.head + j) % this.capacity] as T);
    return out;
  }

  last(): T | undefined {
    return this.count ? this.items[(this.head + this.count - 1) % this.capacity] : undefined;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
