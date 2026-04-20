import { Link, useLocation } from "wouter";
import { Users, FileText, MessageSquare, Menu, BookUser } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useIsAnyDialogOpen } from "@/hooks/useIsAnyDialogOpen";
import { useUnreadSummary } from "@/hooks/useUnreadSummary";

type DotKey = "leads" | "estimates" | "messages";

const tabs: Array<{ href: string; icon: typeof Users; label: string; dotKey?: DotKey }> = [
  { href: "/leads", icon: Users, label: "Leads", dotKey: "leads" },
  { href: "/estimates", icon: FileText, label: "Estimates", dotKey: "estimates" },
  { href: "/contacts", icon: BookUser, label: "Contacts" },
  { href: "/messages", icon: MessageSquare, label: "Messages", dotKey: "messages" },
];

export function MobileBottomNav() {
  const isMobile = useIsMobile();
  const [location] = useLocation();
  const isDialogOpen = useIsAnyDialogOpen();
  const summary = useUnreadSummary();

  if (!isMobile) return null;
  if (isDialogOpen) return null;

  const handleMore = () => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="button-sidebar-toggle"]');
    trigger?.click();
  };

  const isActive = (href: string) => {
    return location.startsWith(href);
  };

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 bg-sidebar border-t flex items-stretch pb-[env(safe-area-inset-bottom)]"
      data-testid="mobile-bottom-nav"
    >
      {tabs.map(({ href, icon: Icon, label, dotKey }) => {
        const showDot = dotKey ? summary[dotKey] : false;
        return (
          <Link
            key={href}
            href={href}
            className={`flex flex-col items-center justify-center flex-1 py-2 gap-1 text-xs transition-colors ${
              isActive(href)
                ? "text-sidebar-primary font-medium"
                : "text-sidebar-foreground/60"
            }`}
            data-testid={`bottom-nav-${label.toLowerCase()}`}
          >
            <span className="relative">
              <Icon className="h-5 w-5" />
              {showDot && (
                <span
                  className="absolute -top-1 -right-1 flex h-2.5 w-2.5"
                  data-testid={`unread-dot-nav-${label.toLowerCase()}`}
                >
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
              )}
            </span>
            <span>{label}</span>
          </Link>
        );
      })}
      <button
        onClick={handleMore}
        className="flex flex-col items-center justify-center flex-1 py-2 gap-1 text-xs text-sidebar-foreground/60 transition-colors"
        data-testid="bottom-nav-more"
        type="button"
      >
        <Menu className="h-5 w-5" />
        <span>More</span>
      </button>
    </nav>
  );
}
