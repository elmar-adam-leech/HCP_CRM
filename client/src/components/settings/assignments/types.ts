export interface AssignmentCondition {
  field: "source" | "campaign" | "adName" | "status" | "tag";
  operator: "equals" | "contains" | "startsWith";
  value: string;
}

export interface AssignmentRule {
  id: string;
  name: string;
  conditions: AssignmentCondition[];
  assignToUserId: string | null;
  assignToUserName: string | null;
  priority: number;
  isActive: boolean;
}

export interface RuleFormState {
  name: string;
  conditions: AssignmentCondition[];
  assignToUserId: string;
  priority: number;
  isActive: boolean;
}

export const FIELD_LABELS: Record<AssignmentCondition["field"], string> = {
  source: "Source",
  campaign: "Campaign",
  adName: "Ad Name",
  status: "Status",
  tag: "Tag",
};

export const OPERATOR_LABELS: Record<AssignmentCondition["operator"], string> = {
  equals: "equals",
  contains: "contains",
  startsWith: "starts with",
};

export const EMPTY_FORM: RuleFormState = {
  name: "",
  conditions: [],
  assignToUserId: "",
  priority: 0,
  isActive: true,
};
