import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Eye } from "lucide-react";

type ViewDetailsButtonProps = {
  onViewDetails: () => void;
  testId?: string;
};

export function ViewDetailsButton({ onViewDetails, testId }: ViewDetailsButtonProps) {
  return (
    <DropdownMenuItem onClick={onViewDetails} data-testid={testId}>
      <Eye className="h-4 w-4 mr-2" />
      View Details
    </DropdownMenuItem>
  );
}
