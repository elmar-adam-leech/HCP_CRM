import { Handle, Position, NodeProps } from 'reactflow';
import {
  Mail,
  MessageSquare,
  Bell,
  Edit,
  UserPlus,
  GitBranch,
  Clock,
  Calendar,
  Zap,
  Play,
  CalendarCheck,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// Node style variants
const nodeStyles = {
  trigger: {
    background: 'hsl(var(--primary))',
    color: 'hsl(var(--primary-foreground))',
    border: '2px solid hsl(var(--primary))',
  },
  action: {
    background: 'hsl(var(--card))',
    color: 'hsl(var(--card-foreground))',
    border: '2px solid hsl(var(--border))',
  },
  condition: {
    background: 'hsl(var(--secondary))',
    color: 'hsl(var(--secondary-foreground))',
    border: '2px solid hsl(var(--secondary))',
  },
  delay: {
    background: 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
    border: '2px solid hsl(var(--border))',
  },
};

// Handle configurations:
//   'trigger'     — source only (no incoming handle)
//   'action'      — target top + source bottom (default)
//   'conditional' — target top + two labelled source handles at bottom
type HandleConfig = 'trigger' | 'action' | 'conditional';

type BaseNodeProps = {
  icon: React.ReactNode;
  title: string;
  preview?: React.ReactNode;
  style: React.CSSProperties;
  handles?: HandleConfig;
};

function BaseNode({ icon, title, preview, style, handles = 'action' }: BaseNodeProps) {
  return (
    <Card className="min-w-[200px] shadow-md" style={style}>
      {handles !== 'trigger' && <Handle type="target" position={Position.Top} />}
      <CardHeader className="p-3 pb-2">
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        </div>
      </CardHeader>
      {preview !== undefined && (
        <CardContent className="p-3 pt-0 text-xs text-muted-foreground">
          {preview}
        </CardContent>
      )}
      {handles === 'conditional' ? (
        <>
          <Handle type="source" position={Position.Bottom} id="true" style={{ left: '35%' }} />
          <Handle type="source" position={Position.Bottom} id="false" style={{ left: '65%' }} />
          <div className="relative pointer-events-none h-4">
            <span className="absolute text-[10px] text-muted-foreground" style={{ left: '35%', transform: 'translateX(-50%)' }}>Yes</span>
            <span className="absolute text-[10px] text-muted-foreground" style={{ left: '65%', transform: 'translateX(-50%)' }}>No</span>
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} />
      )}
    </Card>
  );
}

export function TriggerNode({ data }: NodeProps) {
  const triggerType = data.triggerType || 'entity_event';
  const icon = triggerType === 'time_based'
    ? <Calendar className="h-4 w-4" />
    : triggerType === 'manual'
      ? <Play className="h-4 w-4" />
      : <Zap className="h-4 w-4" />;

  return (
    <BaseNode
      icon={icon}
      title={String(data.label || 'Trigger')}
      preview={<Badge variant="secondary" className="text-xs">{String(triggerType).replace('_', ' ')}</Badge>}
      style={nodeStyles.trigger}
      handles="trigger"
    />
  );
}

export function SendEmailNode({ data }: NodeProps) {
  return (
    <BaseNode
      icon={<Mail className="h-4 w-4" />}
      title="Send Email"
      preview={
        <div className="space-y-1">
          <div>{data.to ? `To: ${data.to}` : 'Configure recipient'}</div>
          <div className="text-[10px] opacity-70">
            {data.fromEmail ? `From: ${data.fromEmail}` : "From: Creator's Gmail"}
          </div>
        </div>
      }
      style={nodeStyles.action}
    />
  );
}

export function SendSMSNode({ data }: NodeProps) {
  return (
    <BaseNode
      icon={<MessageSquare className="h-4 w-4" />}
      title="Send SMS"
      preview={
        <div className="space-y-1">
          <div>{data.to ? `To: ${data.to}` : 'Configure phone number'}</div>
          <div className="text-[10px] opacity-70">
            {data.fromNumber ? `From: ${data.fromNumber}` : "From: Creator's phone"}
          </div>
        </div>
      }
      style={nodeStyles.action}
    />
  );
}

export function NotificationNode({ data }: NodeProps) {
  return (
    <BaseNode
      icon={<Bell className="h-4 w-4" />}
      title="Create Notification"
      preview={<>{data.title || 'Configure notification'}</>}
      style={nodeStyles.action}
    />
  );
}

export function UpdateEntityNode({ data }: NodeProps) {
  return (
    <BaseNode
      icon={<Edit className="h-4 w-4" />}
      title="Update Entity"
      preview={<>{data.entityType ? `Update ${data.entityType}` : 'Configure entity'}</>}
      style={nodeStyles.action}
    />
  );
}

export function AssignUserNode({ data }: NodeProps) {
  return (
    <BaseNode
      icon={<UserPlus className="h-4 w-4" />}
      title="Assign User"
      preview={<>{data.userId ? 'Assign to user' : 'Configure assignment'}</>}
      style={nodeStyles.action}
    />
  );
}

export function ConditionalNode({ data }: NodeProps) {
  const formatConditionValue = (v: unknown): string => {
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { tags?: unknown }).tags)) {
      const obj = v as { tags: unknown[]; match?: string };
      const join = obj.match === 'all' ? ' AND ' : ' OR ';
      return obj.tags.map((t) => String(t)).join(join) || '?';
    }
    if (Array.isArray(v)) return v.map(String).join(' OR ') || '?';
    return String(v ?? '?');
  };
  const conditionSummary = data.conditionField && data.conditionOperator
    ? `${data.conditionField} ${data.conditionOperator}${
        data.conditionOperator !== 'is_empty' && data.conditionOperator !== 'is_not_empty'
          ? ` ${formatConditionValue(data.conditionValue)}`
          : ''
      }`
    : 'Configure condition';

  return (
    <BaseNode
      icon={<GitBranch className="h-4 w-4" />}
      title="If/Else Condition"
      preview={<>{conditionSummary}</>}
      style={nodeStyles.condition}
      handles="conditional"
    />
  );
}

export function DelayNode({ data }: NodeProps) {
  return (
    <BaseNode
      icon={<Clock className="h-4 w-4" />}
      title="Delay"
      preview={<>{data.duration || 'Configure duration'}</>}
      style={nodeStyles.delay}
    />
  );
}

export function WaitUntilNode({ data }: NodeProps) {
  return (
    <BaseNode
      icon={<Calendar className="h-4 w-4" />}
      title="Wait Until"
      preview={<>{data.dateTime || 'Configure date/time'}</>}
      style={nodeStyles.delay}
    />
  );
}

export function SetFollowUpNode({ data }: NodeProps) {
  const days = Number(data.offsetDays ?? 1);
  const preview = days === 1 ? '1 day from now' : `${days} days from now`;
  return (
    <BaseNode
      icon={<CalendarCheck className="h-4 w-4" />}
      title="Set Follow Up"
      preview={<>{preview}</>}
      style={nodeStyles.action}
    />
  );
}

export const nodeTypes = {
  trigger: TriggerNode,
  sendEmail: SendEmailNode,
  sendSMS: SendSMSNode,
  notification: NotificationNode,
  updateEntity: UpdateEntityNode,
  assignUser: AssignUserNode,
  setFollowUp: SetFollowUpNode,
  conditional: ConditionalNode,
  delay: DelayNode,
  waitUntil: WaitUntilNode,
};
