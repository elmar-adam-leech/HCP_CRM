import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Settings, Mail, MessageSquare, Phone } from "lucide-react";

interface ProviderIntegrationPromptProps {
  type: 'email' | 'sms' | 'calling';
  availableProviders: string[];
  onSetupClick: () => void;
  className?: string;
}

const typeConfig = {
  email: {
    icon: Mail,
    title: "Email Provider Not Set Up",
    description: "Connect an email service to send emails to your customers",
    actionText: "Set Up Email Provider"
  },
  sms: {
    icon: MessageSquare,
    title: "SMS Provider Not Set Up", 
    description: "Connect an SMS service to send text messages to your customers",
    actionText: "Set Up SMS Provider"
  },
  calling: {
    icon: Phone,
    title: "Calling Provider Not Set Up",
    description: "Connect a calling service to make phone calls to your customers", 
    actionText: "Set Up Calling Provider"
  }
};

export function ProviderIntegrationPrompt({
  type,
  availableProviders,
  onSetupClick,
  className = ""
}: ProviderIntegrationPromptProps) {
  const config = typeConfig[type];
  const IconComponent = config.icon;

  return (
    <Card className={`border-dashed ${className}`}>
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
          <IconComponent className="h-6 w-6 text-muted-foreground" />
        </div>
        <CardTitle className="text-lg">{config.title}</CardTitle>
        <CardDescription>{config.description}</CardDescription>
      </CardHeader>
      <CardContent className="text-center space-y-4">
        <div className="flex flex-wrap gap-2 justify-center">
          {availableProviders.map((provider) => (
            <Badge key={provider} variant="secondary" className="capitalize">
              {provider}
            </Badge>
          ))}
        </div>
        <Button onClick={onSetupClick} className="w-full" data-testid={`button-setup-${type}`}>
          <Settings className="h-4 w-4 mr-2" />
          {config.actionText}
        </Button>
      </CardContent>
    </Card>
  );
}