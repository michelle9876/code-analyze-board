import type { AnalysisArtifact, ArtifactScope, Category, Repository } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DEFAULT_CATEGORIES } from "@/lib/constants";
import type { ArtifactEnvelope, ArtifactMetadata, ArtifactScopeQuery, CategoryOption, RepositoryListItem } from "@/lib/contracts";
import { safeJsonParse } from "@/lib/utils";

const scopeToQuery: Record<ArtifactScope, ArtifactScopeQuery> = {
  REPO: "repo",
  FOLDER: "folder",
  FILE: "file",
  HISTORY: "history"
};

export async function ensureDefaultCategories() {
  for (const category of DEFAULT_CATEGORIES) {
    await prisma.category.upsert({
      where: { name: category.name },
      update: category,
      create: category
    });
  }
}

export async function getCategories() {
  await ensureDefaultCategories();
  const categories = await prisma.category.findMany({
    include: {
      _count: {
        select: {
          repositories: true
        }
      }
    },
    orderBy: {
      name: "asc"
    }
  });

  return categories.map(serializeCategory);
}

export function serializeCategory(category: Category & { _count?: { repositories: number } }): CategoryOption {
  return {
    id: category.id,
    name: category.name,
    color: category.color,
    description: category.description,
    repoCount: category._count?.repositories
  };
}

function normalizeArtifactMetadata(raw: unknown): ArtifactMetadata | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const metadata = raw as Record<string, unknown>;

  return {
    provider: metadata.provider === "openai" || metadata.provider === "gemini" ? metadata.provider : "fallback",
    promptVersion: typeof metadata.promptVersion === "string" ? metadata.promptVersion : "legacy",
    reasoningEffort: typeof metadata.reasoningEffort === "string" ? metadata.reasoningEffort : undefined,
    coverageMode: metadata.coverageMode === "precomputed" || metadata.coverageMode === "on-demand" ? metadata.coverageMode : undefined,
    fallbackReason: typeof metadata.fallbackReason === "string" ? metadata.fallbackReason : undefined,
    fallbackMessage: typeof metadata.fallbackMessage === "string" ? metadata.fallbackMessage : undefined,
    sourceLanguage: typeof metadata.sourceLanguage === "string" ? metadata.sourceLanguage : undefined,
    sourcePreviewHtml: typeof metadata.sourcePreviewHtml === "string" ? metadata.sourcePreviewHtml : undefined,
    mermaidText: typeof metadata.mermaidText === "string" ? metadata.mermaidText : undefined
  };
}

export function serializeRepository(
  repository: Repository & { category: Category | null; artifacts?: AnalysisArtifact[] }
): RepositoryListItem {
  const latestRepoArtifact = repository.artifacts?.[0] || null;
  const latestMetadata = latestRepoArtifact
    ? normalizeArtifactMetadata(safeJsonParse<Record<string, unknown> | null>(latestRepoArtifact.metadataJson, null))
    : null;

  return {
    id: repository.id,
    name: repository.name,
    owner: repository.owner,
    url: repository.url,
    canonicalUrl: repository.canonicalUrl,
    status: repository.status,
    importProgress: repository.importProgress,
    quickSummary: repository.quickSummary,
    architectureOverview: repository.architectureOverview,
    aiSuggestedCategory: repository.aiSuggestedCategory,
    aiTags: safeJsonParse<string[]>(repository.aiTagsJson, []),
    detectedLanguages: safeJsonParse<string[]>(repository.detectedLanguagesJson, []),
    detectedFrameworks: safeJsonParse<string[]>(repository.detectedFrameworksJson, []),
    lastAnalyzedAt: repository.lastAnalyzedAt?.toISOString() || null,
    updatedAt: repository.updatedAt.toISOString(),
    errorMessage: repository.errorMessage,
    headCommitSha: repository.headCommitSha,
    latestAnalysisProvider: latestMetadata?.provider || null,
    latestAnalysisModel: latestRepoArtifact?.model || null,
    latestAnalysisUpdatedAt: latestRepoArtifact?.updatedAt.toISOString() || null,
    latestAnalysisReason: latestMetadata?.fallbackReason || null,
    latestAnalysisMessage: latestMetadata?.fallbackMessage || null,
    hasLiveAnalysis: latestMetadata?.provider === "openai" || latestMetadata?.provider === "gemini",
    category: repository.category ? serializeCategory(repository.category) : null
  };
}

export function serializeArtifact(artifact: AnalysisArtifact): ArtifactEnvelope {
  const metadata = normalizeArtifactMetadata(safeJsonParse<Record<string, unknown> | null>(artifact.metadataJson, null));

  return {
    id: artifact.id,
    scope: scopeToQuery[artifact.scope],
    path: artifact.path,
    model: artifact.model,
    status: artifact.status,
    summary: artifact.summary,
    markdown: artifact.markdown,
    data: safeJsonParse(artifact.dataJson, {}),
    mermaidText: metadata?.mermaidText || null,
    updatedAt: artifact.updatedAt.toISOString(),
    commitSha: artifact.commitSha,
    sourceExcerpt: artifact.sourceExcerpt,
    metadata
  };
}

export async function getBoardRepositories() {
  await ensureDefaultCategories();
  const repositories = await prisma.repository.findMany({
    include: {
      category: true,
      artifacts: {
        where: {
          scope: "REPO"
        },
        orderBy: {
          updatedAt: "desc"
        },
        take: 1
      }
    },
    orderBy: {
      updatedAt: "desc"
    }
  });

  return repositories.map(serializeRepository);
}

export async function getRepositoryById(id: string) {
  return prisma.repository.findUnique({
    where: { id },
    include: {
      category: true,
      artifacts: {
        where: {
          scope: "REPO"
        },
        orderBy: {
          updatedAt: "desc"
        },
        take: 1
      }
    }
  });
}

export async function getLatestArtifact(repositoryId: string, scope: ArtifactScope, path = "", commitSha?: string | null) {
  return prisma.analysisArtifact.findFirst({
    where: {
      repositoryId,
      scope,
      path,
      ...(commitSha ? { commitSha } : {})
    },
    orderBy: {
      updatedAt: "desc"
    }
  });
}

export async function getReadyAndPendingPaths(repositoryId: string, commitSha: string | null) {
  const [artifacts, jobs] = await Promise.all([
    prisma.analysisArtifact.findMany({
      where: {
        repositoryId,
        commitSha: commitSha || undefined,
        scope: {
          in: ["FOLDER", "FILE"]
        }
      },
      select: {
        path: true
      }
    }),
    prisma.analysisJob.findMany({
      where: {
        repositoryId,
        status: {
          in: ["PENDING", "RUNNING"]
        },
        scope: {
          in: ["FOLDER", "FILE"]
        }
      },
      select: {
        path: true
      }
    })
  ]);

  return {
    ready: new Set(artifacts.map((artifact) => artifact.path).filter(Boolean)),
    pending: new Set(jobs.map((job) => job.path).filter(Boolean) as string[])
  };
}
