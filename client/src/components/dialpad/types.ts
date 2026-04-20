export interface DialpadUser {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  extension: string;
  department?: string;
}

export interface DialpadPhoneNumber {
  id: string;
  phoneNumber: string;
  displayName?: string;
  department?: string;
  canSendSms: boolean;
  canMakeCalls: boolean;
  isActive: boolean;
  permissions?: Array<{
    userId: string;
    canSendSms: boolean;
    canMakeCalls: boolean;
  }>;
}

export interface UserPermission {
  userId: string;
  userName: string;
  userEmail: string;
  canSendSms: boolean;
  canMakeCalls: boolean;
}
