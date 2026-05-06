export const SYNC_BATCH_SIZE = 100;

// Maximum wall-clock time a single HCP sync is allowed to run before being considered
// stalled. This guards against runaway syncs holding the in-memory lock forever.
// 5 minutes — long enough for large tenants (~thousands of records), but short enough
// that a crash-looping sync does not block the next scheduled run indefinitely.
export const HCP_SYNC_MAX_RUNTIME_MS = 5 * 60_000;

export interface HcpPhoneNumber {
  phone_number?: string;
}

export interface HcpAddress {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface HcpCustomer {
  id?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  email?: string;
  mobile_number?: string;
  home_number?: string;
  work_number?: string;
  phone_numbers?: HcpPhoneNumber[];
  address?: HcpAddress;
  lead_source?: string | null;
}

export interface HcpSchedule {
  scheduled_start?: string;
}

export interface HcpOption {
  id?: string;
  name?: string;
  option_number?: string;
  total_amount?: number;
  approval_status?: string;
  approval_status_changed_at?: string | null;
  dispatched_employees?: Array<{ id: string; [key: string]: unknown }>;
  schedule?: {
    scheduled_start?: string;
    scheduled_end?: string;
    dispatched_employees?: Array<{ id: string; [key: string]: unknown }>;
  };
  line_items?: HcpRawLineItem[];
}

export interface HcpRawLineItem {
  id?: string;
  uuid?: string;
  name?: string;
  description?: string;
  quantity?: number | string;
  unit_price?: number | string;
  unit_cost?: number | string;
  amount?: number | string;
  total?: number | string;
  total_amount?: number | string;
  kind?: string;
  type?: string;
  service_item_id?: string;
}

export interface HcpPayment {
  id?: string;
  amount?: number;
  payment_method?: string;
  method?: string;
  type?: string;
  kind?: string;
  is_deposit?: boolean;
  paid_at?: string;
  created_at?: string;
}

export interface HcpEstimate {
  id: string;
  status?: string;
  work_status?: string;
  number?: string;
  estimate_number?: string;
  name?: string;
  description?: string;
  total?: number;
  total_price?: number;
  estimate_total?: number;
  amount?: number;
  employee_id?: string;
  assigned_employee_id?: string;
  assigned_employees?: Array<{ id: string; [key: string]: unknown }>;
  options?: HcpOption[];
  schedule?: { scheduled_start?: string; scheduled_end?: string };
  customer?: HcpCustomer;
  created_at?: string;
  // Top-level timestamp HCP stamps when the estimate document is first sent
  // to the customer. Used (alongside `mapHcpEstimateStatus(...) === 'sent'`)
  // to populate the local `documentSentAt` field — see task #721.
  sent_at?: string;
  line_items?: HcpRawLineItem[];
}

export interface HcpJob {
  id: string;
  work_status?: string;
  invoice_number?: string;
  description?: string;
  total_amount?: number;
  scheduled_start?: string;
  schedule?: HcpSchedule;
  customer_id?: string;
  customer?: HcpCustomer;
  estimate_id?: string;
  line_items?: HcpRawLineItem[];
  payments?: HcpPayment[];
  assigned_employees?: Array<{ id: string; [key: string]: unknown }>;
}

export interface HcpEmployee {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  is_active?: boolean;
  role?: string;
}
