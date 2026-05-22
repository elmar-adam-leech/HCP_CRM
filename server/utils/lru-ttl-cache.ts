export class LruTtlCache<K, V> {
  private readonly map = new Map<K, { value: V; expires: number }>();

  constructor(private readonly maxAge: number, private readonly max: number) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.maxAge });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export type MemoizedAsync<A extends unknown[], R> = ((...args: A) => Promise<R>) & {
  delete: (...args: A) => void;
  clear: () => void;
  readonly size: number;
  readonly length: number;
};

export function memoizeAsync<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { maxAge: number; max: number; normalizer?: (args: A) => string },
): MemoizedAsync<A, R> {
  const cache = new LruTtlCache<string, Promise<R>>(opts.maxAge, opts.max);
  const normalize =
    opts.normalizer ?? ((args: A) => (args.length === 1 ? String(args[0]) : args.map((a) => String(a)).join('|')));

  const wrapped = ((...args: A): Promise<R> => {
    const key = normalize(args);
    const cached = cache.get(key);
    if (cached) return cached;
    const promise = fn(...args).catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, promise);
    return promise;
  }) as MemoizedAsync<A, R>;

  wrapped.delete = (...args: A) => cache.delete(normalize(args));
  wrapped.clear = () => cache.clear();
  Object.defineProperty(wrapped, 'size', { get: () => cache.size });
  Object.defineProperty(wrapped, 'length', { get: () => cache.size });
  return wrapped;
}
