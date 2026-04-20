import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageLayoutProps {
  children: ReactNode;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
  className?: string;
}

const maxWidthClasses = {
  sm: "max-w-3xl",
  md: "max-w-4xl", 
  lg: "max-w-6xl",
  xl: "max-w-7xl",
  "2xl": "max-w-screen-2xl",
  full: "max-w-full"
};

export function PageLayout({ 
  children, 
  maxWidth = "xl",
  className 
}: PageLayoutProps) {
  return (
    <div className={cn(
      "w-full overflow-x-hidden p-3 sm:p-6 pb-20 sm:pb-6 mx-auto space-y-6",
      maxWidthClasses[maxWidth],
      className
    )}>
      {children}
    </div>
  );
}