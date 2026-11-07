/** An LRU bounded by the bytes it holds, not by its entry count. */
export class ByteLru<V> {
  private entries = new Map<string, { value: V; bytes: number }>();
  private held = 0;
  constructor(public readonly maxBytes: number) {}
  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }
  /** An entry larger than the whole budget isn't cached. */
  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.held += bytes;
    for (const [oldest, e] of this.entries) {
      if (this.held <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.held -= e.bytes;
    }
  }
  delete(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.held -= e.bytes;
  }
  get bytes() { return this.held; }
  get size() { return this.entries.size; }
}
