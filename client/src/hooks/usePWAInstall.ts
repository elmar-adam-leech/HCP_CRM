import { useState, useEffect } from "react";

// Capture the deferred prompt at module load time so we don't miss it
// even if the hook hasn't mounted yet. preventDefault() suppresses the
// automatic browser install banner.
let deferredPrompt: any = null;

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });
}

export function usePWAInstall() {
  const [canInstall, setCanInstall] = useState(!!deferredPrompt);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e;
      setCanInstall(true);
    };

    window.addEventListener("beforeinstallprompt", handler as EventListener);
    return () => window.removeEventListener("beforeinstallprompt", handler as EventListener);
  }, []);

  useEffect(() => {
    const handler = () => {
      deferredPrompt = null;
      setCanInstall(false);
    };
    window.addEventListener("appinstalled", handler);
    return () => window.removeEventListener("appinstalled", handler);
  }, []);

  const install = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      deferredPrompt = null;
      setCanInstall(false);
    }
  };

  return { canInstall, install };
}
