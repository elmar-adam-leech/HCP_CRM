import { useEffect, useState } from "react";

export function useIsAnyDialogOpen(): boolean {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const check = () => {
      const found = document.querySelector('[role="dialog"][data-state="open"]');
      setIsOpen(!!found);
    };

    check();

    const observer = new MutationObserver(() => {
      check();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state", "role"],
    });

    return () => observer.disconnect();
  }, []);

  return isOpen;
}
