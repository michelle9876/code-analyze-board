"use client";

import "@xyflow/react/dist/style.css";
import { Background, Controls, MarkerType, MiniMap, ReactFlow } from "@xyflow/react";
import type { CSSProperties, ReactNode } from "react";
import { useMemo } from "react";
import type { DiagramGraph } from "@/lib/contracts";

export default function GraphView({ graph }: { graph: DiagramGraph }) {
  const { nodes, edges } = useMemo(() => {
    const laneByKind: Record<DiagramGraph["nodes"][number]["kind"], number> = {
      config: 0,
      entry: 1,
      service: 2,
      module: 2,
      data: 3,
      external: 4,
      ui: 2,
      folder: 2,
      file: 2
    };
    const laneOffsets = new Map<number, number>();
    const styleByKind: Record<DiagramGraph["nodes"][number]["kind"], CSSProperties> = {
      entry: {
        border: "1px solid rgba(3,105,161,0.24)",
        background: "linear-gradient(180deg, rgba(224,242,254,0.96), rgba(255,255,255,0.98))",
        color: "#0c4a6e"
      },
      service: {
        border: "1px solid rgba(8,145,178,0.22)",
        background: "linear-gradient(180deg, rgba(236,254,255,0.96), rgba(255,255,255,0.98))",
        color: "#155e75"
      },
      module: {
        border: "1px solid rgba(59,130,246,0.18)",
        background: "linear-gradient(180deg, rgba(239,246,255,0.96), rgba(255,255,255,0.98))",
        color: "#1d4ed8"
      },
      data: {
        border: "1px solid rgba(13,148,136,0.22)",
        background: "linear-gradient(180deg, rgba(240,253,250,0.96), rgba(255,255,255,0.98))",
        color: "#115e59"
      },
      external: {
        border: "1px solid rgba(217,119,6,0.22)",
        background: "linear-gradient(180deg, rgba(255,247,237,0.96), rgba(255,255,255,0.98))",
        color: "#9a3412"
      },
      config: {
        border: "1px solid rgba(124,58,237,0.2)",
        background: "linear-gradient(180deg, rgba(245,243,255,0.96), rgba(255,255,255,0.98))",
        color: "#6d28d9"
      },
      ui: {
        border: "1px solid rgba(190,24,93,0.18)",
        background: "linear-gradient(180deg, rgba(253,242,248,0.96), rgba(255,255,255,0.98))",
        color: "#9d174d"
      },
      folder: {
        border: "1px solid rgba(71,85,105,0.18)",
        background: "linear-gradient(180deg, rgba(248,250,252,0.96), rgba(255,255,255,0.98))",
        color: "#334155"
      },
      file: {
        border: "1px solid rgba(100,116,139,0.18)",
        background: "linear-gradient(180deg, rgba(248,250,252,0.96), rgba(255,255,255,0.98))",
        color: "#334155"
      }
    };
    const badgeByKind: Record<DiagramGraph["nodes"][number]["kind"], string> = {
      entry: "ENTRY",
      service: "SERVICE",
      module: "MODULE",
      data: "DATA",
      external: "EXTERNAL",
      config: "CONFIG",
      ui: "UI",
      folder: "FOLDER",
      file: "FILE"
    };

    const mappedNodes = graph.nodes.map((node, index) => ({
      id: node.id,
      position: (() => {
        const lane = laneByKind[node.kind] ?? 2;
        const laneIndex = laneOffsets.get(lane) || 0;
        laneOffsets.set(lane, laneIndex + 1);
        return {
          x: lane * 210 + 24,
          y: laneIndex * 132 + (lane === 0 ? 24 : 56)
        };
      })(),
      data: {
        label: (
          <div className="space-y-2">
            <div className="inline-flex rounded-full border border-black/5 bg-black/5 px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] text-current/80">
              {badgeByKind[node.kind]}
            </div>
            <div className="text-sm font-semibold leading-5">{node.label}</div>
            <div className="text-xs leading-5 text-current/75">{node.note}</div>
          </div>
        ) satisfies ReactNode
      },
      style: {
        borderRadius: 20,
        padding: 14,
        width: 188,
        boxShadow: "0 16px 30px rgba(15, 32, 58, 0.08)",
        ...styleByKind[node.kind]
      }
    }));

    const mappedEdges = graph.edges.map((edge, index) => ({
      id: `edge-${index}`,
      source: edge.from,
      target: edge.to,
      label: edge.label,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#2563eb", strokeWidth: 1.6 },
      labelStyle: { fill: "#1e293b", fontSize: 12, fontWeight: 600 },
      labelBgStyle: { fill: "rgba(255,255,255,0.92)" },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 999
    }));

    return { nodes: mappedNodes, edges: mappedEdges };
  }, [graph]);

  return (
    <div className="h-[460px] rounded-[1.5rem] border border-line bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,0.96))]">
      <ReactFlow fitView nodes={nodes} edges={edges}>
        <MiniMap zoomable pannable />
        <Controls />
        <Background gap={20} color="rgba(21,53,94,0.08)" />
      </ReactFlow>
    </div>
  );
}
