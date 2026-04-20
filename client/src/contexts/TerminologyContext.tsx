import { createContext, useContext, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWebSocketContext } from "@/contexts/WebSocketContext";
import type { TerminologySettings } from "@shared/schema";

type TerminologyData = Partial<TerminologySettings>;

const TerminologyContext = createContext<TerminologyData>({});

export function TerminologyProvider({ children }: { children: React.ReactNode }) {
  const { data } = useQuery<TerminologySettings>({
    queryKey: ["/api/terminology"],
  });

  const queryClient = useQueryClient();
  const { subscribe } = useWebSocketContext();

  useEffect(() => {
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'terminology_updated') {
        queryClient.invalidateQueries({ queryKey: ["/api/terminology"] });
      }
    });
    return unsubscribe;
  }, [subscribe, queryClient]);

  return (
    <TerminologyContext.Provider value={data ?? {}}>
      {children}
    </TerminologyContext.Provider>
  );
}

export function useTerminologyContext(): TerminologyData {
  return useContext(TerminologyContext);
}
