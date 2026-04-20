import { useEffect } from "react";
import { useLocation } from "wouter";

type ShortcutConfig = {
  key: string;
  handler: () => void;
  description: string;
  requiresModifier?: boolean;
};

export function useKeyboardShortcuts(shortcuts: ShortcutConfig[], enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore events without a valid key
      if (!e.key) return;
      
      const target = e.target as HTMLElement;
      const isInputField = 
        target.tagName === "INPUT" || 
        target.tagName === "TEXTAREA" || 
        target.contentEditable === "true";

      for (const shortcut of shortcuts) {
        const hasModifier = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
        
        if (shortcut.requiresModifier && !hasModifier) continue;
        if (!shortcut.requiresModifier && hasModifier) continue;

        if (e.key.toLowerCase() === shortcut.key.toLowerCase()) {
          if (!isInputField || shortcut.key === "Escape") {
            e.preventDefault();
            shortcut.handler();
            break;
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts, enabled]);
}

export function useGlobalShortcuts(onNewItem?: (type: "lead" | "estimate" | "job") => void) {
  const [location, setLocation] = useLocation();

  const shortcuts: ShortcutConfig[] = [];

  if (location.includes("/leads")) {
    shortcuts.push({
      key: "n",
      handler: () => {
        if (onNewItem) onNewItem("lead");
        else setLocation("/leads?add=true");
      },
      description: "New Lead",
    });
  }

  if (location.includes("/estimates")) {
    shortcuts.push({
      key: "n",
      handler: () => {
        if (onNewItem) onNewItem("estimate");
        else setLocation("/estimates?add=true");
      },
      description: "New Estimate",
    });
  }

  if (location.includes("/jobs")) {
    shortcuts.push({
      key: "n",
      handler: () => {
        if (onNewItem) onNewItem("job");
        else setLocation("/jobs?add=true");
      },
      description: "New Job",
    });
  }

  shortcuts.push({
    key: "/",
    handler: () => {
      const searchInput = document.querySelector('[data-testid="input-search"]') as HTMLInputElement;
      if (searchInput) {
        searchInput.focus();
      }
    },
    description: "Focus Search",
  });

  shortcuts.push({
    key: "Escape",
    handler: () => {
      const closeButtons = document.querySelectorAll('[data-testid*="button-close"]');
      if (closeButtons.length > 0) {
        (closeButtons[closeButtons.length - 1] as HTMLElement).click();
      }
    },
    description: "Close Modal/Dialog",
  });

  useKeyboardShortcuts(shortcuts);
}
