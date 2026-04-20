/**
 * Dialpad module — shared TypeScript interfaces.
 *
 * All types used across dialpad/* modules live here so no module imports
 * from another sibling (avoiding circular dependencies).
 */

// ---------------------------------------------------------------------------
// Dialpad API response shapes
// ---------------------------------------------------------------------------

export interface DialpadUser {
  id: string;
  display_name: string;
  emails?: string[];
  state: string;
  department?: string | null;
  role?: string | null;
  extension?: string | null;
}

export interface DialpadNumber {
  id: string;
  number: string;
  target_type: string;
  target_id?: string;
  department_id?: string;
  can_send_sms?: boolean;
  can_receive_sms?: boolean;
  can_make_calls?: boolean;
  can_receive_calls?: boolean;
}

export interface DialpadDepartment {
  id: string;
  name: string;
  office_id: string;
}

export interface DialpadApiResponse<T> {
  items: T[];
  total_count?: number;
  next_cursor?: string;
}

// ---------------------------------------------------------------------------
// Legacy types carried over from the original dialpad-service.ts
// ---------------------------------------------------------------------------

export interface LegacyDialpadMessage {
  to_numbers: string[];
  text: string;
  from_number?: string;
}

export interface LegacyDialpadCallRequest {
  to_number: string;
  from_number?: string;
  auto_record?: boolean;
}

export interface LegacyDialpadResponse {
  success: boolean;
  message?: string;
  error?: string;
  callId?: string;
  messageId?: string;
}

export interface LegacyDialpadCallResponse extends LegacyDialpadResponse {
  callId?: string;
  callUrl?: string;
}

export interface LegacyDialpadUser {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  display_name?: string;
  state?: string;
  department?: string | number;
  phone_numbers?: LegacyDialpadPhoneNumber[];
  departments?: number[];
}

export interface LegacyDialpadDepartment {
  id: number;
  name: string;
  phone_numbers?: LegacyDialpadPhoneNumber[];
}

export interface LegacyDialpadPhoneNumber {
  id: number;
  number: string;
  display_name?: string;
  type?: string;
  sms_enabled?: boolean;
  state?: string;
  department?: string | number;
  assigned_to?: string | number;
}

export interface LegacyDialpadApiResponse<T> {
  data?: T;
  items?: T[];
  success?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Dialpad call webhook event types
// ---------------------------------------------------------------------------

export type DialpadCallDirection = 'inbound' | 'outbound';

export type DialpadCallState =
  | 'calling'
  | 'ringing'
  | 'connected'
  | 'hangup'
  | 'all'
  | 'voicemail'
  | 'missed'
  | 'cancelled';

export type DialpadCallOutcome = 'answered' | 'missed' | 'cancelled' | 'voicemail';

export interface DialpadCallParticipant {
  /** Internal Dialpad user ID (present for internal legs) */
  id?: string | number;
  /** Display name of the participant */
  display_name?: string;
  /** Phone number of the participant */
  phone?: string;
  /** Dialpad username / email */
  username?: string;
}

export interface DialpadCallContactInfo {
  phone?: string;
  type?: string;
  id?: string | number;
  name?: string;
  email?: string;
}

export interface DialpadCallTargetInfo {
  phone?: string;
  type?: string;
  id?: string | number;
  name?: string;
  email?: string;
  office_id?: number;
}

export interface DialpadRecordingDetail {
  id?: string | number;
  url?: string;
  duration?: number;
  start_time?: number;
  recording_type?: string;
}

export interface DialpadCallEvent {
  call_id: string | number;
  state: DialpadCallState;
  direction?: DialpadCallDirection;
  duration?: number;
  total_duration?: number;
  external_number?: string;
  contact_number?: string;
  internal_number?: string;
  to_number?: string;
  from_number?: string;
  contact?: DialpadCallContactInfo;
  target?: DialpadCallTargetInfo;
  operator_name?: string;
  operator_id?: string | number;
  recording_url?: string | string[];
  recording_details?: DialpadRecordingDetail[];
  date_started?: number;
  date_connected?: number;
  date_ended?: number;
  date_rang?: number;
  voicemail_link?: string;
  voicemail_url?: string;
  was_recorded?: boolean;
  is_transferred?: boolean;
  transcription?: string;
  transcription_text?: string;
  entry_point_target?: DialpadCallTargetInfo;
  group_id?: string;
  master_call_id?: number;
  entry_point_call_id?: number;
  operator_call_id?: number;
  /**
   * Server-side timestamp Dialpad assigns to each event in a call's lifecycle.
   * Used to detect out-of-order delivery so a stale event cannot clobber the
   * data written by a newer one for the same call_id. Treat as epoch ms.
   */
  event_timestamp?: number;
}
