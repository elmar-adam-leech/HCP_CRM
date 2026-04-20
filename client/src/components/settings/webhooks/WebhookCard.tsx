import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Copy, Eye, EyeOff, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface WebhookPanelProps {
  url: string;
  apiKey: string;
  docType: 'leads' | 'estimates' | 'jobs';
  documentation: any | undefined;
  loading: boolean;
}

function WebhookTips({ docType }: { docType: 'leads' | 'estimates' | 'jobs' }) {
  if (docType === 'leads') return (
    <>
      <li>The webhook will automatically create a new lead in your CRM</li>
      <li>Use the <code className="bg-muted px-1 rounded">source</code> field to track where leads come from</li>
      <li>Include UTM parameters to track marketing campaigns</li>
      <li>Set <code className="bg-muted px-1 rounded">followUpDate</code> to schedule automatic follow-ups</li>
      <li>The webhook returns a 201 status code and the created lead details on success</li>
    </>
  );
  if (docType === 'jobs') return (
    <>
      <li>The webhook will automatically create a new job in your CRM</li>
      <li>Existing customers are matched by email or phone to avoid duplicates</li>
      <li>New customers are created automatically if no match is found</li>
      <li>Link jobs to estimates using the optional <code className="bg-muted px-1 rounded">estimateId</code> field</li>
      <li>Set <code className="bg-muted px-1 rounded">status</code> to scheduled, in_progress, completed, or cancelled</li>
      <li>The webhook returns a 201 status code and the created job details on success</li>
    </>
  );
  return (
    <>
      <li>The webhook will automatically create a new estimate in your CRM</li>
      <li>Existing customers are matched by email or phone to avoid duplicates</li>
      <li>New customers are created automatically if no match is found</li>
      <li>Link estimates to leads using the optional <code className="bg-muted px-1 rounded">leadId</code> field</li>
      <li>Set <code className="bg-muted px-1 rounded">status</code> to scheduled, in_progress, sent, approved, or rejected</li>
      <li>The webhook returns a 201 status code and the created estimate details on success</li>
    </>
  );
}

export function WebhookPanel({ url, apiKey, docType, documentation, loading }: WebhookPanelProps) {
  const { toast } = useToast();
  const [showApiKey, setShowApiKey] = useState(false);

  if (loading) {
    return (
      <div className="animate-pulse space-y-4 pt-2">
        <div className="h-10 bg-muted rounded" />
        <div className="h-10 bg-muted rounded" />
        <div className="h-16 bg-muted rounded" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">Webhook URL</Label>
        <div className="flex gap-2">
          <Input value={url} readOnly data-testid={`input-webhook-url-${docType}`} />
          <Button variant="outline" size="icon" onClick={() => {
            if (url) { navigator.clipboard.writeText(url); toast({ title: "Copied", description: "Webhook URL copied to clipboard" }); }
          }} data-testid={`button-copy-webhook-url-${docType}`}><Copy className="h-4 w-4" /></Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">API Key</Label>
        <div className="flex gap-2">
          <Input type={showApiKey ? "text" : "password"} value={apiKey} readOnly data-testid={`input-api-key-${docType}`} />
          <Button variant="outline" size="icon" onClick={() => setShowApiKey(!showApiKey)} data-testid={`button-toggle-api-key-${docType}`}>
            {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button variant="outline" size="icon" onClick={() => {
            if (apiKey) { navigator.clipboard.writeText(apiKey); toast({ title: "Copied", description: "API key copied to clipboard" }); }
          }} data-testid={`button-copy-api-key-${docType}`}><Copy className="h-4 w-4" /></Button>
        </div>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription className="text-sm">
          <strong>Security Note:</strong> Include the API key in your webhook request headers as <code className="bg-muted px-1 rounded">x-api-key</code>
        </AlertDescription>
      </Alert>

      {documentation && (
        <>
          <Separator />
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Documentation</h3>

            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">HTTP Method</h4>
              <div className="p-2 bg-muted rounded">
                <p className="font-mono text-sm font-semibold">{documentation.method}</p>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">Required Headers</h4>
              <div className="p-3 bg-muted rounded font-mono text-xs space-y-1">
                {Object.entries(documentation.headers).map(([key, value]) => (
                  <div key={key} className="flex gap-2">
                    <span className="text-primary font-semibold">{key}:</span>
                    <span>{key.toLowerCase() === 'x-api-key'
                      ? (showApiKey ? String(value) : '•'.repeat(Math.min(String(value).length, 64)))
                      : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">Required Fields</h4>
              <div className="flex flex-wrap gap-2">
                {documentation.requiredFields.map((field: string) => (
                  <Badge key={field} variant="default" className="text-xs font-medium">{field}</Badge>
                ))}
              </div>
            </div>

            {documentation.optionalFields?.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-muted-foreground">Optional Fields</h4>
                <div className="flex flex-wrap gap-2">
                  {documentation.optionalFields.map((field: string) => (
                    <Badge key={field} variant="secondary" className="text-xs font-medium">{field}</Badge>
                  ))}
                </div>
              </div>
            )}

            {docType === 'leads' && documentation.phoneNormalization && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  <strong>Phone Normalization:</strong> {documentation.phoneNormalization}
                </AlertDescription>
              </Alert>
            )}

            {docType === 'leads' && documentation.multipleContacts && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  <strong>Multiple Contacts:</strong> {documentation.multipleContacts}
                </AlertDescription>
              </Alert>
            )}

            {documentation.example && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-muted-foreground">Example Request Body</h4>
                <div className="p-3 bg-muted rounded">
                  <pre className="font-mono text-xs overflow-x-auto">{JSON.stringify(documentation.example, null, 2)}</pre>
                </div>
              </div>
            )}

            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-2">
                  <p className="font-semibold text-sm">Integration Tips:</p>
                  <ul className="space-y-1 text-sm list-disc list-inside ml-2">
                    <WebhookTips docType={docType} />
                  </ul>
                </div>
              </AlertDescription>
            </Alert>
          </div>
        </>
      )}
    </div>
  );
}
