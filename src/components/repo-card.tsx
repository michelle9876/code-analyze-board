import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { ArrowRight, FolderGit2, Sparkles } from "lucide-react";
import type { RepositoryListItem } from "@/lib/contracts";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function statusTone(status: string) {
  if (status === "READY") return "bg-success/10 text-success border-success/20";
  if (status === "FAILED") return "bg-danger/10 text-danger border-danger/20";
  return "bg-accent/10 text-accent border-accent/20";
}

function describeFallbackReason(reason: string | null) {
  switch (reason) {
    case "quota_exceeded":
      return "OpenAI quota 초과";
    case "rate_limited":
      return "OpenAI rate limit";
    case "invalid_api_key":
      return "API key 확인 필요";
    case "missing_api_key":
      return "API key 없음";
    case "structured_output_error":
      return "Structured output parse 실패";
    case "model_refusal":
      return "모델 응답 거절";
    case "api_error":
      return "OpenAI API 오류";
    default:
      return null;
  }
}

export function RepoCard({ repo }: { repo: RepositoryListItem }) {
  const analysisTimestamp = repo.latestAnalysisUpdatedAt || repo.lastAnalyzedAt;
  const providerLabel =
    repo.latestAnalysisProvider === "openai"
      ? "Live AI"
      : repo.latestAnalysisProvider === "fallback"
        ? "Fallback"
        : null;

  return (
    <Link href={`/repos/${repo.id}`}>
      <Card className="group h-full rounded-[2rem] p-5 transition hover:-translate-y-1 hover:shadow-halo">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-slate-500">
              <FolderGit2 className="h-3.5 w-3.5" />
              Repository
            </div>
            <h3 className="text-xl font-semibold text-ink">{repo.name}</h3>
            <p className="text-sm text-slate-600">{repo.owner ? `${repo.owner} · ${repo.canonicalUrl}` : repo.canonicalUrl}</p>
          </div>
          <Badge className={cn("border", statusTone(repo.status))}>{repo.status}</Badge>
        </div>

        <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-200/70">
          <div className="h-full rounded-full bg-gradient-to-r from-accent to-accentWarm" style={{ width: `${repo.importProgress}%` }} />
        </div>

        <p className="mb-5 min-h-[72px] text-sm leading-6 text-slate-700">
          {repo.quickSummary || "Quick scan이 아직 진행 중입니다. worker가 repo를 clone하고 구조를 분석하면 여기 요약이 채워집니다."}
        </p>

        <div className="mb-4 flex flex-wrap gap-2">
          {repo.category ? <Badge style={{ borderColor: repo.category.color, color: repo.category.color }}>{repo.category.name}</Badge> : null}
          {repo.aiSuggestedCategory ? <Badge className="bg-accentSoft">AI: {repo.aiSuggestedCategory}</Badge> : null}
          {providerLabel ? (
            <Badge className={repo.hasLiveAnalysis ? "bg-success/15 text-success" : "bg-slate-200 text-slate-700"}>
              {providerLabel}
            </Badge>
          ) : null}
          {repo.latestAnalysisModel ? <Badge className="bg-white/90">{repo.latestAnalysisModel}</Badge> : null}
          {repo.detectedFrameworks.slice(0, 3).map((framework) => (
            <Badge key={framework}>{framework}</Badge>
          ))}
          {repo.aiTags.slice(0, 3).map((tag) => (
            <Badge key={tag} className="bg-white/90">
              <Sparkles className="mr-1 h-3 w-3" />
              {tag}
            </Badge>
          ))}
        </div>

        {!repo.hasLiveAnalysis && repo.latestAnalysisReason ? (
          <div className="mb-4 text-xs font-medium text-amber-700">
            Fallback reason: {describeFallbackReason(repo.latestAnalysisReason) || repo.latestAnalysisReason}
          </div>
        ) : null}

        <div className="mt-auto flex items-center justify-between text-sm text-slate-500">
          <span>{analysisTimestamp ? `${formatDistanceToNowStrict(new Date(analysisTimestamp))} ago` : "분석 대기 중"}</span>
          <span className="inline-flex items-center gap-1 font-medium text-ink">
            Open board
            <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
          </span>
        </div>
      </Card>
    </Link>
  );
}
