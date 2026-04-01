import type { AnalysisJob, ArtifactScope, JobType } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  analyzeFile,
  analyzeFolder,
  analyzeHistory,
  analyzeQuickScan,
  analyzeRepository,
  buildArtifactMarkdown
} from "@/lib/analysis";
import {
  ensureRepositoryClone,
  getHeadCommitSha,
  readPathCommits,
  readRecentCommits
} from "@/lib/git";
import {
  buildFileAnalysisContext,
  buildFolderAnalysisContext,
  buildRepositorySnapshot,
  findTreeNode
} from "@/lib/repository";
import { safeJsonParse } from "@/lib/utils";

const ACTIVE_STATUSES = ["PENDING", "RUNNING"] as const;

const scopeQueryToArtifactScope: Record<"repo" | "folder" | "file" | "history", ArtifactScope> = {
  repo: "REPO",
  folder: "FOLDER",
  file: "FILE",
  history: "HISTORY"
};

const artifactScopeToJobType: Record<ArtifactScope, JobType> = {
  REPO: "ANALYZE_REPO",
  FOLDER: "ANALYZE_FOLDER",
  FILE: "ANALYZE_FILE",
  HISTORY: "ANALYZE_HISTORY"
};

type SchedulingTreeNode = {
  path: string;
  type: "directory" | "file";
  children?: SchedulingTreeNode[];
};

type CoverageMode = "precomputed" | "on-demand";
type JobPayload = {
  coverageMode?: CoverageMode;
};

function collectBreadthFirstPaths(tree: SchedulingTreeNode[]) {
  const directories: string[] = [];
  const files: string[] = [];
  const queue = [...tree];

  while (queue.length) {
    const node = queue.shift();
    if (!node) {
      continue;
    }

    if (node.type === "directory") {
      directories.push(node.path);
    } else {
      files.push(node.path);
    }

    if (node.children?.length) {
      queue.push(...node.children);
    }
  }

  return { directories, files };
}

export function toArtifactScope(scope: "repo" | "folder" | "file" | "history") {
  return scopeQueryToArtifactScope[scope];
}

function parseJobPayload(payloadJson: string | null): JobPayload {
  return safeJsonParse<JobPayload | null>(payloadJson, null) || {};
}

function withJobMetadata(job: Pick<AnalysisJob, "payloadJson">, metadata?: Record<string, unknown>) {
  const payload = parseJobPayload(job.payloadJson);

  return {
    ...(metadata || {}),
    ...(payload.coverageMode ? { coverageMode: payload.coverageMode } : {})
  };
}

export async function enqueueJob(repositoryId: string, input: {
  type: JobType;
  priority?: number;
  scope?: ArtifactScope;
  path?: string | null;
  force?: boolean;
  payload?: Record<string, unknown> | null;
}) {
  const path = input.path || null;

  if (!input.force) {
    const existing = await prisma.analysisJob.findFirst({
      where: {
        repositoryId,
        type: input.type,
        scope: input.scope ?? null,
        path,
        status: {
          in: [...ACTIVE_STATUSES]
        }
      }
    });

    if (existing) {
      return existing;
    }
  }

  return prisma.analysisJob.create({
    data: {
      repositoryId,
      type: input.type,
      priority: input.priority ?? 100,
      scope: input.scope,
      path,
      force: input.force ?? false,
      payloadJson: input.payload ? JSON.stringify(input.payload) : null
    }
  });
}

export async function enqueueAnalysisScope(
  repositoryId: string,
  scope: "repo" | "folder" | "file" | "history",
  path?: string,
  force = true,
  payload?: JobPayload
) {
  const artifactScope = toArtifactScope(scope);
  return enqueueJob(repositoryId, {
    type: artifactScopeToJobType[artifactScope],
    scope: artifactScope,
    path: path || null,
    priority: scope === "repo" ? 20 : scope === "history" ? 30 : 40,
    force,
    payload
  });
}

export async function enqueueRepositoryRefresh(repositoryId: string, force = true) {
  await enqueueJob(repositoryId, {
    type: "QUICK_SCAN",
    priority: 10,
    force
  });

  await enqueueJob(repositoryId, {
    type: "ANALYZE_REPO",
    scope: "REPO",
    path: "",
    priority: 20,
    force,
    payload: { coverageMode: "precomputed" }
  });

  await enqueueJob(repositoryId, {
    type: "ANALYZE_HISTORY",
    scope: "HISTORY",
    path: "",
    priority: 30,
    force,
    payload: { coverageMode: "precomputed" }
  });
}

async function getCurrentCommitSha(repositoryId: string) {
  const repository = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repository) {
    throw new Error("Repository not found.");
  }

  if (repository.headCommitSha) {
    return repository.headCommitSha;
  }

  const commitSha = await getHeadCommitSha(repository.clonePath);
  await prisma.repository.update({
    where: { id: repository.id },
    data: { headCommitSha: commitSha }
  });

  return commitSha;
}

async function artifactExists(repositoryId: string, scope: ArtifactScope, path: string, commitSha: string) {
  return prisma.analysisArtifact.findUnique({
    where: {
      repositoryId_scope_path_commitSha: {
        repositoryId,
        scope,
        path,
        commitSha
      }
    }
  });
}

async function persistArtifact(repositoryId: string, scope: ArtifactScope, path: string, commitSha: string, result: {
  model: string;
  data: unknown;
  markdown: string;
  mermaidText: string;
  metadata?: Record<string, unknown>;
  sourceExcerpt?: string;
}) {
  const summary = typeof (result.data as { summary?: unknown }).summary === "string" ? (result.data as { summary: string }).summary : null;

  return prisma.analysisArtifact.upsert({
    where: {
      repositoryId_scope_path_commitSha: {
        repositoryId,
        scope,
        path,
        commitSha
      }
    },
    update: {
      model: result.model,
      summary,
      markdown: result.markdown,
      dataJson: JSON.stringify(result.data),
      metadataJson: JSON.stringify({ ...(result.metadata || {}), mermaidText: result.mermaidText }),
      sourceExcerpt: result.sourceExcerpt || null,
      status: "READY"
    },
    create: {
      repositoryId,
      scope,
      path,
      commitSha,
      model: result.model,
      summary,
      markdown: result.markdown,
      dataJson: JSON.stringify(result.data),
      metadataJson: JSON.stringify({ ...(result.metadata || {}), mermaidText: result.mermaidText }),
      sourceExcerpt: result.sourceExcerpt || null,
      status: "READY"
    }
  });
}

async function refreshRepositoryState(repositoryId: string) {
  const repository = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repository) {
    return;
  }

  const coreJobTypes = ["QUICK_SCAN", "ANALYZE_REPO", "ANALYZE_HISTORY"] as const;
  const [
    totalJobs,
    activeJobs,
    completedJobs,
    failedJobs,
    coreTotalJobs,
    coreCompletedJobs,
    coreFailedJobs,
    repoArtifactCount,
    historyArtifactCount
  ] = await Promise.all([
    prisma.analysisJob.count({ where: { repositoryId } }),
    prisma.analysisJob.count({ where: { repositoryId, status: { in: [...ACTIVE_STATUSES] } } }),
    prisma.analysisJob.count({ where: { repositoryId, status: "COMPLETED" } }),
    prisma.analysisJob.count({ where: { repositoryId, status: "FAILED" } }),
    prisma.analysisJob.count({ where: { repositoryId, type: { in: [...coreJobTypes] } } }),
    prisma.analysisJob.count({ where: { repositoryId, type: { in: [...coreJobTypes] }, status: "COMPLETED" } }),
    prisma.analysisJob.count({ where: { repositoryId, type: { in: [...coreJobTypes] }, status: "FAILED" } }),
    repository.headCommitSha
      ? prisma.analysisArtifact.count({
          where: { repositoryId, scope: "REPO", path: "", commitSha: repository.headCommitSha, status: "READY" }
        })
      : Promise.resolve(0),
    repository.headCommitSha
      ? prisma.analysisArtifact.count({
          where: { repositoryId, scope: "HISTORY", path: "", commitSha: repository.headCommitSha, status: "READY" }
        })
      : Promise.resolve(0)
  ]);

  const cloneReady = Boolean(repository.headCommitSha);
  const quickScanReady = Boolean(repository.quickSummary);
  const repoReady = repoArtifactCount > 0;
  const historyReady = historyArtifactCount > 0;
  const coreReady = quickScanReady && repoReady && historyReady;
  const coreDenominator = Math.max(1, coreTotalJobs || 3);
  const weightedCoreProgress = Math.round((coreCompletedJobs / coreDenominator) * 88);
  const progress = Math.max(
    repository.importProgress,
    cloneReady ? 15 : 1,
    quickScanReady ? 45 : 0,
    repoReady ? 72 : 0,
    historyReady ? 88 : 0,
    weightedCoreProgress,
    coreReady ? 100 : 0
  );
  const status = coreReady
    ? "READY"
    : activeJobs > 0
      ? "ANALYZING"
      : coreFailedJobs > 0 && coreCompletedJobs === 0
        ? "FAILED"
        : failedJobs > 0 && completedJobs === 0
          ? "FAILED"
          : totalJobs > completedJobs + failedJobs
            ? "ANALYZING"
            : "READY";

  await prisma.repository.update({
    where: { id: repositoryId },
    data: {
      status,
      importProgress: status === "READY" ? 100 : progress,
      lastAnalyzedAt: status === "READY" ? new Date() : repository.lastAnalyzedAt
    }
  });
}

async function handleImportRepositoryJob(job: AnalysisJob) {
  const repository = await prisma.repository.findUnique({ where: { id: job.repositoryId } });
  if (!repository) {
    throw new Error("Repository not found.");
  }

  const previousHead = repository.headCommitSha;
  const clone = await ensureRepositoryClone(repository.url || repository.canonicalUrl, repository.clonePath);

  await prisma.repository.update({
    where: { id: repository.id },
    data: {
      clonePath: clone.clonePath,
      defaultBranch: clone.defaultBranch,
      headCommitSha: clone.headCommitSha,
      status: "ANALYZING",
      importProgress: Math.max(repository.importProgress, 8),
      errorMessage: null
    }
  });

  const headChanged = previousHead !== clone.headCommitSha;
  if (!headChanged && !job.force) {
    return;
  }

  await enqueueJob(repository.id, { type: "QUICK_SCAN", priority: 10, force: true });
  await enqueueJob(repository.id, { type: "ANALYZE_REPO", scope: "REPO", path: "", priority: 20, force: true, payload: { coverageMode: "precomputed" } });
  await enqueueJob(repository.id, { type: "ANALYZE_HISTORY", scope: "HISTORY", path: "", priority: 30, force: true, payload: { coverageMode: "precomputed" } });
}

async function handleQuickScanJob(job: AnalysisJob) {
  const repository = await prisma.repository.findUnique({ where: { id: job.repositoryId } });
  if (!repository) {
    throw new Error("Repository not found.");
  }

  const snapshot = await buildRepositorySnapshot(repository.clonePath);
  const result = await analyzeQuickScan(snapshot);
  const { directories: breadthDirectories, files: breadthFiles } = collectBreadthFirstPaths(
    snapshot.tree as SchedulingTreeNode[]
  );

  await prisma.repository.update({
    where: { id: repository.id },
    data: {
      quickSummary: result.data.summary,
      aiSuggestedCategory: result.data.suggestedCategory,
      aiTagsJson: JSON.stringify(result.data.tags),
      detectedLanguagesJson: JSON.stringify(snapshot.languages.map((language) => language.name)),
      detectedFrameworksJson: JSON.stringify(snapshot.frameworks),
      importProgress: Math.max(repository.importProgress, 35),
      status: "ANALYZING"
    }
  });

  const isLargeRepo = snapshot.totalFiles >= 120 || snapshot.totalDirectories >= 40;
  const isHugeRepo = snapshot.totalFiles >= 250 || snapshot.totalDirectories >= 80;
  const folderCandidates = [
    ...result.data.notableFolders.map((folder) => folder.path),
    ...(isLargeRepo ? snapshot.topLevelDirectories : []),
    ...breadthDirectories
  ];
  const folderLimit = snapshot.totalFiles <= 20
    ? breadthDirectories.length
    : isHugeRepo
      ? 0
      : isLargeRepo
        ? 2
        : breadthDirectories.length <= 10
          ? breadthDirectories.length
          : 8;

  for (const folderPath of [...new Set(folderCandidates)].slice(0, folderLimit)) {
    const node = findTreeNode(snapshot.tree, folderPath);
    if (node?.type === "directory") {
      await enqueueJob(repository.id, {
        type: "ANALYZE_FOLDER",
        scope: "FOLDER",
        path: folderPath,
        priority: 40,
        force: false,
        payload: { coverageMode: "precomputed" }
      });
    }
  }

  const fileCandidates = [
    ...result.data.notableFiles.map((file) => file.path),
    ...snapshot.representativeFiles.map((file) => file.path),
    ...breadthFiles
  ];
  const fileLimit = snapshot.totalFiles <= 20
    ? Math.min(20, fileCandidates.length)
    : isHugeRepo
      ? Math.min(2, fileCandidates.length)
      : isLargeRepo
        ? Math.min(4, fileCandidates.length)
        : breadthFiles.length <= 20
          ? breadthFiles.length
          : 12;

  for (const filePath of [...new Set(fileCandidates)].slice(0, fileLimit)) {
    const node = findTreeNode(snapshot.tree, filePath);
    if (node?.type === "file") {
      await enqueueJob(repository.id, {
        type: "ANALYZE_FILE",
        scope: "FILE",
        path: filePath,
        priority: 50,
        force: false,
        payload: { coverageMode: "precomputed" }
      });
    }
  }
}

async function handleAnalyzeRepoJob(job: AnalysisJob) {
  const repository = await prisma.repository.findUnique({ where: { id: job.repositoryId } });
  if (!repository) {
    throw new Error("Repository not found.");
  }

  const commitSha = await getCurrentCommitSha(repository.id);
  const existing = !job.force ? await artifactExists(repository.id, "REPO", "", commitSha) : null;
  if (existing) {
    return;
  }

  const [snapshot, recentCommits] = await Promise.all([
    buildRepositorySnapshot(repository.clonePath),
    readRecentCommits(repository.clonePath)
  ]);
  const result = await analyzeRepository(snapshot, recentCommits);

  await persistArtifact(repository.id, "REPO", "", commitSha, {
    ...result,
    metadata: withJobMetadata(job, result.metadata)
  });
  await prisma.repository.update({
    where: { id: repository.id },
    data: {
      architectureOverview: result.data.architectureOverview,
      importProgress: Math.max(repository.importProgress, 70)
    }
  });
}

async function handleAnalyzeHistoryJob(job: AnalysisJob) {
  const repository = await prisma.repository.findUnique({ where: { id: job.repositoryId } });
  if (!repository) {
    throw new Error("Repository not found.");
  }

  const commitSha = await getCurrentCommitSha(repository.id);
  const existing = !job.force ? await artifactExists(repository.id, "HISTORY", "", commitSha) : null;
  if (existing) {
    return;
  }

  const commits = await readRecentCommits(repository.clonePath);
  const result = await analyzeHistory(commits);
  await persistArtifact(repository.id, "HISTORY", "", commitSha, {
    ...result,
    metadata: withJobMetadata(job, result.metadata)
  });
}

async function handleAnalyzeFolderJob(job: AnalysisJob) {
  if (!job.path) {
    throw new Error("Folder analysis path is missing.");
  }

  const repository = await prisma.repository.findUnique({ where: { id: job.repositoryId } });
  if (!repository) {
    throw new Error("Repository not found.");
  }

  const commitSha = await getCurrentCommitSha(repository.id);
  const existing = !job.force ? await artifactExists(repository.id, "FOLDER", job.path, commitSha) : null;
  if (existing) {
    return;
  }

  const [snapshot, commits] = await Promise.all([
    buildRepositorySnapshot(repository.clonePath),
    readPathCommits(repository.clonePath, job.path)
  ]);
  const context = await buildFolderAnalysisContext(repository.clonePath, snapshot, job.path, commits);
  const result = await analyzeFolder(context);
  await persistArtifact(repository.id, "FOLDER", job.path, commitSha, {
    ...result,
    metadata: withJobMetadata(job, result.metadata)
  });
}

async function handleAnalyzeFileJob(job: AnalysisJob) {
  if (!job.path) {
    throw new Error("File analysis path is missing.");
  }

  const repository = await prisma.repository.findUnique({ where: { id: job.repositoryId } });
  if (!repository) {
    throw new Error("Repository not found.");
  }

  const commitSha = await getCurrentCommitSha(repository.id);
  const existing = !job.force ? await artifactExists(repository.id, "FILE", job.path, commitSha) : null;
  if (existing) {
    return;
  }

  const commits = await readPathCommits(repository.clonePath, job.path);
  const context = await buildFileAnalysisContext(repository.clonePath, job.path, commits);
  const result = await analyzeFile(context);
  await persistArtifact(repository.id, "FILE", job.path, commitSha, {
    ...result,
    metadata: withJobMetadata(job, result.metadata)
  });
}

async function markJobCompleted(jobId: string) {
  await prisma.analysisJob.update({
    where: { id: jobId },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      errorMessage: null
    }
  });
}

async function markJobFailed(job: AnalysisJob, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown job failure";
  const nextAttempts = job.attempts + 1;
  const shouldRetry = nextAttempts < job.maxAttempts;

  await prisma.analysisJob.update({
    where: { id: job.id },
    data: {
      attempts: nextAttempts,
      status: shouldRetry ? "PENDING" : "FAILED",
      errorMessage: message,
      completedAt: shouldRetry ? null : new Date()
    }
  });

  await prisma.repository.update({
    where: { id: job.repositoryId },
    data: {
      errorMessage: shouldRetry ? null : message,
      status: shouldRetry ? "ANALYZING" : "FAILED"
    }
  });
}

export async function recoverStaleJobs() {
  const staleBefore = new Date(Date.now() - Number(process.env.WORKER_STALE_MS || 1000 * 60 * 15));
  const recovered = await prisma.analysisJob.updateMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: staleBefore }
    },
    data: {
      status: "PENDING",
      startedAt: null,
      errorMessage: null
    }
  });

  return recovered.count;
}

export async function processNextJob() {
  const nextJob = await prisma.analysisJob.findFirst({
    where: {
      status: "PENDING"
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
  });

  if (!nextJob) {
    return false;
  }

  const startedAt = new Date();
  const claimed = await prisma.analysisJob.updateMany({
    where: { id: nextJob.id, status: "PENDING" },
    data: {
      status: "RUNNING",
      startedAt
    }
  });

  if (claimed.count === 0) {
    return true;
  }

  const job = await prisma.analysisJob.findUnique({
    where: { id: nextJob.id }
  });

  if (!job) {
    return true;
  }

  try {
    switch (job.type) {
      case "IMPORT_REPOSITORY":
        await handleImportRepositoryJob(job);
        break;
      case "QUICK_SCAN":
        await handleQuickScanJob(job);
        break;
      case "ANALYZE_REPO":
        await handleAnalyzeRepoJob(job);
        break;
      case "ANALYZE_HISTORY":
        await handleAnalyzeHistoryJob(job);
        break;
      case "ANALYZE_FOLDER":
        await handleAnalyzeFolderJob(job);
        break;
      case "ANALYZE_FILE":
        await handleAnalyzeFileJob(job);
        break;
      default:
        throw new Error(`Unsupported job type: ${job.type}`);
    }

    await markJobCompleted(job.id);
  } catch (error) {
    await markJobFailed(job, error);
  }

  await refreshRepositoryState(job.repositoryId);
  return true;
}
