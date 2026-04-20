import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";

interface LogCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId?: string;
  estimateId?: string;
  jobId?: string;
  customerId?: string;
}

export function LogCallDialog({ 
  open, 
  onOpenChange, 
  leadId, 
  estimateId, 
  jobId, 
  customerId 
}: LogCallDialogProps) {
  const [callType, setCallType] = useState<'inbound' | 'outbound'>('outbound');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [duration, setDuration] = useState('');
  const [notes, setNotes] = useState('');
  const { toast } = useToast();

  const createCallMutation = useMutation({
    mutationFn: async (data: {
      type: 'call';
      title: string;
      content: string;
      metadata?: string;
      contactId?: string;
      estimateId?: string;
      jobId?: string;
    }) => {
      const response = await apiRequest('POST', '/api/activities', data);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Call logged",
        description: "Call activity has been recorded successfully",
      });
      
      // Invalidate activities query to refresh the list
      queryClient.invalidateQueries({ queryKey: ['/api/activities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
      const contactId = leadId || customerId;
      if (contactId) {
        queryClient.invalidateQueries({ queryKey: ['/api/contacts', contactId] });
      }
      
      // Reset form and close dialog
      setCallType('outbound');
      setPhoneNumber('');
      setDuration('');
      setNotes('');
      onOpenChange(false);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to log call",
        description: error.message || "Please try again",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Build title
    const title = `${callType === 'inbound' ? 'Incoming' : 'Outgoing'} call${phoneNumber ? ` - ${phoneNumber}` : ''}`;
    
    // Build content
    let content = notes;
    if (duration) {
      content = `Duration: ${duration} minutes\n\n${notes}`;
    }
    
    // Build metadata
    const metadata = JSON.stringify({
      callType,
      phoneNumber: phoneNumber || undefined,
      duration: duration || undefined,
    });
    
    createCallMutation.mutate({
      type: 'call',
      title,
      content,
      metadata,
      contactId: leadId || customerId,
      estimateId,
      jobId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]" data-testid="dialog-log-call">
        <DialogHeader>
          <DialogTitle>Log Call Activity</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="call-type">Call Type</Label>
            <Select value={callType} onValueChange={(value: 'inbound' | 'outbound') => setCallType(value)}>
              <SelectTrigger id="call-type" data-testid="select-call-type">
                <SelectValue placeholder="Select call type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inbound">Incoming Call</SelectItem>
                <SelectItem value="outbound">Outgoing Call</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone-number">Phone Number (Optional)</Label>
            <Input
              id="phone-number"
              type="tel"
              placeholder="(555) 123-4567"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              data-testid="input-phone-number"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="duration">Duration (minutes, optional)</Label>
            <Input
              id="duration"
              type="number"
              placeholder="5"
              min="0"
              step="0.5"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              data-testid="input-duration"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Call Notes</Label>
            <Textarea
              id="notes"
              placeholder="What was discussed during the call?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              required
              data-testid="input-notes"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createCallMutation.isPending || !notes.trim()}
              data-testid="button-save-call"
            >
              {createCallMutation.isPending ? "Saving..." : "Log Call"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
