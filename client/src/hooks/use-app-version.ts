import { useState, useEffect } from 'react';

export function useAppVersion() {
  const [showRefreshBanner, setShowRefreshBanner] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [newVersion, setNewVersion] = useState<string | null>(null);

  useEffect(() => {
    let broadcastChannel: BroadcastChannel | null = null;

    if ('BroadcastChannel' in window) {
      broadcastChannel = new BroadcastChannel('app_version_updates');
      broadcastChannel.addEventListener('message', (event) => {
        if (event.data.type === 'version_changed') {
          setNewVersion(event.data.newVersion);
          sessionStorage.removeItem('refresh_banner_dismissed');
          setDismissed(false);
          setShowRefreshBanner(true);
        }
      });
    }

    const checkForUpdates = async () => {
      try {
        const response = await fetch('/api/version', { method: 'GET', cache: 'no-cache' });
        if (!response.ok) return;

        const { version: currentVersion } = await response.json();
        const tabKnownVersion = sessionStorage.getItem('tab_known_version');
        const acknowledgedVersion = localStorage.getItem('app_acknowledged_version');

        if (!tabKnownVersion) {
          sessionStorage.setItem('tab_known_version', currentVersion);
          if (!acknowledgedVersion) {
            localStorage.setItem('app_acknowledged_version', currentVersion);
          }
          return;
        }

        if (tabKnownVersion !== currentVersion) {
          setNewVersion(currentVersion);
          sessionStorage.removeItem('refresh_banner_dismissed');
          setDismissed(false);
          setShowRefreshBanner(true);

          if (broadcastChannel) {
            broadcastChannel.postMessage({
              type: 'version_changed',
              newVersion: currentVersion,
              oldVersion: tabKnownVersion,
            });
          }
        }
      } catch {
        // Silent fail — version check is non-critical
      }
    };

    // Check once on mount (covers login / initial page load)
    checkForUpdates();

    // Re-check whenever the user returns to this tab (covers coming back after a deployment)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkForUpdates();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (broadcastChannel) broadcastChannel.close();
    };
  }, [dismissed]);

  const handleRefresh = async () => {
    try {
      const versionToAcknowledge = newVersion || sessionStorage.getItem('tab_known_version');
      if (versionToAcknowledge) {
        sessionStorage.setItem('tab_known_version', versionToAcknowledge);
        localStorage.setItem('app_acknowledged_version', versionToAcknowledge);
        sessionStorage.removeItem('refresh_banner_dismissed');
      }

      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(cacheName => caches.delete(cacheName)));
      }

      window.location.reload();
    } catch {
      window.location.reload();
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    setShowRefreshBanner(false);
    sessionStorage.setItem('refresh_banner_dismissed', 'true');
  };

  useEffect(() => {
    if (sessionStorage.getItem('refresh_banner_dismissed')) {
      setDismissed(true);
      setShowRefreshBanner(false);
    }
  }, []);

  return { showRefreshBanner, handleRefresh, handleDismiss };
}
