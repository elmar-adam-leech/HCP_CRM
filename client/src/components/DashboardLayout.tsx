import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { Header } from "./Header";
import { ThemeProvider } from "./ThemeProvider";
import { CommandPalette } from "./CommandPalette";
import { useTerminologyContext } from "@/contexts/TerminologyContext";
import { useWebSocketContext } from "@/contexts/WebSocketContext";
import { WifiOff } from "lucide-react";
import type { ActiveContractor } from "@/types/contractor";
import type { SidebarContractor } from "./AppSidebar";

type DashboardLayoutProps = {
  children: React.ReactNode;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    avatar?: string;
  };
  contractors: SidebarContractor[];
  currentContractor: ActiveContractor | null;
  onContractorChange: (contractor: ActiveContractor) => void;
  onSearch?: (query: string) => void;
  onQuickAction?: (action: string) => void;
};

function DisconnectedBanner() {
  const { isConnected } = useWebSocketContext();

  if (isConnected) return null;

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-destructive text-xs"
      role="status"
      aria-live="polite"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>Live updates paused — reconnecting. Data shown may be slightly out of date.</span>
    </div>
  );
}

export function DashboardLayout({
  children,
  user,
  contractors,
  currentContractor,
  onContractorChange,
  onSearch,
  onQuickAction,
}: DashboardLayoutProps) {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  // Shared terminology hook — single cache entry for the whole app
  const terminology = useTerminologyContext();

  return (
    <ThemeProvider defaultTheme="light" storageKey="crm-theme">
      <SidebarProvider style={style as React.CSSProperties}>
        <div className="flex h-screen w-full">
          <AppSidebar
            user={user}
            contractors={contractors}
            currentContractor={currentContractor}
            onContractorChange={onContractorChange as (contractor: SidebarContractor) => void}
            onQuickAction={onQuickAction}
          />
          <div className="flex flex-col flex-1 min-w-0">
            <Header
              user={user}
              onSearch={onSearch}
            />
            <DisconnectedBanner />
            <main className="flex-1 overflow-y-auto bg-background pb-16 md:pb-0">
              {children}
            </main>
          </div>
        </div>
        {/* Global Command Palette (Cmd+K) */}
        <CommandPalette terminology={terminology} />
      </SidebarProvider>
    </ThemeProvider>
  );
}