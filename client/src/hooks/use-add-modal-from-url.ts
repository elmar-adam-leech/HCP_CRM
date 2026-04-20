import { useEffect, useRef } from "react";
import { useLocation } from "wouter";

export function useAddModalFromUrl(onOpen: () => void) {
  const [location] = useLocation();
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("add") === "true") {
      onOpenRef.current();
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [location]);
}
