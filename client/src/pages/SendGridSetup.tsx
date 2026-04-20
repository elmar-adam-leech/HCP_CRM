import { useLocation } from "wouter";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Mail, ArrowLeft, ExternalLink, Info, Key, Globe, UserCheck, CheckCircle } from "lucide-react";

const steps = [
  {
    number: 1,
    icon: ExternalLink,
    title: "Create a SendGrid Account",
    description: "Sign up for a free SendGrid account. The free tier allows up to 100 emails per day, which is enough to get started.",
    content: (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Go to <a href="https://sendgrid.com" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">sendgrid.com</a> and click <strong>Start for Free</strong>. Complete the sign-up process and verify your email address.
        </p>
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            When asked about your use case, select <strong>Transactional</strong> email. This unlocks the API key and domain authentication features you need.
          </AlertDescription>
        </Alert>
      </div>
    ),
  },
  {
    number: 2,
    icon: Globe,
    title: "Authenticate Your Domain",
    description: "Domain authentication tells email providers that SendGrid is authorized to send emails on behalf of your domain. This improves deliverability and ensures emails show your domain name.",
    content: (
      <div className="space-y-3">
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>In the SendGrid dashboard, go to <strong>Settings &gt; Sender Authentication</strong></li>
          <li>Under <strong>Domain Authentication</strong>, click <strong>Authenticate Your Domain</strong></li>
          <li>Select your DNS host (e.g., GoDaddy, Cloudflare, Namecheap, Route 53)</li>
          <li>Enter your domain name (e.g., <code className="bg-muted px-1 rounded text-xs">yourcompany.com</code>)</li>
          <li>SendGrid will provide 2–3 CNAME records — add these to your DNS provider</li>
          <li>Return to SendGrid and click <strong>Verify</strong></li>
        </ol>
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            DNS changes can take up to 48 hours to propagate, though they usually complete within a few hours. You can continue setting up while you wait.
          </AlertDescription>
        </Alert>
      </div>
    ),
  },
  {
    number: 3,
    icon: UserCheck,
    title: "Verify a Sender Identity",
    description: "Add the specific email address you want to send from, such as info@yourcompany.com or noreply@yourcompany.com.",
    content: (
      <div className="space-y-3">
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>In SendGrid, go to <strong>Settings &gt; Sender Authentication</strong></li>
          <li>Under <strong>Single Sender Verification</strong>, click <strong>Verify a Single Sender</strong></li>
          <li>Fill in your sender details — name, reply-to address, and the "From" email address</li>
          <li>Check your inbox for a verification email from SendGrid and click the link</li>
        </ol>
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            The "From" address you verify here is what contacts will see when they receive emails from the CRM. Use a professional address like <code className="bg-muted px-1 rounded text-xs">hello@yourcompany.com</code>.
          </AlertDescription>
        </Alert>
      </div>
    ),
  },
  {
    number: 4,
    icon: Key,
    title: "Create an API Key",
    description: "Generate a SendGrid API key that the CRM will use to send emails on your behalf.",
    content: (
      <div className="space-y-3">
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>In SendGrid, go to <strong>Settings &gt; API Keys</strong></li>
          <li>Click <strong>Create API Key</strong></li>
          <li>Give it a recognizable name like <strong>CRM Integration</strong></li>
          <li>Select <strong>Restricted Access</strong> and enable <strong>Mail Send</strong> under Mail Send permissions</li>
          <li>Click <strong>Create &amp; View</strong> and copy the key immediately</li>
        </ol>
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            SendGrid only shows the API key once. Copy it now and keep it somewhere safe before closing the page.
          </AlertDescription>
        </Alert>
      </div>
    ),
  },
  {
    number: 5,
    icon: CheckCircle,
    title: "Enter Your API Key in the CRM",
    description: "Paste your API key into the SendGrid integration card and optionally set it as your default email provider.",
    content: (
      <div className="space-y-3">
        <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
          <li>Go to <strong>Settings &gt; Integrations</strong></li>
          <li>Find the <strong>SendGrid</strong> card and paste your API key</li>
          <li>Click <strong>Save</strong></li>
          <li>Once saved, click <strong>Set as Default</strong> if you want the CRM to use SendGrid for all outgoing emails</li>
        </ol>
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            After saving, send a test email to a contact to confirm everything is working. Check the SendGrid Activity Feed to monitor delivery status.
          </AlertDescription>
        </Alert>
      </div>
    ),
  },
];

export default function SendGridSetup() {
  const [, navigate] = useLocation();

  return (
    <PageLayout>
      <PageHeader
        title="SendGrid Setup Guide"
        description="Configure SendGrid to send emails from your own domain through the CRM"
        icon={<Mail className="h-6 w-6" />}
        actions={
          <Button
            variant="outline"
            onClick={() => navigate('/settings?tab=integrations')}
            data-testid="button-back-to-integrations"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Integrations
          </Button>
        }
      />

      <div className="space-y-4">
        {steps.map((step) => {
          const Icon = step.icon;
          return (
            <Card key={step.number}>
              <CardHeader className="pb-3">
                <div className="flex items-start gap-4">
                  <Badge variant="outline" className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center text-sm font-semibold p-0">
                    {step.number}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <CardTitle className="text-base">{step.title}</CardTitle>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">{step.description}</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pl-16">
                {step.content}
              </CardContent>
            </Card>
          );
        })}

        <div className="flex justify-end pt-2">
          <Button onClick={() => navigate('/settings?tab=integrations')} data-testid="button-go-to-integrations">
            <Mail className="h-4 w-4 mr-2" />
            Go to Integrations
          </Button>
        </div>
      </div>
    </PageLayout>
  );
}
