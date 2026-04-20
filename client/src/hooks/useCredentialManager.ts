import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

interface UseCredentialManagerOptions {
  onSave: (apiKey: string) => void;
}

export function useCredentialManager({ onSave }: UseCredentialManagerOptions) {
  const { toast } = useToast();
  const [editingCredential, setEditingCredential] = useState(false);
  const [credentialInput, setCredentialInput] = useState('');

  const handleSaveCredentials = () => {
    if (!credentialInput.trim()) {
      toast({ title: "Error", description: "Please enter a valid API key.", variant: "destructive" });
      return;
    }
    onSave(credentialInput.trim());
    setCredentialInput('');
    setEditingCredential(false);
  };

  const handleCancelEdit = () => {
    setEditingCredential(false);
    setCredentialInput('');
  };

  return {
    editingCredential,
    setEditingCredential,
    credentialInput,
    setCredentialInput,
    handleSaveCredentials,
    handleCancelEdit,
  };
}
