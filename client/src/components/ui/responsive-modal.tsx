import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

const SHEET_BREAKPOINT = 640;

export function useIsBelowSm() {
  const [isBelow, setIsBelow] = React.useState<boolean>(() =>
    typeof window !== "undefined" && window.innerWidth < SHEET_BREAKPOINT
  );
  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${SHEET_BREAKPOINT - 1}px)`);
    const onChange = () => setIsBelow(window.innerWidth < SHEET_BREAKPOINT);
    mql.addEventListener("change", onChange);
    setIsBelow(window.innerWidth < SHEET_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isBelow;
}

interface ResponsiveModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  titleClassName?: string;
  titleTestId?: string;
  ariaDescribedBy?: string;
  dataTestId?: string;
  desktopContentClassName?: string;
  mobileContentClassName?: string;
  children: React.ReactNode;
}

export function ResponsiveModal({
  open,
  onOpenChange,
  title,
  titleClassName,
  titleTestId,
  ariaDescribedBy,
  dataTestId,
  desktopContentClassName,
  mobileContentClassName,
  children,
}: ResponsiveModalProps) {
  const isMobile = useIsBelowSm();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          className={cn(
            "h-[100dvh] max-h-[100dvh] flex flex-col p-0 pb-[env(safe-area-inset-bottom)]",
            mobileContentClassName,
          )}
          data-testid={dataTestId}
          aria-describedby={ariaDescribedBy}
        >
          <DrawerHeader className="px-4 py-4 border-b text-left shrink-0 space-y-0">
            <DrawerTitle
              className={cn("text-lg font-semibold", titleClassName)}
              data-testid={titleTestId}
            >
              {title}
            </DrawerTitle>
          </DrawerHeader>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("flex flex-col p-0", desktopContentClassName)}
        data-testid={dataTestId}
        aria-describedby={ariaDescribedBy}
      >
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <DialogTitle className={titleClassName} data-testid={titleTestId}>
            {title}
          </DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
