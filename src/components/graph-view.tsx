"use client";

import "@xyflow/react/dist/style.css";
import { Background, Controls, MarkerType, MiniMap, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";
import type { DiagramGraph } from "@/lib/contracts";

export default function GraphView({ graph }: { graph: DiagramGraph }) {
  const { nodes, edges } = useMemo(() => {
    const mappedNodes = graph.nodes.map((node, index) => ({
      id: node.id,
      position:
        index === 0
          ? { x: 240, y: 20 }
          : {
              x: (index % 3) * 220 + 20,
              y: Math.floor(index / 3) * 140 + 140
            },
      data: {
        label: `${node.label}\n${node.note}`
      },
      style: {
        borderRadius: 20,
        border: "1px solid rgba(21,53,94,0.14)",
        background: "rgba(255,255,255,0.92)",
        padding: 12,
        color: "#15233b",
        width: 180,
        whiteSpace: "pre-wrap",
        boxShadow: "0 12px 24px rgba(15, 32, 58, 0.08)"
      }
    }));

    const mappedEdges = graph.edges.map((edge, index) => ({
      id: `edge-${index}`,
      source: edge.from,
      target: edge.to,
      label: edge.label,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#165dff" },
      labelStyle: { fill: "#15233b", fontSize: 12 }
    }));

    return { nodes: mappedNodes, edges: mappedEdges };
  }, [graph]);

  return (
    <div className="h-[420px] rounded-[1.5rem] border border-line bg-white/80">
      <ReactFlow fitView nodes={nodes} edges={edges}>
        <MiniMap zoomable pannable />
        <Controls />
        <Background gap={20} color="rgba(21,53,94,0.08)" />
      </ReactFlow>
    </div>
  );
}
