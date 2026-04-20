import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWebSocketContext } from "@/contexts/WebSocketContext";

interface WebSocketRule {
  types: string[];
  queryKeys: string[];
}

const DEBOUNCE_MS = 400;

export function useWebSocketInvalidation(rules: WebSocketRule[]) {
  const { subscribe } = useWebSocketContext();
  const queryClient = useQueryClient();
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  const pendingKeysRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const keys = Array.from(pendingKeysRef.current);
    pendingKeysRef.current.clear();
    timerRef.current = null;
    for (const key of keys) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [queryClient]);

  useEffect(() => {
    const unsubscribe = subscribe((message: { type: string }) => {
      for (const rule of rulesRef.current) {
        if (rule.types?.includes(message.type)) {
          for (const key of rule.queryKeys) {
            pendingKeysRef.current.add(key);
          }
        }
      }

      if (pendingKeysRef.current.size > 0 && !timerRef.current) {
        timerRef.current = setTimeout(flush, DEBOUNCE_MS);
      }
    });

    return () => {
      unsubscribe();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [subscribe, flush]);
}
