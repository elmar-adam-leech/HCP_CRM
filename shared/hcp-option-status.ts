function normHcpStatus(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

export function isHcpApprovedOptionStatus(s: string | null | undefined): boolean {
  const n = normHcpStatus(s);
  return n === 'approved' || n === 'pro approved' || n === 'customer approved';
}

export function isHcpDeclinedOptionStatus(s: string | null | undefined): boolean {
  const n = normHcpStatus(s);
  if (!n || isHcpApprovedOptionStatus(s)) return false;
  return /\b(declined|rejected|canceled|cancelled|voided?)\b/.test(n);
}

export function isHcpExpiredOptionStatus(s: string | null | undefined): boolean {
  return /\bexpired\b/.test(normHcpStatus(s));
}
