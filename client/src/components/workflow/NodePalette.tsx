import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Mail,
  MessageSquare,
  Bell,
  UserPlus,
  GitBranch,
  Clock,
  Calendar,
  Zap,
  CalendarCheck,
  RefreshCw,
} from 'lucide-react';

export type NodeType = {
  type: string;
  label: string;
  icon: React.ReactNode;
  category: 'trigger' | 'action' | 'condition' | 'delay';
  description: string;
};

export const availableNodes: NodeType[] = [
  {
    type: 'trigger',
    label: 'Trigger',
    icon: <Zap className="h-4 w-4" />,
    category: 'trigger',
    description: 'Start workflow on event',
  },
  {
    type: 'sendEmail',
    label: 'Send Email',
    icon: <Mail className="h-4 w-4" />,
    category: 'action',
    description: 'Send an email',
  },
  {
    type: 'sendSMS',
    label: 'Send SMS',
    icon: <MessageSquare className="h-4 w-4" />,
    category: 'action',
    description: 'Send a text message',
  },
  {
    type: 'notification',
    label: 'Notification',
    icon: <Bell className="h-4 w-4" />,
    category: 'action',
    description: 'Create a notification',
  },
  {
    type: 'assignUser',
    label: 'Assign User',
    icon: <UserPlus className="h-4 w-4" />,
    category: 'action',
    description: 'Assign to a user',
  },
  {
    type: 'setFollowUp',
    label: 'Set Follow Up',
    icon: <CalendarCheck className="h-4 w-4" />,
    category: 'action',
    description: 'Schedule a follow-up date',
  },
  {
    type: 'updateEntity',
    label: 'Update Status',
    icon: <RefreshCw className="h-4 w-4" />,
    category: 'action',
    description: 'Update entity status',
  },
  {
    type: 'conditional',
    label: 'If/Else',
    icon: <GitBranch className="h-4 w-4" />,
    category: 'condition',
    description: 'Conditional branch',
  },
  {
    type: 'delay',
    label: 'Delay',
    icon: <Clock className="h-4 w-4" />,
    category: 'delay',
    description: 'Wait for specified time',
  },
  {
    type: 'waitUntil',
    label: 'Wait Until',
    icon: <Calendar className="h-4 w-4" />,
    category: 'delay',
    description: 'Wait until specific date/time',
  },
];

const categories: Record<string, string> = {
  trigger: 'Triggers',
  action: 'Actions',
  condition: 'Conditions',
  delay: 'Delays',
};

function groupNodes() {
  return availableNodes.reduce((acc, node) => {
    if (!acc[node.category]) {
      acc[node.category] = [];
    }
    acc[node.category].push(node);
    return acc;
  }, {} as Record<string, NodeType[]>);
}

type NodePaletteProps = {
  onDragStart: (event: React.DragEvent, nodeType: string) => void;
};

export default function NodePalette({ onDragStart }: NodePaletteProps) {
  const groupedNodes = groupNodes();

  return (
    <Card className="w-64 h-full border-r rounded-none hidden md:flex md:flex-col" data-testid="node-palette">
      <CardHeader className="p-4 pb-3 border-b">
        <CardTitle className="text-base">Workflow Nodes</CardTitle>
      </CardHeader>
      <ScrollArea className="h-[calc(100%-4rem)]">
        <CardContent className="p-3 space-y-4">
          {Object.entries(categories).map(([category, title]) => (
            <div key={category} className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {title}
              </h3>
              <div className="space-y-1">
                {groupedNodes[category]?.map((node) => (
                  <div
                    key={node.type}
                    draggable
                    onDragStart={(e) => onDragStart(e, node.type)}
                    className="flex items-start gap-2 p-2 rounded-md border bg-card hover-elevate active-elevate-2 cursor-grab active:cursor-grabbing"
                    data-testid={`node-palette-${node.type}`}
                  >
                    <div className="mt-0.5">{node.icon}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{node.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {node.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </ScrollArea>
    </Card>
  );
}

type MobileNodePaletteContentProps = {
  onNodeTap: (nodeType: string) => void;
};

export function MobileNodePaletteContent({ onNodeTap }: MobileNodePaletteContentProps) {
  const groupedNodes = groupNodes();

  return (
    <div className="p-4 space-y-4 pb-8">
      {Object.entries(categories).map(([category, title]) => (
        <div key={category} className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {title}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {groupedNodes[category]?.map((node) => (
              <button
                key={node.type}
                onClick={() => onNodeTap(node.type)}
                className="flex items-start gap-2 p-3 rounded-md border bg-card hover-elevate active-elevate-2 text-left"
                data-testid={`mobile-node-palette-${node.type}`}
              >
                <div className="mt-0.5">{node.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{node.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {node.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
