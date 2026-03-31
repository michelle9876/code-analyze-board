"use client";

import { ChevronRight, FileCode2, FolderOpen } from "lucide-react";
import type { TreeNodePayload } from "@/lib/contracts";
import { cn, formatBytes } from "@/lib/utils";

function Dot({ state }: { state: TreeNodePayload["analysisState"] }) {
  return (
    <span
      className={cn(
        "inline-block h-2.5 w-2.5 rounded-full",
        state === "ready" ? "bg-success" : state === "pending" ? "bg-warning" : "bg-slate-300"
      )}
    />
  );
}

function TreeNodeRow({
  node,
  depth,
  selectedPath,
  onSelect
}: {
  node: TreeNodePayload;
  depth: number;
  selectedPath: string | null;
  onSelect: (node: TreeNodePayload) => void;
}) {
  const isSelected = selectedPath === node.path;

  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(node)}
        className={cn(
          "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition hover:bg-white/80",
          isSelected && "bg-white shadow-card"
        )}
        style={{ paddingLeft: `${depth * 14 + 12}px` }}
      >
        <Dot state={node.analysisState} />
        {node.type === "directory" ? <FolderOpen className="h-4 w-4 text-accent" /> : <FileCode2 className="h-4 w-4 text-accentWarm" />}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {node.size ? <span className="text-xs text-slate-500">{formatBytes(node.size)}</span> : null}
        {node.children?.length ? <ChevronRight className="h-4 w-4 text-slate-400" /> : null}
      </button>
      {node.children?.map((child) => (
        <TreeNodeRow key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function RepoTree({
  tree,
  selectedPath,
  onSelect
}: {
  tree: TreeNodePayload[];
  selectedPath: string | null;
  onSelect: (node: TreeNodePayload) => void;
}) {
  return (
    <div className="space-y-1">
      {tree.map((node) => (
        <TreeNodeRow key={node.path} node={node} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </div>
  );
}
