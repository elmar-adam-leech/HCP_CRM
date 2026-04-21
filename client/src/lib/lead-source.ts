/**
 * Friendly display label for a lead's `source` string.
 *
 * The CRM stores raw source keys like `facebook`, `google_local_services`,
 * `public_booking`, etc. on `leads.source`. This helper centralizes the
 * mapping to human-readable labels so every UI surface (lead list, lead
 * detail, submission history, exports) renders sources consistently.
 *
 * Unknown sources fall back to a Title-Cased version of the raw key.
 */
const SOURCE_LABELS: Record<string, string> = {
  facebook: 'Facebook',
  facebook_lead_ad: 'Facebook',
  facebook_history: 'Facebook',

  google: 'Google',
  google_local_services: 'Google Local Services',

  website: 'Website',
  public_booking: 'Website Booking',

  email: 'Email',
  email_capture: 'Email',

  referral: 'Referral',
  repeat_customer: 'Repeat Customer',

  yelp: 'Yelp',
  nextdoor: 'Nextdoor',
  angi: 'Angi',
  homeadvisor: 'HomeAdvisor',
  thumbtack: 'Thumbtack',

  webhook: 'Webhook',
  manual: 'Manual',
};

export function formatLeadSource(source: string | null | undefined): string {
  if (!source) return '';
  const key = source.toLowerCase();
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  // Title-case unknown keys: "some_thing-here" -> "Some Thing Here"
  return key
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}
