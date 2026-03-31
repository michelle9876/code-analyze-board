import { notFound } from "next/navigation";
import { DetailShell } from "@/components/detail-shell";
import { getReadyAndPendingPaths, getCategories, getLatestArtifact, getRepositoryById, serializeArtifact, serializeRepository } from "@/lib/queries";
import { buildRepositorySnapshot, createTreePayload } from "@/lib/repository";

export const dynamic = "force-dynamic";

type RepoDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function RepoDetailPage({ params }: RepoDetailPageProps) {
  const { id } = await params;
  const [repository, categories] = await Promise.all([
    getRepositoryById(id),
    getCategories()
  ]);

  if (!repository) {
    notFound();
  }

  const [repoArtifact, historyArtifact] = await Promise.all([
    getLatestArtifact(repository.id, "REPO", "", repository.headCommitSha),
    getLatestArtifact(repository.id, "HISTORY", "", repository.headCommitSha)
  ]);

  let initialTree: ReturnType<typeof createTreePayload> = [];

  try {
    const snapshot = await buildRepositorySnapshot(repository.clonePath);
    const { ready, pending } = await getReadyAndPendingPaths(repository.id, repository.headCommitSha);
    initialTree = createTreePayload(snapshot.tree, ready, pending);
  } catch {
    initialTree = [];
  }

  return (
    <DetailShell
      initialRepository={serializeRepository(repository)}
      initialTree={initialTree}
      initialRepoArtifact={repoArtifact ? serializeArtifact(repoArtifact) : null}
      initialHistoryArtifact={historyArtifact ? serializeArtifact(historyArtifact) : null}
      categories={categories}
    />
  );
}
