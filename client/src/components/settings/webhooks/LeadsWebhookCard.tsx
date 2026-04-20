import { useQuery } from "@tanstack/react-query";
import { WebhookPanel } from "./WebhookCard";

interface WebhookConfig {
  apiKey: string;
  webhooks: {
    leads: { url: string; documentation: any };
    estimates: { url: string; documentation: any };
    jobs: { url: string; documentation: any };
  };
}

export function LeadsWebhookCard() {
  const { data, isLoading } = useQuery<WebhookConfig>({
    queryKey: ['/api/webhook-config'],
  });

  return (
    <WebhookPanel
      url={data?.webhooks?.leads?.url ?? ''}
      apiKey={data?.apiKey ?? ''}
      docType="leads"
      documentation={data?.webhooks?.leads?.documentation}
      loading={isLoading}
    />
  );
}
