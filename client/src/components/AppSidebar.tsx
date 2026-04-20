import {
  LayoutDashboard,
  Users,
  Briefcase,
  Calendar,
  MessageSquare,
  Settings,
  ScrollText,
  BarChart3,
  Plus,
  FileText,
  Workflow,
  Clock,
  BookUser,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { useWebSocketInvalidation } from "@/hooks/useWebSocketInvalidation";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { ContractorSwitcher } from "./TenantSwitcher";
import { useLocation, Link } from "wouter";
import { useTerminologyContext } from "@/contexts/TerminologyContext";
import type { TerminologySettings } from "@shared/schema";

export interface SidebarContractor {
  id: string;
  name: string;
  domain: string;
  role?: string;
  bookingSlug?: string | null;
  logoUrl?: string | null;
}

// Default menu item structure (will be customized with terminology)
const getMenuItems = (terminology?: Partial<TerminologySettings>) => [
  {
    title: "Dashboard",
    url: "/dashboard",
    icon: LayoutDashboard,
  },
  {
    title: terminology?.leadsLabel || "Leads",
    url: "/leads",
    icon: Users,
  },
  {
    title: terminology?.estimatesLabel || "Estimates",
    url: "/estimates",
    icon: Calendar,
  },
  {
    title: terminology?.jobsLabel || "Jobs",
    url: "/jobs",
    icon: Briefcase,
  },
  {
    title: "Contacts",
    url: "/contacts",
    icon: BookUser,
  },
  {
    title: "Follow-Ups",
    url: "/follow-ups",
    icon: Clock,
  },
  {
    title: terminology?.messagesLabel || "Messages",
    url: "/messages",
    icon: MessageSquare,
  },
  {
    title: terminology?.templatesLabel || "Templates",
    url: "/templates",
    icon: FileText,
  },
  {
    title: "Workflows",
    url: "/workflows/manage",
    icon: Workflow,
  },
  {
    title: "Reports",
    url: "/reports",
    icon: BarChart3,
  },
];

const getQuickActions = (terminology?: Partial<TerminologySettings>) => [
  {
    title: `New ${terminology?.leadLabel || "Lead"}`,
    action: "create-lead",
    icon: Users,
  },
  {
    title: `New ${terminology?.estimateLabel || "Estimate"}`,
    action: "create-estimate", 
    icon: Calendar,
  },
  {
    title: `New ${terminology?.jobLabel || "Job"}`,
    action: "create-job",
    icon: Briefcase,
  },
];

type AppSidebarProps = {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    avatar?: string;
  };
  contractors: SidebarContractor[];
  currentContractor: SidebarContractor | null;
  onContractorChange: (contractor: SidebarContractor) => void;
  onQuickAction?: (action: string) => void;
};

export function AppSidebar({
  user,
  contractors,
  currentContractor,
  onContractorChange,
  onQuickAction,
}: AppSidebarProps) {
  const [location] = useLocation();
  const { setOpenMobile, isMobile } = useSidebar();
  const isAdmin = user.role === 'admin' || user.role === 'super_admin';

  const terminology = useTerminologyContext();

  const menuItems = getMenuItems(terminology);
  const quickActions = getQuickActions(terminology);

  const visibleMenuItems = menuItems;

  useWebSocketInvalidation([
    { types: ['new_message', 'messages_read'], queryKeys: ['/api/messages/unread-count'] },
  ]);

  const { data: unreadData } = useQuery<{ unreadCount: number }>({
    queryKey: ['/api/messages/unread-count'],
  });

  const handleQuickAction = (action: string) => {
    onQuickAction?.(action);
  };

  // Close mobile sidebar when navigation link is clicked
  const handleNavClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return (
    <Sidebar>
      <SidebarHeader className="border-b p-4">
        {contractors.length > 1 && currentContractor ? (
          <ContractorSwitcher
            contractors={contractors}
            currentContractor={currentContractor}
            onContractorChange={onContractorChange}
          />
        ) : (
          <div className="flex items-center gap-2">
            <img
              src={currentContractor?.logoUrl || "/hcp-crm-logo.png"}
              alt={currentContractor?.name || "HCP CRM"}
              className="h-8 w-8 object-contain shrink-0"
            />
            <span className="font-semibold text-sm">{currentContractor?.name || "HCP CRM"}</span>
          </div>
        )}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleMenuItems.map((item) => {
                const isMessages = item.url === "/messages";
                const unreadCount = isMessages ? (unreadData?.unreadCount || 0) : 0;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={location === item.url}
                      data-testid={`nav-${item.title.toLowerCase()}`}
                    >
                      <Link 
                        href={item.url}
                        onClick={handleNavClick}
                      >
                        <item.icon />
                        <span className="flex-1">{item.title}</span>
                        {isMessages && unreadCount > 0 && (
                          <Badge variant="default" className="text-xs no-default-hover-elevate no-default-active-elevate">
                            {unreadCount}
                          </Badge>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        
        <SidebarGroup>
          <SidebarGroupLabel>Quick Actions</SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="space-y-2 px-2">
              {quickActions.map((action) => (
                <Button
                  key={action.action}
                  variant="outline"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => handleQuickAction(action.action)}
                  data-testid={`quick-${action.action}`}
                >
                  <Plus className="mr-2 h-3 w-3" />
                  {action.title}
                </Button>
              ))}
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      
      <SidebarFooter className="border-t">
        <SidebarMenu>
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild data-testid="nav-audit-log">
                <Link href="/audit-log" onClick={handleNavClick}>
                  <ScrollText />
                  <span>Audit Log</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton asChild data-testid="nav-settings">
              <Link href="/settings" onClick={handleNavClick}>
                <Settings />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}