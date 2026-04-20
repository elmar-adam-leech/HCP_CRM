import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  Users,
  Calendar,
  Briefcase,
  MessageSquare,
  FileText,
  BarChart3,
  Settings,
  UsersRound,
  Plus,
  Search,
} from "lucide-react";

interface CommandPaletteProps {
  terminology?: {
    leadLabel?: string;
    leadsLabel?: string;
    estimateLabel?: string;
    estimatesLabel?: string;
    jobLabel?: string;
    jobsLabel?: string;
    messageLabel?: string;
    messagesLabel?: string;
    templateLabel?: string;
    templatesLabel?: string;
  };
}

export function CommandPalette({ terminology }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();

  // Listen for Cmd+K or Ctrl+K
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const navigationItems = [
    {
      title: "Dashboard",
      url: "/dashboard",
      icon: LayoutDashboard,
      keywords: ["home", "overview"],
    },
    {
      title: terminology?.leadsLabel || "Leads",
      url: "/leads",
      icon: Users,
      keywords: ["customers", "prospects", "contacts"],
    },
    {
      title: "Follow-ups",
      url: "/follow-ups",
      icon: Calendar,
      keywords: ["tasks", "reminders", "schedule"],
    },
    {
      title: terminology?.estimatesLabel || "Estimates",
      url: "/estimates",
      icon: Calendar,
      keywords: ["quotes", "proposals", "bids"],
    },
    {
      title: terminology?.jobsLabel || "Jobs",
      url: "/jobs",
      icon: Briefcase,
      keywords: ["work", "projects", "tasks"],
    },
    {
      title: terminology?.messagesLabel || "Messages",
      url: "/messages",
      icon: MessageSquare,
      keywords: ["chat", "sms", "email", "conversations"],
    },
    {
      title: terminology?.templatesLabel || "Templates",
      url: "/templates",
      icon: FileText,
      keywords: ["text", "email", "saved"],
    },
    {
      title: "Reports",
      url: "/reports",
      icon: BarChart3,
      keywords: ["analytics", "stats", "data"],
    },
    {
      title: "Settings",
      url: "/settings",
      icon: Settings,
      keywords: ["config", "preferences", "account"],
    },
    {
      title: "User Management",
      url: "/users",
      icon: UsersRound,
      keywords: ["team", "employees", "permissions"],
    },
  ];

  const quickActions = [
    {
      title: `New ${terminology?.leadLabel || "Lead"}`,
      action: () => {
        setOpen(false);
        setLocation("/leads?add=true");
      },
      icon: Plus,
      keywords: ["create", "add", "new"],
      shortcut: "N",
    },
    {
      title: `New ${terminology?.estimateLabel || "Estimate"}`,
      action: () => {
        setOpen(false);
        setLocation("/estimates?add=true");
      },
      icon: Plus,
      keywords: ["create", "add", "new", "quote"],
      shortcut: "E",
    },
    {
      title: `New ${terminology?.jobLabel || "Job"}`,
      action: () => {
        setOpen(false);
        setLocation("/jobs?add=true");
      },
      icon: Plus,
      keywords: ["create", "add", "new", "work"],
      shortcut: "J",
    },
  ];

  const handleNavigate = (url: string) => {
    setOpen(false);
    setLocation(url);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." data-testid="input-command-palette" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        
        <CommandGroup heading="Quick Actions">
          {quickActions.map((action) => (
            <CommandItem
              key={action.title}
              onSelect={action.action}
              keywords={action.keywords}
              data-testid={`command-item-${action.title.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <action.icon className="mr-2 h-4 w-4" />
              <span>{action.title}</span>
              {action.shortcut && (
                <CommandShortcut>{action.shortcut}</CommandShortcut>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Navigation">
          {navigationItems.map((item) => (
            <CommandItem
              key={item.url}
              onSelect={() => handleNavigate(item.url)}
              keywords={item.keywords}
              data-testid={`command-item-nav-${item.title.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <item.icon className="mr-2 h-4 w-4" />
              <span>{item.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Keyboard Shortcuts">
          <CommandItem disabled data-testid="command-item-shortcut-help">
            <Search className="mr-2 h-4 w-4" />
            <span>Search</span>
            <CommandShortcut>/</CommandShortcut>
          </CommandItem>
          <CommandItem disabled data-testid="command-item-shortcut-command">
            <LayoutDashboard className="mr-2 h-4 w-4" />
            <span>Command Palette</span>
            <CommandShortcut>⌘K</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
