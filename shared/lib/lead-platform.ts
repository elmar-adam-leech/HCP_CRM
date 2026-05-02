/**
 * Centralized lead-source → platform rollup. Used by the ROI report (server)
 * and the Ad Spend settings page (client) so they always agree on the same
 * platform list.
 *
 * Raw sources live on `leads.source` / `contacts.source` as low-cardinality
 * strings (`facebook`, `facebook_lead_ad`, `public_booking`, ...). Platforms
 * are the user-facing rollup buckets: every paid channel gets its own
 * platform, plus generic "Website", "Referral", and a catch-all "Other".
 */

export const LEAD_PLATFORMS = [
  "Facebook",
  "Google",
  "Yelp",
  "Nextdoor",
  "Angi",
  "HomeAdvisor",
  "Thumbtack",
  "Website",
  "Referral",
  "Other",
] as const;

export type LeadPlatform = typeof LEAD_PLATFORMS[number];

const RAW_TO_PLATFORM: Record<string, LeadPlatform> = {
  facebook: "Facebook",
  facebook_lead_ad: "Facebook",
  facebook_history: "Facebook",

  google: "Google",
  google_local_services: "Google",
  google_ads: "Google",

  yelp: "Yelp",
  nextdoor: "Nextdoor",
  angi: "Angi",
  homeadvisor: "HomeAdvisor",
  thumbtack: "Thumbtack",

  website: "Website",
  public_booking: "Website",

  referral: "Referral",
  repeat_customer: "Referral",
};

export function getLeadPlatform(rawSource: string | null | undefined): LeadPlatform {
  if (!rawSource) return "Other";
  const key = rawSource.toLowerCase();
  return RAW_TO_PLATFORM[key] ?? "Other";
}

/** Stable canonical key for the platform — used as the key column on `media_spend`. */
export function platformKey(platform: LeadPlatform): string {
  return platform.toLowerCase();
}

export function platformFromKey(key: string): LeadPlatform | null {
  const lower = key.toLowerCase();
  for (const p of LEAD_PLATFORMS) {
    if (p.toLowerCase() === lower) return p;
  }
  return null;
}
