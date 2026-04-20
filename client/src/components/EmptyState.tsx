import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  tips?: string[];
  ctaLabel?: string;
  onCtaClick?: () => void;
  ctaTestId?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  tips = [],
  ctaLabel,
  onCtaClick,
  ctaTestId,
}: EmptyStateProps) {
  return (
    <div className="flex items-center justify-center py-12">
      <Card className="max-w-md p-8 text-center space-y-6">
        <div className="flex justify-center">
          <div className="p-4 rounded-full bg-muted">
            <Icon className="h-12 w-12 text-muted-foreground" />
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        {tips.length > 0 && (
          <div className="bg-muted/50 rounded p-4 text-left space-y-2">
            <h4 className="text-sm font-medium">Quick tips:</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              {tips.map((tip, index) => (
                <li key={index} className="flex items-start gap-2">
                  <span className="text-primary mt-0.5">•</span>
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {ctaLabel && onCtaClick && (
          <Button
            onClick={onCtaClick}
            size="lg"
            className="w-full"
            data-testid={ctaTestId}
          >
            {ctaLabel}
          </Button>
        )}
      </Card>
    </div>
  );
}
