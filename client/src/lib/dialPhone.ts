export function dialPhone({
  contactId,
  phone,
  name,
}: {
  contactId?: string;
  phone: string;
  name?: string;
}): void {
  fetch("/api/calls/log-personal", {
    method: "POST",
    keepalive: true,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contactId, phone, name }),
  }).catch((err) => {
    console.error('[dialPhone] Failed to log personal call:', err);
  });

  window.location.href = `tel:${phone}`;
}
