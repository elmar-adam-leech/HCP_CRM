import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Smartphone, MonitorSmartphone } from "lucide-react";
import { usePWAInstall } from "@/hooks/usePWAInstall";

export function InstallAppCard() {
  const { canInstall, install } = usePWAInstall();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="h-5 w-5" />
          Install App
        </CardTitle>
        <CardDescription>
          Add HCP CRM to your device for quick access without opening a browser
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex items-start gap-3 p-4 rounded-md border">
            <Smartphone className="h-5 w-5 mt-0.5 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">iPhone / iPad</p>
              <p className="text-xs text-muted-foreground">
                Open in Safari, tap the Share button (the box with an arrow), then tap <span className="font-medium">Add to Home Screen</span>.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-4 rounded-md border">
            <MonitorSmartphone className="h-5 w-5 mt-0.5 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Android / Desktop</p>
              {canInstall ? (
                <Button variant="ghost" className="p-0 h-auto text-xs" onClick={install} data-testid="button-install-pwa">
                  Install HCP CRM
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Open in Chrome or Edge, then return to this page to install.</p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
