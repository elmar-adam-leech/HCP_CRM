/**
 * WorkflowCanvas — React Flow canvas for the visual workflow builder.
 *
 * Node type ↔ actionType mapping:
 *   The canvas uses React Flow "node types" (short display names) while the database
 *   stores "actionType" strings. The mapping lives in `client/src/lib/workflow-utils.ts`
 *   (`ACTION_TO_NODE` and `NODE_TO_ACTION` maps). WorkflowBuilder.tsx applies those maps
 *   when serializing nodes to steps (save) and deserializing steps to nodes (load).
 *
 *   Examples:
 *     actionType              →  nodeType
 *     ─────────────────────────────────────
 *     'send_email'            →  'email'
 *     'send_sms'              →  'sms'
 *     'create_notification'   →  'notification'
 *     'update_field'          →  'update'
 *     'delay'                 →  'delay'
 *     'condition'             →  'condition'
 *     'assign_user'           →  'assign'
 *
 * The `nodeTypes` object (imported from `./WorkflowNodes`) registers the React
 * components for each node type. Adding a new action requires both a new entry
 * in the workflow-utils maps and a new component registered in `nodeTypes`.
 */
import { useCallback, useState, useEffect, useRef } from 'react';
import ReactFlow, {
  Node,
  Edge,
  EdgeProps,
  addEdge,
  Background,
  Controls,
  MiniMap,
  Connection,
  EdgeChange,
  NodeChange,
  applyNodeChanges,
  applyEdgeChanges,
  ReactFlowInstance,
  getBezierPath,
  EdgeLabelRenderer,
  BaseEdge,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { nodeTypes } from './WorkflowNodes';

function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
}: EdgeProps) {
  const { setEdges } = useReactFlow();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            opacity: selected ? 1 : 0,
            transition: 'opacity 0.15s',
          }}
          className="nodrag nopan"
        >
          <button
            onClick={() => setEdges(eds => eds.filter(e => e.id !== id))}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              lineHeight: 1,
            }}
            className="bg-destructive text-destructive-foreground hover:opacity-80"
            title="Delete connection"
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { default: DeletableEdge };

const defaultNodes: Node[] = [
  {
    id: 'trigger-1',
    type: 'trigger',
    position: { x: 250, y: 50 },
    data: { 
      label: 'When Lead is Created',
      triggerType: 'entity_event'
    },
  },
];

const defaultEdges: Edge[] = [];

type WorkflowCanvasProps = {
  initialNodes?: Node[];
  initialEdges?: Edge[];
  workflowId?: string;
  approvalStatus?: string;
  onNodesChange?: (nodes: Node[]) => void;
  onEdgesChange?: (edges: Edge[]) => void;
  onNodeClick?: (node: Node) => void;
  reactFlowInstanceRef?: React.MutableRefObject<ReactFlowInstance | null>;
};

export default function WorkflowCanvas({ 
  initialNodes, 
  initialEdges, 
  workflowId: _workflowId, 
  approvalStatus: _approvalStatus,
  onNodesChange: onNodesChangeCallback,
  onEdgesChange: onEdgesChangeCallback,
  onNodeClick,
  reactFlowInstanceRef,
}: WorkflowCanvasProps) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes || defaultNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges || defaultEdges);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const isUpdatingFromParent = useRef(false);

  // Update nodes and edges when props change (template selected)
  useEffect(() => {
    if (initialNodes !== undefined) {
      isUpdatingFromParent.current = true;
      setNodes(initialNodes);
      setTimeout(() => {
        isUpdatingFromParent.current = false;
      }, 0);
    }
  }, [initialNodes]);

  useEffect(() => {
    if (initialEdges !== undefined) {
      isUpdatingFromParent.current = true;
      setEdges(initialEdges);
      setTimeout(() => {
        isUpdatingFromParent.current = false;
      }, 0);
    }
  }, [initialEdges]);

  // Notify parent of changes (but not during parent updates to prevent bouncing)
  useEffect(() => {
    if (onNodesChangeCallback && !isUpdatingFromParent.current) {
      onNodesChangeCallback(nodes);
    }
  }, [nodes, onNodesChangeCallback]);

  useEffect(() => {
    if (onEdgesChangeCallback && !isUpdatingFromParent.current) {
      onEdgesChangeCallback(edges);
    }
  }, [edges, onEdgesChangeCallback]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    []
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    []
  );

  // Handle drag and drop from palette
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      if (!reactFlowWrapper.current || !reactFlowInstance) return;

      const type = event.dataTransfer.getData('application/reactflow');

      if (!type) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      // Generate unique ID
      const id = `${type}-${Date.now()}`;

      // Default data based on node type
      const defaultData: Record<string, unknown> = {
        trigger: { label: 'New Trigger', triggerType: 'entity_event' },
        sendEmail: { to: '', subject: '' },
        sendSMS: { to: '', message: '' },
        notification: { title: '', message: '' },
        updateEntity: { entityType: '', updates: {} },
        assignUser: { userId: '' },
        conditional: { condition: '' },
        delay: { duration: '1 hour' },
        waitUntil: { dateTime: '' },
      };

      const newNode: Node = {
        id,
        type,
        position,
        data: defaultData[type] || {},
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance]
  );

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (onNodeClick) {
        onNodeClick(node);
      }
    },
    [onNodeClick]
  );

  return (
    <div ref={reactFlowWrapper} className="w-full h-full" data-testid="workflow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onInit={(instance) => {
          setReactFlowInstance(instance);
          if (reactFlowInstanceRef) reactFlowInstanceRef.current = instance;
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        deleteKeyCode="Delete"
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={true} />
        <MiniMap
          nodeColor={(node) => {
            if (node.type === 'trigger') return 'hsl(var(--primary))';
            if (node.type === 'conditional') return 'hsl(var(--secondary))';
            return 'hsl(var(--muted))';
          }}
          maskColor="rgba(0, 0, 0, 0.1)"
          position="bottom-right"
        />
      </ReactFlow>
    </div>
  );
}
