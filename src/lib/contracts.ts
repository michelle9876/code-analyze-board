import { z } from "zod";

export const artifactScopeQuerySchema = z.enum(["repo", "folder", "file", "history"]);
export type ArtifactScopeQuery = z.infer<typeof artifactScopeQuerySchema>;

export const diagramNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["entry", "module", "service", "data", "ui", "config", "external", "folder", "file"]),
  note: z.string()
});

export const diagramEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string()
});

export const diagramGraphSchema = z.object({
  nodes: z.array(diagramNodeSchema).max(8),
  edges: z.array(diagramEdgeSchema).max(12)
});

export const artifactMetadataSchema = z.object({
  provider: z.enum(["openai", "gemini", "fallback"]),
  promptVersion: z.string(),
  reasoningEffort: z.string().optional(),
  coverageMode: z.enum(["precomputed", "on-demand"]).optional(),
  fallbackReason: z.string().optional(),
  fallbackMessage: z.string().optional(),
  sourceLanguage: z.string().optional(),
  sourcePreviewHtml: z.string().optional(),
  mermaidText: z.string().optional()
});

export const quickScanSchema = z.object({
  summary: z.string(),
  suggestedCategory: z.string(),
  tags: z.array(z.string()).max(6),
  stackHighlights: z.array(z.string()).max(5),
  notableFolders: z.array(
    z.object({
      path: z.string(),
      reason: z.string()
    })
  ).max(5),
  notableFiles: z.array(
    z.object({
      path: z.string(),
      reason: z.string()
    })
  ).max(5)
});

export const repoAnalysisSchema = z.object({
  summary: z.string(),
  architectureOverview: z.string(),
  majorSubsystems: z.array(
    z.object({
      name: z.string(),
      responsibility: z.string(),
      importantPaths: z.array(z.string()).max(3)
    })
  ).max(4),
  keyFlows: z.array(
    z.object({
      title: z.string(),
      steps: z.array(z.string()).max(4)
    })
  ).max(3),
  recommendedReadingOrder: z.array(
    z.object({
      path: z.string(),
      why: z.string()
    })
  ).max(5),
  crossCuttingConcerns: z.array(z.string()).max(4),
  designTradeoffs: z.array(
    z.object({
      decision: z.string(),
      rationale: z.string(),
      downside: z.string()
    })
  ).max(3),
  stack: z.array(
    z.object({
      name: z.string(),
      role: z.string()
    })
  ).max(5),
  developerNotes: z.array(z.string()).max(4),
  technicalPoints: z.array(z.string()).max(5),
  risks: z.array(z.string()).max(4),
  diagram: diagramGraphSchema
});

export const folderAnalysisSchema = z.object({
  summary: z.string(),
  responsibility: z.string(),
  importantChildren: z.array(
    z.object({
      path: z.string(),
      reason: z.string()
    })
  ).max(5),
  upstreamDependencies: z.array(z.string()).max(4),
  downstreamDependencies: z.array(z.string()).max(4),
  patterns: z.array(z.string()).max(4),
  concepts: z.array(z.string()).max(4),
  technicalPoints: z.array(z.string()).max(4),
  considerations: z.array(z.string()).max(3),
  readingOrder: z.array(
    z.object({
      path: z.string(),
      why: z.string()
    })
  ).max(4),
  diagram: diagramGraphSchema
});

export const relatedCommitSchema = z.object({
  sha: z.string(),
  message: z.string()
});

export const fileAnalysisSchema = z.object({
  summary: z.string(),
  purpose: z.string(),
  architectureRole: z.string(),
  inputsOutputs: z.array(z.string()).max(5),
  controlFlow: z.array(z.string()).max(4),
  callSequence: z.array(z.string()).max(5),
  patterns: z.array(z.string()).max(4),
  keySymbols: z.array(
    z.object({
      name: z.string(),
      role: z.string()
    })
  ).max(5),
  glossary: z.array(
    z.object({
      term: z.string(),
      description: z.string()
    })
  ).max(4),
  dependencyNotes: z.array(z.string()).max(4),
  technicalPoints: z.array(z.string()).max(4),
  pitfalls: z.array(z.string()).max(3),
  readingChecklist: z.array(z.string()).max(4),
  relatedFiles: z.array(z.string()).max(5),
  relatedCommits: z.array(relatedCommitSchema).max(4),
  diagram: diagramGraphSchema
});

export const historySummarySchema = z.object({
  summary: z.string(),
  evolutionThemes: z.array(z.string()).max(4),
  hotspots: z.array(
    z.object({
      path: z.string(),
      changeCount: z.number().int(),
      reason: z.string()
    })
  ).max(5),
  recentCommits: z.array(
    z.object({
      sha: z.string(),
      author: z.string(),
      date: z.string(),
      message: z.string(),
      changedPaths: z.array(z.string()).max(4),
      impact: z.string()
    })
  ).max(8),
  pathHighlights: z.array(
    z.object({
      path: z.string(),
      note: z.string()
    })
  ).max(5)
});

export const importRepoRequestSchema = z.object({
  url: z.string().min(1),
  categoryId: z.string().nullable().optional()
});

export const updateCategoryRequestSchema = z.object({
  categoryId: z.string().nullable()
});

export const reanalyzeRequestSchema = z.object({
  scope: artifactScopeQuerySchema.optional(),
  path: z.string().optional()
});

export type QuickScan = z.infer<typeof quickScanSchema>;
export type RepoAnalysis = z.infer<typeof repoAnalysisSchema>;
export type FolderAnalysis = z.infer<typeof folderAnalysisSchema>;
export type FileAnalysis = z.infer<typeof fileAnalysisSchema>;
export type FileAnalysisWithPreview = FileAnalysis & {
  sourcePreviewHtml?: string;
  sourceLanguage?: string;
  sourceExcerpt?: string;
};
export type HistorySummary = z.infer<typeof historySummarySchema>;
export type DiagramGraph = z.infer<typeof diagramGraphSchema>;
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;
export type AnyArtifactData = RepoAnalysis | FolderAnalysis | FileAnalysisWithPreview | HistorySummary;

export type CategoryOption = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  repoCount?: number;
};

export type RepositoryListItem = {
  id: string;
  name: string;
  owner: string | null;
  url: string;
  canonicalUrl: string;
  status: string;
  importProgress: number;
  quickSummary: string | null;
  architectureOverview: string | null;
  aiSuggestedCategory: string | null;
  aiTags: string[];
  detectedLanguages: string[];
  detectedFrameworks: string[];
  lastAnalyzedAt: string | null;
  updatedAt: string;
  errorMessage: string | null;
  headCommitSha: string | null;
  latestAnalysisProvider: ArtifactMetadata["provider"] | null;
  latestAnalysisModel: string | null;
  latestAnalysisUpdatedAt: string | null;
  latestAnalysisReason: string | null;
  latestAnalysisMessage: string | null;
  hasLiveAnalysis: boolean;
  category: CategoryOption | null;
};

export type TreeNodePayload = {
  name: string;
  path: string;
  type: "directory" | "file";
  extension: string | null;
  size: number | null;
  children?: TreeNodePayload[];
  analysisState: "missing" | "pending" | "ready";
};

export type ArtifactEnvelope<T = AnyArtifactData> = {
  id: string;
  scope: ArtifactScopeQuery;
  path: string;
  model: string;
  status: string;
  summary: string | null;
  markdown: string | null;
  data: T;
  mermaidText: string | null;
  updatedAt: string;
  commitSha: string;
  sourceExcerpt: string | null;
  metadata: ArtifactMetadata | null;
};
