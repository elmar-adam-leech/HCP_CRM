import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Phone, Mail, MapPin, Calendar, MoreHorizontal } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CallButton } from "./CallButton";
import { getInitials } from "@/lib/utils";

type CustomerCardProps = {
  customer: {
    id: string;
    name: string;
    email: string;
    phone: string;
    address: string;
    jobsCount: number;
    lastActivity: string;
    avatar?: string;
    status: "active" | "inactive" | "lead";
  };
  onContact?: (customerId: string, method: "phone" | "email") => void;
  onViewJobs?: (customerId: string) => void;
};

export function CustomerCard({ customer, onContact, onViewJobs }: CustomerCardProps) {
  return (
    <Card className="hover-elevate" data-testid={`card-customer-${customer.id}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center space-x-3">
          <Avatar className="h-10 w-10">
            <AvatarImage src={customer.avatar} alt={customer.name} />
            <AvatarFallback>{getInitials(customer.name)}</AvatarFallback>
          </Avatar>
          <div>
            <CardTitle className="text-base font-medium">{customer.name}</CardTitle>
            <div className="flex items-center gap-2">
              <Badge
                variant={customer.status === "active" ? "default" : "secondary"}
                className={customer.status === "active" ? "bg-chart-2 text-white" : ""}
              >
                {customer.status}
              </Badge>
            </div>
          </div>
        </div>
        <Button variant="ghost" size="icon" data-testid={`button-customer-menu-${customer.id}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            <span className="truncate">{customer.email}</span>
          </div>
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4" />
            <span>{customer.phone}</span>
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4" />
            <span className="truncate">{customer.address}</span>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            <span>Last activity: {customer.lastActivity}</span>
          </div>
        </div>
        
        <div className="flex items-center justify-between pt-2 border-t">
          <div className="text-sm">
            <span className="font-medium">{customer.jobsCount}</span>
            <span className="text-muted-foreground"> jobs</span>
          </div>
          <div className="flex gap-2">
            <CallButton
              recipientName={customer.name}
              recipientPhone={customer.phone}
              variant="outline"
              size="sm"
              customerId={customer.id}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => onContact?.(customer.id, "email")}
              data-testid={`button-email-${customer.id}`}
            >
              <Mail className="h-3 w-3 mr-1" />
              Email
            </Button>
          </div>
        </div>
        
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={() => onViewJobs?.(customer.id)}
          data-testid={`button-view-jobs-${customer.id}`}
        >
          View Jobs
        </Button>
      </CardContent>
    </Card>
  );
}
