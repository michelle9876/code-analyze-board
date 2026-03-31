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
  nodes: z.array(diagramNodeSchema),
  edges: z.array(diagramEdgeSchema)
});

export const artifactMetadataSchema = z.object({
  provider: z.enum(["openai", "fallback"]),
  promptVersion: z.string(),
  reasoningEffort: z.string().optional(),
  coverageMode: z.enum(["precomputed", "on-demand"]).optional(),
  sourceLanguage: z.string().optional(),
  sourcePreviewHtml: z.string().optional(),
  mermaidText: z.string().optional()
});

export const quickScanSchema = z.object({
  summary: z.string(),
  suggestedCategory: z.string(),
  tags: z.array(z.string()),
  stackHighlights: z.array(z.string()),
  notableFolders: z.array(
    z.object({
      path: z.string(),
      reason: z.string()
    })
  ),
  notableFiles: z.array(
    z.object({
      path: z.string(),
      reason: z.string()
    })
  )
});

export const repoAnalysisSchema = z.object({
  summary: z.string(),
  architectureOverview: z.string(),
  majorSubsystems: z.array(
    z.object({
      name: z.string(),
      responsibility: z.string(),
      importantPaths: z.array(z.string())
    })
  ),
  keyFlows: z.array(
    z.object({
      title: z.string(),
      steps: z.array(z.string())
    })
  ),
  recommendedReadingOrder: z.array(
    z.object({
      path: z.string(),
      why: z.string()
    })
  ),
  crossCuttingConcerns: z.array(z.string()),
  designTradeoffs: z.array(
    z.object({
      decision: z.string(),
      rationale: z.string(),
      downside: z.string()
    })
  ),
  stack: z.array(
    z.object({
      name: z.string(),
      role: z.string()
    })
  ),
  developerNotes: z.array(z.string()),
  technicalPoints: z.array(z.string()),
  risks: z.array(z.string()),
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
  ),
  upstreamDependencies: z.array(z.string()),
  downstreamDependencies: z.array(z.string()),
  patterns: z.array(z.string()),
  concepts: z.array(z.string()),
  technicalPoints: z.array(z.string()),
  considerations: z.array(z.string()),
  readingOrder: z.array(
    z.object({
      path: z.string(),
      why: z.string()
    })
  ),
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
  inputsOutputs: z.array(z.string()),
  controlFlow: z.array(z.string()),
  callSequence: z.array(z.string()),
  patterns: z.array(z.string()),
  keySymbols: z.array(
    z.object({
      name: z.string(),
      role: z.string()
    })
  ),
  glossary: z.array(
    z.object({
      term: z.string(),
      description: z.string()
    })
  ),
  dependencyNotes: z.array(z.string()),
  technicalPoints: z.array(z.string()),
  pitfalls: z.array(z.string()),
  readingChecklist: z.array(z.string()),
  relatedFiles: z.array(z.string()),
  relatedCommits: z.array(relatedCommitSchema),
  diagram: diagramGraphSchema
});

export const historySummarySchema = z.object({
  summary: z.string(),
  evolutionThemes: z.array(z.string()),
  hotspots: z.array(
    z.object({
      path: z.string(),
      changeCount: z.number().int(),
      reason: z.string()
    })
  ),
  recentCommits: z.array(
    z.object({
      sha: z.string(),
      author: z.string(),
      date: z.string(),
      message: z.string(),
      changedPaths: z.array(z.string()),
      impact: z.string()
    })
  ),
  pathHighlights: z.array(
    z.object({
      path: z.string(),
      note: z.string()
    })
  )
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
