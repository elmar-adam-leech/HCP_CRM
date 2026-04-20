import { useLocation } from "wouter";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { Button } from "@/components/ui/button";
import { Phone, ArrowLeft } from "lucide-react";
import EnhancedDialpadConfig from "@/components/EnhancedDialpadConfig";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

export default function EnhancedDialpadSetup() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  return (
    <PageLayout>
      <PageHeader 
        title="Enhanced Dialpad Setup" 
        description="Configure advanced Dialpad features including phone number management and department assignments"
        icon={<Phone className="h-6 w-6" />}
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

      <div className="space-y-6">
        <EnhancedDialpadConfig 
          onComplete={() => {
            queryClient.invalidateQueries({ queryKey: ['/api/integrations'] });
            toast({
              title: "Dialpad Setup Complete",
              description: "Your enhanced Dialpad integration has been configured successfully."
            });
            navigate('/settings?tab=integrations');
          }}
        />
      </div>
    </PageLayout>
  );
}
