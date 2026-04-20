import { useState } from "react";
import { dialPhone } from "@/lib/dialPhone";
import { useToast } from "@/hooks/use-toast";

export interface CommunicationEntity {
  id: string;
  contactId?: string;
  name?: string | null;
  customerName?: string | null;
  emails?: string[] | null;
  phones?: string[] | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}

export interface EmailModalState {
  isOpen: boolean;
  lead?: CommunicationEntity;
  estimate?: CommunicationEntity;
  customer?: CommunicationEntity;
}

export interface SchedulingLead {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  isScheduled?: boolean;
  housecallProEstimateId?: string | null;
}

export interface SchedulingModalState {
  isOpen: boolean;
  lead?: SchedulingLead;
}

export function useCommunicationActions() {
  const { toast } = useToast();
  const [emailModal, setEmailModal] = useState<EmailModalState>({ isOpen: false });
  const [schedulingModal, setSchedulingModal] = useState<SchedulingModalState>({ isOpen: false });

  const handleSendEmail = (entity: CommunicationEntity, entityType: 'lead' | 'estimate' | 'customer' = 'lead') => {
    const entityEmail = entity.emails && entity.emails.length > 0 ? entity.emails[0] : entity.email;
    
    if (!entityEmail) {
      toast({
        title: "No email address",
        description: "This contact has no email address on file.",
        variant: "destructive",
      });
      return;
    }
    
    const normalizedEntity = {
      ...entity,
      name: entity.name || entity.customerName || '',
    };
    
    if (entityType === 'lead') {
      setEmailModal({ isOpen: true, lead: normalizedEntity });
    } else if (entityType === 'estimate') {
      setEmailModal({ isOpen: true, estimate: normalizedEntity });
    } else {
      setEmailModal({ isOpen: true, customer: normalizedEntity });
    }
  };

  const handleSchedule = (lead: CommunicationEntity & {
    isScheduled?: boolean;
    status?: string;
    address?: string | null;
    street?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    housecallProEstimateId?: string | null;
  }) => {
    const modalLead: SchedulingLead = {
      id: lead.id,
      name: lead.name || lead.customerName,
      email: lead.emails && lead.emails.length > 0 ? lead.emails[0] : lead.email,
      phone: lead.phones && lead.phones.length > 0 ? lead.phones[0] : lead.phone,
      address: lead.address || undefined,
      street: lead.street || undefined,
      city: lead.city || undefined,
      state: lead.state || undefined,
      zip: lead.zip || undefined,
      isScheduled: lead.isScheduled || lead.status === 'scheduled' || false,
      housecallProEstimateId: lead.housecallProEstimateId || undefined,
    };
    
    setSchedulingModal({ isOpen: true, lead: modalLead });
  };

  const handleContact = (entity: CommunicationEntity, method: "phone" | "email") => {
    const entityPhone = entity.phones && entity.phones.length > 0 ? entity.phones[0] : entity.phone;
    const entityEmail = entity.emails && entity.emails.length > 0 ? entity.emails[0] : entity.email;
    
    if (method === "phone") {
      if (entityPhone) {
        dialPhone({ contactId: entity.id, phone: entityPhone, name: entity.name || entity.customerName || undefined });
      } else {
        toast({
          title: "No phone number",
          description: "This contact has no phone number on file.",
          variant: "destructive",
        });
      }
    } else if (method === "email") {
      if (entityEmail) {
        window.location.href = `mailto:${entityEmail}`;
      } else {
        toast({
          title: "No email address",
          description: "This contact has no email address on file.",
          variant: "destructive",
        });
      }
    }
  };

  const closeEmailModal = () => setEmailModal({ isOpen: false });
  const closeSchedulingModal = () => setSchedulingModal({ isOpen: false });

  return {
    emailModal,
    schedulingModal,
    
    handleSendEmail,
    handleSchedule,
    handleContact,
    
    closeEmailModal,
    closeSchedulingModal,
  };
}
