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

export function EstimatesWebhookCard() {
  const { data, isLoading } = useQuery<WebhookConfig>({
    queryKey: ['/api/webhook-config'],
  });

  return (
    <WebhookPanel
      url={data?.webhooks?.estimates?.url ?? ''}
      apiKey={data?.apiKey ?? ''}
      docType="estimates"
      documentation={data?.webhooks?.estimates?.documentation}
      loading={isLoading}
    />
  );
}
