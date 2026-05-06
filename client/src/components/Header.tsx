import { Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { UserMenu } from "./UserMenu";
import { ThemeToggle } from "./ThemeToggle";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { NotificationDropdown } from "./NotificationDropdown";
import { GlobalSearchDropdown } from "./GlobalSearchDropdown";

type HeaderProps = {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    avatar?: string;
  };
  onSearch?: (query: string) => void;
};

export function Header({
  user,
  onSearch,
}: HeaderProps) {
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const handleSettings = () => {
    setLocation("/settings");
  };

  const handleLogout = async () => {
    try {
      // Pull the IDB-stored refresh token (task #720) so the server can revoke
      // its row even if iOS Safari has already evicted the refresh cookie.
      const { getStoredRefreshToken, clearStoredRefreshToken } = await import(
        "@/lib/refresh-token-storage"
      );
      let refreshToken: string | null = null;
      try { refreshToken = await getStoredRefreshToken(); } catch {}
      await apiRequest(
        "POST",
        "/api/auth/logout",
        refreshToken ? { refreshToken } : undefined,
      );
      try { await clearStoredRefreshToken(); } catch {}
      toast({
        title: "Logged out successfully",
        description: "You have been logged out of your account.",
      });
      window.location.href = '/login';
    } catch (error) {
      console.error("Logout error:", error);
      toast({
        title: "Logout failed",
        description: "Failed to log out. Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <header className="flex items-center justify-between gap-2 sm:gap-4 border-b bg-background px-3 sm:px-4 py-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <SidebarTrigger data-testid="button-sidebar-toggle" className="hidden sm:flex" />
          <div className="hidden sm:block flex-1 max-w-xs sm:max-w-md">
            <GlobalSearchDropdown onSearch={onSearch} />
          </div>
        </div>
        
        <div className="flex items-center gap-1 sm:gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="sm:hidden"
            onClick={() => setMobileSearchOpen(!mobileSearchOpen)}
            data-testid="button-mobile-search"
          >
            <Search className="h-4 w-4" />
          </Button>
          
          <NotificationDropdown />
          
          <ThemeToggle />
          
          <UserMenu user={user} onSettingsClick={handleSettings} onLogout={handleLogout} />
        </div>
      </header>
      
      {/* Mobile Search Bar */}
      {mobileSearchOpen && (
        <div className="border-b bg-background px-3 py-2 sm:hidden">
          <GlobalSearchDropdown onSearch={onSearch} />
        </div>
      )}
    </>
  );
}
