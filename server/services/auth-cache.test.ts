import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getCachedValidation,
  cacheValidation,
  evictAuthCache,
  getAuthCacheStats,
  startAuthCacheSweeper,
  _resetAuthCacheForTests,
  AUTH_CACHE_TTL_MS,
} from "./auth-cache";

const sample = {
  userId: "user-1",
  tokenVersion: 3,
  contractorId: "contractor-1",
};

describe("auth-cache", () => {
  beforeEach(() => {
    _resetAuthCacheForTests();
  });

  it("returns null and counts a miss when the jti has not been cached", () => {
    expect(getCachedValidation("missing-jti")).toBeNull();
    expect(getAuthCacheStats().misses).toBe(1);
    expect(getAuthCacheStats().hits).toBe(0);
  });

  it("returns the cached payload and counts a hit after cacheValidation", () => {
    cacheValidation("jti-a", sample);
    const hit = getCachedValidation("jti-a");
    expect(hit).not.toBeNull();
    expect(hit!.userId).toBe(sample.userId);
    expect(hit!.tokenVersion).toBe(sample.tokenVersion);
    expect(hit!.contractorId).toBe(sample.contractorId);
    expect(hit!.validUntil).toBeGreaterThan(Date.now());
    expect(getAuthCacheStats().hits).toBe(1);
  });

  it("evicts and reports a miss once the entry has expired", () => {
    cacheValidation("jti-b", sample, 5);
    // Advance wall clock past the TTL.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 100);
    expect(getCachedValidation("jti-b")).toBeNull();
    expect(getAuthCacheStats().size).toBe(0);
    vi.useRealTimers();
  });

  it("evictAuthCache removes the entry immediately (used by revokeToken)", () => {
    cacheValidation("jti-c", sample);
    expect(getCachedValidation("jti-c")).not.toBeNull();
    evictAuthCache("jti-c");
    expect(getCachedValidation("jti-c")).toBeNull();
  });

  it("uses default TTL when none is provided", () => {
    const before = Date.now();
    cacheValidation("jti-d", sample);
    const hit = getCachedValidation("jti-d")!;
    expect(hit.validUntil).toBeGreaterThanOrEqual(before + AUTH_CACHE_TTL_MS - 5);
  });

  it("the periodic sweeper drops expired entries without affecting fresh ones", () => {
    cacheValidation("expired-jti", sample, 1);
    cacheValidation("fresh-jti", sample, 60_000);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);
    const handle = startAuthCacheSweeper(50);
    vi.advanceTimersByTime(60);
    expect(getAuthCacheStats().size).toBe(1);
    expect(getCachedValidation("fresh-jti")).not.toBeNull();
    clearInterval(handle);
    vi.useRealTimers();
  });
});

describe("auth-cache LRU eviction", () => {
  // We can't easily test the 50k cap in a fast unit test, but we can at least
  // assert the behaviour by tweaking the cap via the same Map internals: the
  // simplest behaviour-level check is that re-inserting a key updates its
  // recency so a subsequent read still hits.
  beforeEach(() => _resetAuthCacheForTests());

  it("touches recency on read so a repeated hit stays current", () => {
    cacheValidation("a", sample);
    cacheValidation("b", sample);
    // Reading 'a' should bump it to the most-recently-used slot. We don't
    // exercise eviction here, but we verify the read still returns the entry
    // across multiple calls (no double-decrement of TTL).
    expect(getCachedValidation("a")).not.toBeNull();
    expect(getCachedValidation("a")).not.toBeNull();
    expect(getAuthCacheStats().hits).toBe(2);
  });
});
