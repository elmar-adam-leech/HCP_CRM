import type {
  InsertUser,
  InsertContractor,
  InsertContact,
  InsertJob,
  InsertEstimate,
  InsertMessage,
  InsertTemplate,
  InsertContractorCredential,
  InsertContractorProvider,
  InsertContractorIntegration,
  InsertEmployee,
  InsertActivity,
  InsertBusinessTargets,
  InsertDialpadPhoneNumber,
  InsertUserPhoneNumberPermission,
  InsertDialpadUser,
  InsertDialpadDepartment,
  InsertDialpadSyncJob,
  InsertSyncSchedule,
  InsertTerminologySettings,
  InsertWorkflow,
  InsertWorkflowStep,
  InsertWorkflowExecution,
  InsertLeadCaptureInbox,
} from "@shared/schema";

export type UpdateUser = Omit<Partial<InsertUser>, 'contractorId'>;
export type UpdateContractor = Partial<InsertContractor>;
export type UpdateContact = Omit<Partial<InsertContact>, 'contractorId'>;
export type UpdateJob = Omit<Partial<InsertJob>, 'contractorId' | 'contactId'>;
export type UpdateEstimate = Omit<Partial<InsertEstimate>, 'contractorId' | 'contactId'>;
export type UpdateMessage = Omit<Partial<InsertMessage>, 'contractorId'>;
export type UpdateTemplate = Omit<Partial<InsertTemplate>, 'contractorId'>;
export type UpdateContractorCredential = Omit<Partial<InsertContractorCredential>, 'contractorId' | 'service' | 'credentialKey'>;
export type UpdateContractorProvider = Omit<Partial<InsertContractorProvider>, 'contractorId' | 'providerType'>;
export type UpdateContractorIntegration = Omit<Partial<InsertContractorIntegration>, 'contractorId' | 'integrationName'>;
export type UpdateEmployee = Omit<Partial<InsertEmployee>, 'contractorId' | 'externalSource' | 'externalId'>;
export type UpdateActivity = Omit<Partial<InsertActivity>, 'contractorId'>;
export type UpdateBusinessTargets = Omit<Partial<InsertBusinessTargets>, 'contractorId'>;
export type UpdateDialpadPhoneNumber = Omit<Partial<InsertDialpadPhoneNumber>, 'contractorId' | 'phoneNumber'>;
export type UpdateUserPhoneNumberPermission = Omit<Partial<InsertUserPhoneNumberPermission>, 'userId' | 'phoneNumberId' | 'contractorId'>;
export type UpdateDialpadUser = Omit<Partial<InsertDialpadUser>, 'contractorId' | 'dialpadUserId'>;
export type UpdateDialpadDepartment = Omit<Partial<InsertDialpadDepartment>, 'contractorId' | 'dialpadDepartmentId'>;
export type UpdateDialpadSyncJob = Omit<Partial<InsertDialpadSyncJob>, 'contractorId' | 'syncType'>;
export type UpdateSyncSchedule = Omit<Partial<InsertSyncSchedule>, 'contractorId' | 'integrationName'>;
export type UpdateTerminologySettings = Omit<Partial<InsertTerminologySettings>, 'contractorId'>;
export type UpdateWorkflow = Omit<Partial<InsertWorkflow>, 'contractorId' | 'createdBy'>;
export type UpdateWorkflowStep = Omit<Partial<InsertWorkflowStep>, 'workflowId'>;
export type UpdateWorkflowExecution = Omit<Partial<InsertWorkflowExecution>, 'workflowId' | 'contractorId'>;
export type UpdateLeadCaptureInbox = Omit<Partial<InsertLeadCaptureInbox>, 'contractorId'>;
