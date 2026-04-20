export interface HousecallProCustomer {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  mobile_number?: string;
  home_number?: string;
  work_number?: string;
  company?: string;
  phone_numbers?: Array<{
    phone_number: string;
    type?: string;
  }>;
  address?: {
    id?: string;
    street?: string;
    street_line_2?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  addresses?: Array<{
    id?: string;
    street?: string;
    street_line_2?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    type?: string;
  }>;
}

export interface HousecallProEmployee {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  is_active: boolean;
}

export interface HousecallProEstimate {
  id: string;
  number?: string;
  estimate_number?: string;
  name?: string;
  customer_id?: string;
  customer?: HousecallProCustomer;
  employee_id?: string;
  work_status?: string;
  status?: string;
  total_amount?: number;
  total?: number;
  total_price?: number;
  estimate_total?: number;
  amount?: number;
  description?: string;
  created_at?: string;
  modified_at?: string;
  expires_at?: string;
  expiry_date?: string;
  valid_until?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  schedule?: { scheduled_start?: string; scheduled_end?: string };
  service_location?: {
    street?: string;
    street_line_2?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  address?: {
    street?: string;
    street_line_2?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  source?: {
    name?: string;
  };
  message?: string;
  options?: Array<{
    id: string;
    name?: string;
    message?: string;
    option_number?: string;
    total_amount?: number;
    approval_status?: string;
  }>;
  work_timestamps?: {
    on_my_way_at?: string;
    started_at?: string;
    completed_at?: string;
  };
  line_items?: Array<{
    name: string;
    description?: string;
    quantity: number;
    unit_cost: number;
    total_amount?: number;
  }>;
}

/**
 * Shape returned by HCP's /leads/{id}/convert endpoint when it wraps the
 * result in a lead object rather than returning the estimate directly.
 * The `conversions` array contains the IDs of the created estimate/job.
 */
export interface HcpLeadConvertResponse {
  id: string;
  conversions?: Array<{ id: string; type?: string }>;
}

export interface HousecallProJob {
  id: string;
  invoice_number?: string;
  description?: string;
  customer_id?: string;
  customer?: HousecallProCustomer;
  work_status?: string;
  total_amount?: number;
  outstanding_balance?: number;
  subtotal?: number;
  schedule?: {
    scheduled_start?: string;
    scheduled_end?: string;
    arrival_window?: number;
    appointments?: unknown[];
  };
  scheduled_start?: string;
  address?: {
    id?: string;
    type?: string;
    street?: string;
    street_line_2?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  notes?: Array<{ id: string; content: string }>;
  work_timestamps?: {
    on_my_way_at?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
  };
  assigned_employees?: Array<{
    id: string;
    first_name: string;
    last_name: string;
    email?: string;
    mobile_number?: string;
    role?: string;
  }>;
  tags?: string[];
  original_estimate_id?: string | null;
  original_estimate_uuids?: string[];
  lead_source?: string | null;
  job_fields?: {
    job_type?: string | null;
    business_unit?: string | null;
  };
  locked_at?: string | null;
  created_at?: string;
  updated_at?: string;
  company_name?: string;
  company_id?: string;
  recurrence_number?: number | null;
  recurrence_rule?: string | null;
  // Per-line catalog data captured for service-history awareness (Task #435).
  line_items?: Array<{ [key: string]: unknown }>;
  // Payment summary returned with job.paid webhooks (Task #435). Each entry
  // holds amount/currency/payment_method/created_at and a deposit flag.
  payments?: Array<{ [key: string]: unknown }>;
  // Pre-multi-employee field still surfaced by some HCP webhooks.
  employee_id?: string;
  assigned_employee_id?: string;
}

export interface HousecallProResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface HousecallProEvent {
  id: string;
  title?: string;
  name?: string;
  schedule?: {
    start_time?: string;
    end_time?: string;
    time_zone?: string;
  };
  start_time?: string;
  end_time?: string;
  starts_at?: string;
  ends_at?: string;
  start_at?: string;
  end_at?: string;
  start?: string;
  end?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  status?: string;
  assigned_employees?: Array<{
    id: string;
    first_name?: string;
    last_name?: string;
  }>;
  employees?: Array<{
    id: string;
    first_name?: string;
    last_name?: string;
  }>;
  [key: string]: unknown;
}

export interface HcpPageEnvelope<T> {
  data?: T[];
  estimates?: T[];
  jobs?: T[];
  events?: T[];
  total_pages?: number;
  total_items?: number;
  page?: number;
  page_size?: number;
  [key: string]: unknown;
}

export interface HcpDispatchedEmployee {
  id: string;
  [key: string]: unknown;
}

export interface HcpEstimateOption {
  id?: string;
  name?: string;
  option_number?: string;
  total_amount?: number;
  approval_status?: string;
  schedule?: {
    scheduled_start?: string;
    scheduled_end?: string;
    start_time?: string;
    end_time?: string;
    dispatched_employees?: HcpDispatchedEmployee[];
    [key: string]: unknown;
  };
  scheduled_start?: string;
  scheduled_end?: string;
  dispatched_employees?: HcpDispatchedEmployee[];
  [key: string]: unknown;
}

export type HcpEstimateRaw = Omit<HousecallProEstimate, 'options'> & {
  assigned_employee_id?: string;
  options?: HcpEstimateOption[];
  assigned_employees?: Array<{ id: string; [key: string]: unknown }>;
};
