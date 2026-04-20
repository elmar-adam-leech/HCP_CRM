import { type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

interface IntegrationCardShellProps {
  icon: ReactNode;
  iconClassName?: string;
  iconStyle?: React.CSSProperties;
  title: string;
  titleExtra?: ReactNode;
  description: string;
  statusIcon: ReactNode;
  headerExtra?: ReactNode;
  isLoading: boolean;
  children: ReactNode;
  "data-testid"?: string;
}

export function IntegrationCardShell({
  icon,
  iconClassName = "bg-muted",
  iconStyle,
  title,
  titleExtra,
  description,
  statusIcon,
  headerExtra,
  isLoading,
  children,
  "data-testid": dataTestId,
}: IntegrationCardShellProps) {
  if (isLoading) {
    return (
      <Card className="min-w-0" data-testid={dataTestId}>
        <CardHeader className="pb-3">
          <div className="animate-pulse space-y-2">
            <div className="h-5 bg-muted rounded w-24" />
            <div className="h-4 bg-muted rounded w-48" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-8 bg-muted rounded animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="min-w-0" data-testid={dataTestId}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-lg shrink-0 ${iconClassName}`}
              style={iconStyle}
            >
              {icon}
            </div>
            <div className="min-w-0">
              {titleExtra ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-lg">{title}</CardTitle>
                  {titleExtra}
                </div>
              ) : (
                <CardTitle className="text-lg">{title}</CardTitle>
              )}
              <CardDescription className="text-sm">{description}</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 mt-1">
            {headerExtra}
            {statusIcon}
          </div>
        </div>
        <Separator className="mt-3" />
      </CardHeader>
      <CardContent className="space-y-3 overflow-hidden min-w-0">
        {children}
      </CardContent>
    </Card>
  );
}
