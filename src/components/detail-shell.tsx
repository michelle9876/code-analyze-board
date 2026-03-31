"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, FolderOpen, GitCommitHorizontal, LayoutPanelTop, RefreshCcw, Trash2 } from "lucide-react";
import type { ArtifactEnvelope, CategoryOption, RepositoryListItem, TreeNodePayload } from "@/lib/contracts";
import { AnalysisPanel } from "@/components/analysis-panel";
import { RepoTree } from "@/components/repo-tree";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

function collectPaths(tree: TreeNodePayload[], type: "directory" | "file") {
  return tree.flatMap((node) => [
    ...(node.type === type ? [node.path] : []),
    ...(node.children ? collectPaths(node.children, type) : [])
  ]);
}

function describeFallbackReason(reason?: string | null) {
  switch (reason) {
    case "quota_exceeded":
      return "Gemini quota가 초과되어 fallback 분석으로 전환되었습니다.";
    case "rate_limited":
      return "Gemini rate limit에 걸려 fallback 분석으로 전환되었습니다.";
    case "invalid_api_key":
      return "Gemini API key가 유효하지 않아 fallback 분석으로 전환되었습니다.";
    case "missing_api_key":
      return "Gemini API key가 설정되지 않아 fallback 분석으로 전환되었습니다.";
    case "structured_output_error":
      return "Structured output 파싱 실패로 fallback 분석으로 전환되었습니다.";
    case "model_refusal":
      return "모델이 응답을 거절해 fallback 분석으로 전환되었습니다.";
    case "api_error":
      return "Gemini API 오류로 fallback 분석으로 전환되었습니다.";
    default:
      return null;
  }
}

export function DetailShell({
  initialRepository,
  initialTree,
  initialRepoArtifact,
  initialHistoryArtifact,
  categories
}: {
  initialRepository: RepositoryListItem;
  initialTree: TreeNodePayload[];
  initialRepoArtifact: ArtifactEnvelope | null;
  initialHistoryArtifact: ArtifactEnvelope | null;
  categories: CategoryOption[];
}) {
  const [repository, setRepository] = useState(initialRepository);
  const [tree, setTree] = useState(initialTree);
  const [activeTab, setActiveTab] = useState<"overview" | "folders" | "files" | "history">("overview");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactEnvelope | null>(initialRepoArtifact);
  const [historyArtifact, setHistoryArtifact] = useState<ArtifactEnvelope | null>(initialHistoryArtifact);
  const [pending, setPending] = useState(false);
  const [categoryId, setCategoryId] = useState(repository.category?.id || "");
  const [deleting, setDeleting] = useState(false);
  const requestedPaths = useRef<Set<string>>(new Set());
  const router = useRouter();

  const folderPaths = useMemo(() => collectPaths(tree, "directory"), [tree]);
  const filePaths = useMemo(() => collectPaths(tree, "file"), [tree]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const [repoResponse, treeResponse, historyResponse] = await Promise.all([
        fetch(`/api/repos/${repository.id}`, { cache: "no-store" }),
        fetch(`/api/repos/${repository.id}/tree`, { cache: "no-store" }),
        fetch(`/api/repos/${repository.id}/analysis?scope=history`, { cache: "no-store" })
      ]);

      if (repoResponse.ok) {
        const repoPayload = (await repoResponse.json()) as { repository: RepositoryListItem };
        setRepository(repoPayload.repository);
      }

      if (treeResponse.ok) {
        const treePayload = (await treeResponse.json()) as { tree: TreeNodePayload[] };
        setTree(treePayload.tree);
      }

      if (historyResponse.ok) {
        const historyPayload = (await historyResponse.json()) as { artifact: ArtifactEnvelope | null };
        setHistoryArtifact(historyPayload.artifact);
      }
    }, 4000);

    return () => window.clearInterval(timer);
  }, [repository.id]);

  useEffect(() => {
    if (activeTab === "folders" && !selectedPath && folderPaths[0]) {
      setSelectedPath(folderPaths[0]);
    }
    if (activeTab === "files" && !selectedPath && filePaths[0]) {
      setSelectedPath(filePaths[0]);
    }
  }, [activeTab, selectedPath, folderPaths, filePaths]);

  useEffect(() => {
    async function loadArtifact() {
      const scope = activeTab === "overview" ? "repo" : activeTab === "folders" ? "folder" : activeTab === "files" ? "file" : "history";
      const needsPath = scope === "folder" || scope === "file";
      const targetPath = needsPath ? selectedPath : null;
      if (needsPath && !targetPath) {
        return;
      }

      const url = new URL(`/api/repos/${repository.id}/analysis`, window.location.origin);
      url.searchParams.set("scope", scope);
      if (targetPath) {
        url.searchParams.set("path", targetPath);
      }

      const response = await fetch(url.toString(), { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { artifact: ArtifactEnvelope | null; pending: boolean };
      setPending(payload.pending);
      setArtifact(payload.artifact);
      if (scope === "history") {
        setHistoryArtifact(payload.artifact);
      }

      if (needsPath && targetPath) {
        const requestKey = `${scope}:${targetPath}`;

        if (payload.artifact) {
          requestedPaths.current.delete(requestKey);
          return;
        }

        if (!payload.pending && !requestedPaths.current.has(requestKey)) {
          requestedPaths.current.add(requestKey);
          setPending(true);

          const reanalyzeResponse = await fetch(`/api/repos/${repository.id}/reanalyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scope,
              path: targetPath
            })
          });

          if (!reanalyzeResponse.ok) {
            requestedPaths.current.delete(requestKey);
            setPending(false);
          }
        }
      }
    }

    void loadArtifact();
  }, [activeTab, selectedPath, repository.id]);

  async function handleReanalyze() {
    const scope = activeTab === "overview" ? "repo" : activeTab === "folders" ? "folder" : activeTab === "files" ? "file" : "history";
    await fetch(`/api/repos/${repository.id}/reanalyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        path: scope === "folder" || scope === "file" ? selectedPath : undefined
      })
    });
    setPending(true);
  }

  async function handleCategoryChange(nextCategoryId: string) {
    setCategoryId(nextCategoryId);
    const response = await fetch(`/api/repos/${repository.id}/category`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId: nextCategoryId || null })
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { repository: RepositoryListItem };
    setRepository(payload.repository);
  }

  async function handleDeleteRepository() {
    const confirmed = window.confirm(`"${repository.name}" repository를 삭제할까요?`);

    if (!confirmed) {
      return;
    }

    const deleteLocalClone = window.confirm("로컬 clone 폴더도 같이 삭제할까요?\n확인을 누르면 디스크까지 삭제하고, 취소를 누르면 board에서만 제거합니다.");

    setDeleting(true);

    try {
      const response = await fetch(`/api/repos/${repository.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deleteLocalClone
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Repository delete failed.");
      }

      router.push("/");
      router.refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Repository delete failed.");
      setDeleting(false);
    }
  }

  function handleTreeSelect(node: TreeNodePayload) {
    setSelectedPath(node.path);
    setActiveTab(node.type === "directory" ? "folders" : "files");
  }

  const panelScope = activeTab === "overview" ? "repo" : activeTab === "folders" ? "folder" : activeTab === "files" ? "file" : "history";
  const currentMetadata = artifact?.metadata;
  const currentProvider = currentMetadata?.provider || repository.latestAnalysisProvider || "fallback";
  const currentModel = artifact?.model || repository.latestAnalysisModel || "pending";
  const currentPromptVersion = currentMetadata?.promptVersion || "legacy";
  const currentCommit = artifact?.commitSha || repository.headCommitSha || "pending";
  const currentUpdatedAt = artifact?.updatedAt || repository.latestAnalysisUpdatedAt || repository.lastAnalyzedAt;
  const currentCoverageMode = currentMetadata?.coverageMode || (panelScope === "folder" || panelScope === "file" ? "on-demand" : "precomputed");
  const currentFallbackReason = currentMetadata?.fallbackReason || repository.latestAnalysisReason;
  const currentFallbackMessage = currentMetadata?.fallbackMessage || repository.latestAnalysisMessage;

  return (
    <main className="mx-auto max-w-[1500px] px-6 py-8 md:px-8">
      <section className="mb-6 grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)_340px]">
        <Card className="rounded-[2rem] p-5 xl:sticky xl:top-6 xl:h-fit">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <FolderOpen className="h-4 w-4 text-accent" />
            Repository tree
          </div>
          <RepoTree tree={tree} selectedPath={selectedPath} onSelect={handleTreeSelect} />
        </Card>

        <div className="space-y-5">
          {!repository.hasLiveAnalysis && repository.latestAnalysisReason ? (
            <Card className="rounded-[2rem] border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
              <div className="font-semibold">Fallback analysis active</div>
              <div className="mt-1">{describeFallbackReason(repository.latestAnalysisReason)}</div>
              {repository.latestAnalysisMessage ? <div className="mt-2 text-xs text-amber-700/90">{repository.latestAnalysisMessage}</div> : null}
            </Card>
          ) : null}

          <Card className="rounded-[2rem] p-6">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="mb-2 text-xs uppercase tracking-[0.24em] text-slate-500">Deep analysis board</div>
                <h1 className="text-3xl font-semibold text-ink">{repository.name}</h1>
                <p className="mt-2 text-sm text-slate-600">{repository.canonicalUrl}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={handleReanalyze}>
                  <RefreshCcw className="mr-2 h-4 w-4" />
                  Reanalyze
                </Button>
                <Button variant="danger" onClick={handleDeleteRepository} disabled={deleting}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  {deleting ? "Deleting..." : "Delete"}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {([
                ["overview", "Overview"],
                ["folders", "Folders"],
                ["files", "Files"],
                ["history", "History"]
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setActiveTab(value)}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${activeTab === value ? "bg-accent text-white" : "border border-line bg-white/80 text-ink"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Card>

          <AnalysisPanel artifact={artifact} pending={pending} scope={panelScope} />
        </div>

        <div className="space-y-5 xl:sticky xl:top-6 xl:h-fit">
          <Card className="rounded-[2rem] p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
              <LayoutPanelTop className="h-4 w-4 text-accent" />
              Repo meta
            </div>
            <div className="space-y-3 text-sm text-slate-700">
              <div className="flex flex-wrap gap-2">
                <Badge>{repository.status}</Badge>
                {repository.category ? <Badge style={{ borderColor: repository.category.color, color: repository.category.color }}>{repository.category.name}</Badge> : null}
                <Badge className={repository.hasLiveAnalysis ? "bg-success/15 text-success" : "bg-slate-200 text-slate-700"}>
                  {repository.hasLiveAnalysis ? "Live AI" : "Fallback"}
                </Badge>
                {repository.latestAnalysisModel ? <Badge>{repository.latestAnalysisModel}</Badge> : null}
              </div>
              <p>{repository.quickSummary || "Quick summary가 아직 준비되지 않았습니다."}</p>
              {!repository.hasLiveAnalysis && repository.latestAnalysisReason ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
                  {describeFallbackReason(repository.latestAnalysisReason)}
                  {repository.latestAnalysisMessage ? <div className="mt-1 text-amber-700/90">{repository.latestAnalysisMessage}</div> : null}
                </div>
              ) : null}
              <div className="h-2 overflow-hidden rounded-full bg-slate-200/70">
                <div className="h-full rounded-full bg-gradient-to-r from-accent to-accentWarm" style={{ width: `${repository.importProgress}%` }} />
              </div>
              <label className="block text-xs uppercase tracking-[0.2em] text-slate-500">Category</label>
              <select
                value={categoryId}
                onChange={(event) => void handleCategoryChange(event.target.value)}
                className="h-11 w-full rounded-2xl border border-line bg-white/85 px-4"
              >
                <option value="">카테고리 없음</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap gap-2">
                {repository.detectedFrameworks.map((framework) => (
                  <Badge key={framework}>{framework}</Badge>
                ))}
                {repository.aiTags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            </div>
          </Card>

          <Card className="rounded-[2rem] p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
              <Activity className="h-4 w-4 text-accentWarm" />
              Current focus
            </div>
            <div className="space-y-2 text-sm text-slate-700">
              <div>Tab: <strong>{activeTab}</strong></div>
              <div>Path: <strong>{selectedPath || "root"}</strong></div>
              <div>Provider: <strong>{currentProvider === "fallback" ? "Fallback" : "Live AI"}</strong></div>
              <div>Model: <strong>{currentModel}</strong></div>
              <div>Prompt version: <strong>{currentPromptVersion}</strong></div>
              <div>Coverage: <strong>{currentCoverageMode}</strong></div>
              <div>Commit: <strong>{currentCommit.slice(0, 8)}</strong></div>
              <div>Last analyzed: <strong>{currentUpdatedAt ? new Date(currentUpdatedAt).toLocaleString("ko-KR") : "pending"}</strong></div>
              {!repository.hasLiveAnalysis && currentFallbackReason ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
                  {describeFallbackReason(currentFallbackReason)}
                  {currentFallbackMessage ? <div className="mt-1 text-amber-700/90">{currentFallbackMessage}</div> : null}
                </div>
              ) : null}
            </div>
          </Card>

          <Card className="rounded-[2rem] p-6">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
              <GitCommitHorizontal className="h-4 w-4 text-accent" />
              Recent history glance
            </div>
            <div className="space-y-3">
              {historyArtifact?.data && Array.isArray((historyArtifact.data as any).recentCommits) ? (
                (historyArtifact.data as any).recentCommits.slice(0, 4).map((commit: any) => (
                  <div key={commit.sha} className="rounded-[1.25rem] border border-line bg-white/75 p-4 text-sm">
                    <div className="mb-1 font-medium text-ink">{commit.message}</div>
                    <div className="text-xs text-slate-500">{commit.sha.slice(0, 8)} · {commit.date}</div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-slate-600">history summary가 생성되면 최근 변화가 여기에 표시됩니다.</div>
              )}
            </div>
          </Card>
        </div>
      </section>
    </main>
  );
}
