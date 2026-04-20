import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

interface DetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
  desktopMaxWidth?: string;
}

export function DetailsModal({
  isOpen,
  onClose,
  title,
  description,
  children,
  desktopMaxWidth = "max-w-2xl",
}: DetailsModalProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="bottom" className="rounded-t-2xl px-4 pt-4 pb-6 max-h-[75vh] flex flex-col">
          <SheetHeader className="text-left mb-4">
            <SheetTitle className="text-base leading-snug pr-8">{title}</SheetTitle>
            <SheetDescription className="text-xs">{description}</SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto overflow-x-hidden flex-1 -mx-4 px-4">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={`w-full ${desktopMaxWidth} max-w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto overflow-x-hidden`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
