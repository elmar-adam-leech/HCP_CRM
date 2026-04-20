export interface ContractorMembership {
  contractorId: string;
  role: string;
  contractor: { id: string; name: string; domain: string; logoUrl?: string | null };
}

export interface ActiveContractor {
  id: string;
  name: string;
  domain: string;
  role: string;
  logoUrl?: string | null;
}
