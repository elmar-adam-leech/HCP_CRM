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

export function JobsWebhookCard() {
  const { data, isLoading } = useQuery<WebhookConfig>({
    queryKey: ['/api/webhook-config'],
  });

  return (
    <WebhookPanel
      url={data?.webhooks?.jobs?.url ?? ''}
      apiKey={data?.apiKey ?? ''}
      docType="jobs"
      documentation={data?.webhooks?.jobs?.documentation}
      loading={isLoading}
    />
  );
}
