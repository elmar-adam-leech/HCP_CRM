const TTL_MS = 60_000;

const suppressionMap = new Map<string, number>();

function evictExpired(): void {
  const now = Date.now();
  Array.from(suppressionMap.entries()).forEach(([id, ts]) => {
    if (now - ts > TTL_MS) suppressionMap.delete(id);
  });
}

export function markHcpCustomerPushed(hcpCustomerId: string): void {
  evictExpired();
  suppressionMap.set(hcpCustomerId, Date.now());
}

export function isHcpCustomerEchoPending(hcpCustomerId: string): boolean {
  evictExpired();
  return suppressionMap.has(hcpCustomerId);
}

export function clearHcpCustomerEcho(hcpCustomerId: string): void {
  suppressionMap.delete(hcpCustomerId);
}
