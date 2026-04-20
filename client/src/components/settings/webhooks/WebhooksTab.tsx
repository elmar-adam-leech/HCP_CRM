import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Webhook } from "lucide-react";
import { LeadsWebhookCard } from "./LeadsWebhookCard";
import { EstimatesWebhookCard } from "./EstimatesWebhookCard";
import { JobsWebhookCard } from "./JobsWebhookCard";

type WebhookTab = 'leads' | 'estimates' | 'jobs';

const TABS: { id: WebhookTab; label: string; testId: string }[] = [
  { id: 'leads', label: 'Leads Webhook', testId: 'button-webhook-leads' },
  { id: 'estimates', label: 'Estimates Webhook', testId: 'button-webhook-estimates' },
  { id: 'jobs', label: 'Jobs Webhook', testId: 'button-webhook-jobs' },
];

export function WebhooksTab() {
  const [selected, setSelected] = useState<WebhookTab>('leads');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Webhook className="h-5 w-5" />
          Webhook Configuration
        </CardTitle>
        <CardDescription>Push leads, estimates, and jobs from external sources like Zapier</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 p-1 bg-muted rounded-lg">
          {TABS.map((tab) => (
            <Button
              key={tab.id}
              variant={selected === tab.id ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setSelected(tab.id)}
              data-testid={tab.testId}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        {selected === 'leads' && <LeadsWebhookCard />}
        {selected === 'estimates' && <EstimatesWebhookCard />}
        {selected === 'jobs' && <JobsWebhookCard />}
      </CardContent>
    </Card>
  );
}
