import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

type WorkflowEnrollment = {
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  currentStep: number | null;
  startedAt: string | null;
};

type EnrollmentMap = Record<string, WorkflowEnrollment[]>;

const WorkflowEnrollmentContext = createContext<EnrollmentMap | null>(null);

export function WorkflowEnrollmentProvider({
  contactIds,
  children,
}: {
  contactIds: string[];
  children: React.ReactNode;
}) {
  const sortedIds = useMemo(() => [...contactIds].sort(), [contactIds]);
  const idKey = useMemo(() => sortedIds.join(","), [sortedIds]);

  const { data: enrollmentMap = {} } = useQuery<EnrollmentMap>({
    queryKey: ["/api/contacts/bulk/workflow-enrollments", idKey],
    queryFn: async () => {
      if (sortedIds.length === 0) return {};
      const res = await apiRequest("POST", "/api/contacts/bulk/workflow-enrollments", {
        contactIds: sortedIds,
      });
      return res.json();
    },
    enabled: sortedIds.length > 0,
    staleTime: 30_000,
  });

  return (
    <WorkflowEnrollmentContext.Provider value={enrollmentMap}>
      {children}
    </WorkflowEnrollmentContext.Provider>
  );
}

export function useBulkEnrollments(): EnrollmentMap | null {
  return useContext(WorkflowEnrollmentContext);
}
