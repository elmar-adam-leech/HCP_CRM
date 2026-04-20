import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  icon,
  actions,
  className
}: PageHeaderProps) {
  return (
    <div className={cn("mb-6", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-4">
          {icon && (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-100 shrink-0 border-4 border-green-400 shadow-lg">
              {icon}
            </div>
          )}
          <div>
            <h1 className="text-3xl font-bold tracking-tight" data-testid="page-title">
              {title}
            </h1>
            {description && (
              <p className="text-muted-foreground mt-1" data-testid="page-description">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}