"use client";

import { useEffect, useMemo, useState } from "react";
import { Layers3, LoaderCircle, Plus, Search } from "lucide-react";
import type { CategoryOption, RepositoryListItem } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { RepoCard } from "@/components/repo-card";

function describeGlobalFallback(reason: string) {
  switch (reason) {
    case "quota_exceeded":
      return "OpenAI quota가 초과되어 현재는 fallback 분석으로 동작 중입니다.";
    case "rate_limited":
      return "OpenAI rate limit으로 인해 일부 분석이 fallback으로 전환되었습니다.";
    case "invalid_api_key":
      return "OpenAI API key 문제로 fallback 분석이 사용되고 있습니다.";
    case "missing_api_key":
      return "OpenAI API key가 설정되지 않아 fallback 분석이 사용되고 있습니다.";
    default:
      return "OpenAI 분석 경로에 문제가 있어 fallback 분석이 사용되고 있습니다.";
  }
}

export function BoardShell({
  initialRepositories,
  categories
}: {
  initialRepositories: RepositoryListItem[];
  categories: CategoryOption[];
}) {
  const [repositories, setRepositories] = useState(initialRepositories);
  const [url, setUrl] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const response = await fetch("/api/repos", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { repositories: RepositoryListItem[] };
      setRepositories(data.repositories);
    }, 3000);

    return () => window.clearInterval(timer);
  }, []);

  const filtered = useMemo(() => {
    const byCategory =
      activeCategory === "all"
        ? repositories
        : repositories.filter((repo) => repo.category?.id === activeCategory);

    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return byCategory;
    }

    return byCategory.filter((repo) =>
      [
        repo.name,
        repo.owner,
        repo.url,
        repo.quickSummary,
        repo.architectureOverview,
        ...repo.aiTags,
        ...repo.detectedLanguages,
        ...repo.detectedFrameworks
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword))
    );
  }, [activeCategory, query, repositories]);

  const fallbackSummary = useMemo(() => {
    const affected = repositories.filter((repo) => !repo.hasLiveAnalysis && repo.latestAnalysisReason);
    if (affected.length === 0) {
      return null;
    }

    const [first] = affected;
    return {
      count: affected.length,
      message: describeGlobalFallback(first.latestAnalysisReason || "api_error"),
      detail: first.latestAnalysisMessage
    };
  }, [repositories]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/repos/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          categoryId: categoryId || null
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Import failed.");
      }

      setUrl("");
      const refresh = await fetch("/api/repos", { cache: "no-store" });
      if (refresh.ok) {
        const payload = (await refresh.json()) as { repositories: RepositoryListItem[] };
        setRepositories(payload.repositories);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Import failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-8 md:px-8">
      <section className="mb-8 grid gap-6 lg:grid-cols-[1.35fr_0.9fr]">
        <Card className="grid-faint rounded-[2.5rem] p-8 lg:p-10">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-white/70 px-3 py-1 text-xs uppercase tracking-[0.26em] text-slate-600">
            <Layers3 className="h-3.5 w-3.5" />
            Code Analysis View Board
          </div>
          <h1 className="max-w-3xl text-4xl font-semibold leading-tight text-ink md:text-5xl">
            GitHub repo를 clone하고, architecture와 code flow를 board에서 바로 읽는 분석 워크벤치.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-8 text-slate-700 md:text-lg">
            repo, folder, file, recent history를 한눈에 정리합니다. quick scan은 빠르게, deep analysis는 worker가 백그라운드에서 계속 채워주는 hybrid UX로 설계했습니다.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Badge>Responses API</Badge>
            <Badge>Structured Outputs</Badge>
            <Badge>React Flow</Badge>
            <Badge>Prisma + SQLite</Badge>
            <Badge>Shiki source preview</Badge>
          </div>
        </Card>

        <Card className="rounded-[2.5rem] p-6 md:p-8">
          <div className="mb-5 text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Import repository</div>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <Input
              placeholder="https://github.com/owner/repo"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
            <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">카테고리 없음</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
            {error ? <div className="rounded-2xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div> : null}
            <Button className="w-full" size="lg" disabled={submitting}>
              {submitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Import and analyze
            </Button>
          </form>
        </Card>
      </section>

      <section className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setActiveCategory("all")}
          className={`rounded-full px-4 py-2 text-sm font-medium transition ${activeCategory === "all" ? "bg-accent text-white" : "border border-line bg-white/75 text-ink"}`}
        >
          All ({repositories.length})
        </button>
        {categories.map((category) => (
          <button
            key={category.id}
            type="button"
            onClick={() => setActiveCategory(category.id)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${activeCategory === category.id ? "text-white" : "border border-line bg-white/75 text-ink"}`}
            style={activeCategory === category.id ? { backgroundColor: category.color } : undefined}
          >
            {category.name}
          </button>
        ))}
      </section>

      {fallbackSummary ? (
        <section className="mb-6">
          <Card className="rounded-[2rem] border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            <div className="font-semibold">Fallback analysis active</div>
            <div className="mt-1">{fallbackSummary.message}</div>
            <div className="mt-1 text-amber-800/90">{fallbackSummary.count}개 repository가 현재 fallback 결과를 표시하고 있습니다.</div>
            {fallbackSummary.detail ? <div className="mt-2 text-xs text-amber-700/90">{fallbackSummary.detail}</div> : null}
          </Card>
        </section>
      ) : null}

      <section className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-ink">Tracked repositories</h2>
          <p className="text-sm text-slate-600">board에서 repo별 quick summary, tags, progress, architecture 상태를 관리합니다.</p>
        </div>
        <div className="flex w-full flex-col gap-3 lg:w-auto lg:min-w-[420px] lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              className="pl-11"
              placeholder="repo 이름, owner, tag, language로 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-line bg-white/80 px-4 py-2 text-sm text-slate-600">
            <Search className="h-4 w-4" />
            {filtered.length} repositories visible
          </div>
        </div>
      </section>

      <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((repo) => (
          <RepoCard key={repo.id} repo={repo} />
        ))}
        {filtered.length === 0 ? (
          <Card className="rounded-[2rem] p-8 text-sm text-slate-600">현재 필터에 해당하는 repository가 없습니다.</Card>
        ) : null}
      </section>
    </main>
  );
}
