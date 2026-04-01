import dynamic from "next/dynamic";
import { ArrowDownToLine, CalendarClock, FolderTree, GitCommitHorizontal, Lightbulb, Network, Route, ShieldAlert, Sparkles } from "lucide-react";
import type { AnyArtifactData, ArtifactEnvelope } from "@/lib/contracts";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

const GraphView = dynamic(() => import("@/components/graph-view"), {
  ssr: false,
  loading: () => <div className="h-[420px] animate-pulse rounded-[1.5rem] border border-line bg-white/60" />
});

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2 text-sm leading-6 text-slate-700">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span className="mt-2 h-1.5 w-1.5 rounded-full bg-accent" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function PathList({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge key={item} className="bg-white text-ink">
          {item}
        </Badge>
      ))}
    </div>
  );
}

export function AnalysisPanel({
  artifact,
  pending,
  scope
}: {
  artifact: ArtifactEnvelope<AnyArtifactData> | null;
  pending: boolean;
  scope: "repo" | "folder" | "file" | "history";
}) {
  if (!artifact && pending) {
    return <Card className="rounded-[2rem] p-6 text-sm text-slate-600">분석 job이 enqueue되었습니다. worker가 결과를 생성하면 여기에 업데이트됩니다.</Card>;
  }

  if (!artifact) {
    return <Card className="rounded-[2rem] p-6 text-sm text-slate-600">아직 분석 결과가 없습니다.</Card>;
  }

  const data: any = artifact.data;
  const updatedAt = new Date(artifact.updatedAt).toLocaleString("ko-KR");
  const stackItems = Array.isArray(data.stack) ? data.stack : [];
  const readingOrder = [...(Array.isArray(data.recommendedReadingOrder) ? data.recommendedReadingOrder : []), ...(Array.isArray(data.readingOrder) ? data.readingOrder : [])];
  const entrypoints = Array.isArray(data.entrypoints) ? data.entrypoints : [];
  const logicFlows = Array.isArray(data.logicFlows) ? data.logicFlows : [];
  const primaryPipelines = logicFlows.slice(0, 2);
  const secondaryPipelines = logicFlows.slice(2, 4);
  const heroPipeline = scope === "repo" ? primaryPipelines[0] || logicFlows[0] || null : null;
  const heroEntrypoint = scope === "repo" ? entrypoints[0] || null : null;
  const evidenceCards = Array.isArray(data.evidenceCards) ? data.evidenceCards : [];
  const declaredSymbols = Array.isArray(data.declaredSymbols) ? data.declaredSymbols : [];
  const callers = Array.isArray(data.callers) ? data.callers : [];
  const callees = Array.isArray(data.callees) ? data.callees : [];
  const callSequence = Array.isArray(data.callSequence) ? data.callSequence : [];
  const moduleGraphSummary = data.moduleGraphSummary && typeof data.moduleGraphSummary === "object" ? data.moduleGraphSummary : null;
  const executionRole = typeof data.frameworkRole === "string" ? data.frameworkRole : typeof data.architectureRole === "string" ? data.architectureRole : null;
  const dependencyUp = Array.isArray(data.upstreamDependencies) ? data.upstreamDependencies : Array.isArray(data.inboundDependencies) ? data.inboundDependencies : [];
  const dependencyDown = Array.isArray(data.downstreamDependencies) ? data.downstreamDependencies : Array.isArray(data.outboundDependencies) ? data.outboundDependencies : [];
  const designTradeoffs = Array.isArray(data.designTradeoffs) ? data.designTradeoffs : [];
  const keySymbols = Array.isArray(data.keySymbols) ? data.keySymbols : [];
  const miniFlowCards =
    scope === "file"
      ? [
          callers[0]
            ? {
                title: "Entry trigger",
                detail: callers[0],
                note: "이 파일의 실행이 어디서 시작되는지 보여줍니다."
              }
            : callSequence[0]
              ? {
                  title: "Entry trigger",
                  detail: callSequence[0],
                  note: "이 파일이 실행 흐름에 들어오는 첫 지점입니다."
                }
              : null,
          keySymbols[0] || declaredSymbols[0]
            ? {
                title: `Key symbol: ${(keySymbols[0]?.name || declaredSymbols[0]?.name) as string}`,
                detail: callSequence[1] || keySymbols[0]?.role || declaredSymbols[0]?.kind || "핵심 심볼부터 파일 책임을 따라갈 수 있습니다.",
                note: "먼저 읽어야 할 함수나 심볼을 가리킵니다."
              }
            : null,
          callees[0]
            ? {
                title: "Core handoff",
                detail: callees[0],
                note: "이 파일이 다음 단계로 어떤 함수나 경계에 일을 넘기는지 보여줍니다."
              }
            : callSequence[2]
              ? {
                  title: "Core handoff",
                  detail: callSequence[2],
                  note: "실행이 다음 단계로 넘어가는 핵심 연결입니다."
                }
              : null,
          callees[1] || data.dependencyNotes?.[0] || callSequence[3]
            ? {
                title: "Boundary / outcome",
                detail: (callees[1] || data.dependencyNotes?.[0] || callSequence[3]) as string,
                note: "외부 API, 데이터 계층, 설정 경계로 이어지는 마지막 단서를 보여줍니다."
              }
            : null
        ].filter(Boolean)
      : [];
  const importantPaths = [
    ...(Array.isArray(data.importantChildren) ? data.importantChildren.map((item: any) => item.path) : []),
    ...(Array.isArray(data.relatedFiles) ? data.relatedFiles : []),
    ...(Array.isArray(data.majorSubsystems) ? data.majorSubsystems.flatMap((item: any) => item.importantPaths || []) : []),
    ...((Array.isArray(data.pathHighlights) ? data.pathHighlights : []).map((item: any) => item.path).filter(Boolean))
  ];

  return (
    <div className="space-y-5">
      <Card className="rounded-[2rem] p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Badge className="bg-accentSoft uppercase tracking-[0.2em]">{scope}</Badge>
          <Badge>{artifact.model}</Badge>
          {artifact.path ? <Badge>{artifact.path}</Badge> : null}
          <Badge>{artifact.commitSha.slice(0, 8)}</Badge>
        </div>
        <h2 className="mb-3 text-2xl font-semibold text-ink">{data.summary || artifact.summary}</h2>
        {data.architectureOverview ? <p className="text-sm leading-7 text-slate-700">{data.architectureOverview}</p> : null}
        {data.responsibility ? <p className="text-sm leading-7 text-slate-700">{data.responsibility}</p> : null}
        {data.purpose ? <p className="text-sm leading-7 text-slate-700">{data.purpose}</p> : null}
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-[1.25rem] border border-line bg-white/75 p-4">
            <div className="mb-1 text-xs uppercase tracking-[0.2em] text-slate-500">Status</div>
            <div className="text-sm font-medium text-ink">{artifact.status}</div>
          </div>
          <div className="rounded-[1.25rem] border border-line bg-white/75 p-4">
            <div className="mb-1 text-xs uppercase tracking-[0.2em] text-slate-500">Updated</div>
            <div className="text-sm font-medium text-ink">{updatedAt}</div>
          </div>
          <div className="rounded-[1.25rem] border border-line bg-white/75 p-4">
            <div className="mb-1 text-xs uppercase tracking-[0.2em] text-slate-500">Model</div>
            <div className="text-sm font-medium text-ink">{artifact.model}</div>
          </div>
          <div className="rounded-[1.25rem] border border-line bg-white/75 p-4">
            <div className="mb-1 text-xs uppercase tracking-[0.2em] text-slate-500">Commit</div>
            <div className="truncate text-sm font-medium text-ink">{artifact.commitSha.slice(0, 12)}</div>
          </div>
        </div>
      </Card>

      {heroPipeline ? (
        <Card className="overflow-hidden rounded-[2rem] border border-sky-200/80 bg-[radial-gradient(circle_at_top_left,rgba(224,242,254,0.95),rgba(255,255,255,0.98)_52%),linear-gradient(135deg,rgba(255,255,255,0.98),rgba(240,249,255,0.94))] p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 inline-flex rounded-full border border-sky-200 bg-white/80 px-3 py-1 text-[10px] font-semibold tracking-[0.18em] text-sky-700">
                PRIMARY PIPELINE
              </div>
              <div className="text-xl font-semibold tracking-tight text-slate-900">{heroPipeline.title}</div>
            </div>
            {heroEntrypoint ? (
              <div className="rounded-[1.25rem] border border-white/80 bg-white/75 px-4 py-3 text-right shadow-[0_12px_24px_rgba(14,116,144,0.08)]">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Lead entrypoint</div>
                <div className="mt-1 text-sm font-medium text-slate-900">{heroEntrypoint.path}</div>
                {heroEntrypoint.symbol ? <div className="mt-1 text-xs text-slate-600">{heroEntrypoint.symbol}</div> : null}
              </div>
            ) : null}
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {heroPipeline.steps.map((step: string, index: number) => (
              <div key={`${heroPipeline.title}-${index}`} className="rounded-[1.25rem] border border-white/80 bg-white/85 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
                <div className="mb-2 inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold tracking-[0.16em] text-slate-500">
                  STEP {index + 1}
                </div>
                <div className="text-sm font-medium leading-6 text-slate-900">{step}</div>
              </div>
            ))}
          </div>
          {heroEntrypoint?.why ? <p className="mt-5 text-sm leading-7 text-slate-700">{heroEntrypoint.why}</p> : null}
        </Card>
      ) : null}

      {stackItems.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Sparkles className="h-4 w-4 text-accentWarm" />
            Tech stack and roles
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {stackItems.map((item: any) => (
              <div key={item.name} className="rounded-[1.25rem] border border-line bg-white/75 p-4">
                <div className="mb-1 font-medium text-ink">{item.name}</div>
                <p className="text-sm text-slate-700">{item.role}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {entrypoints.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Route className="h-4 w-4 text-accent" />
            Entry points
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {entrypoints.map((item: any) => (
              <div key={`${item.path}-${item.kind}`} className="rounded-[1.25rem] border border-line bg-white/75 p-4">
                <div className="mb-1 font-medium text-ink">{item.path}</div>
                <div className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">{item.kind}</div>
                <p className="text-sm text-slate-700">{item.why}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {data.majorSubsystems?.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Route className="h-4 w-4 text-accent" />
            Major subsystems
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {data.majorSubsystems.map((item: any) => (
              <div key={item.name} className="rounded-[1.25rem] border border-line bg-white/75 p-4">
                <div className="mb-1 font-medium text-ink">{item.name}</div>
                <p className="text-sm text-slate-700">{item.responsibility}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {logicFlows.length || data.keyFlows?.length || data.controlFlow?.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Route className="h-4 w-4 text-accentWarm" />
            Flow understanding
          </div>
          {logicFlows.length ? (
            <div className="space-y-4">
              {primaryPipelines.length ? (
                <div className="space-y-3">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Primary pipeline</div>
                  {primaryPipelines.map((flow: any) => (
                    <div key={flow.title} className="rounded-[1.25rem] border border-sky-200/70 bg-sky-50/70 p-4">
                      <div className="mb-2 font-medium text-ink">{flow.title}</div>
                      <BulletList items={flow.steps} />
                    </div>
                  ))}
                </div>
              ) : null}
              {secondaryPipelines.length ? (
                <div className="space-y-3">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Secondary pipeline</div>
                  {secondaryPipelines.map((flow: any) => (
                    <div key={flow.title} className="rounded-[1.25rem] border border-line bg-white/70 p-4">
                      <div className="mb-2 font-medium text-ink">{flow.title}</div>
                      <BulletList items={flow.steps} />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : data.keyFlows?.length ? (
            <div className="space-y-4">
              {data.keyFlows.map((flow: any) => (
                <div key={flow.title} className="rounded-[1.25rem] border border-line bg-white/70 p-4">
                  <div className="mb-2 font-medium text-ink">{flow.title}</div>
                  <BulletList items={flow.steps} />
                </div>
              ))}
            </div>
          ) : null}
          {data.controlFlow?.length ? <BulletList items={data.controlFlow} /> : null}
        </Card>
      ) : null}

      {moduleGraphSummary ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Network className="h-4 w-4 text-accent" />
            Why this repo is structured this way
          </div>
          <p className="text-sm leading-7 text-slate-700">{moduleGraphSummary.summary}</p>
          <div className="mt-5 grid gap-5 md:grid-cols-3">
            {moduleGraphSummary.highFanOutModules?.length ? (
              <div>
                <div className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-500">High fan-out modules</div>
                <BulletList items={moduleGraphSummary.highFanOutModules} />
              </div>
            ) : null}
            {moduleGraphSummary.externalSystems?.length ? (
              <div>
                <div className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-500">External systems</div>
                <BulletList items={moduleGraphSummary.externalSystems} />
              </div>
            ) : null}
            {moduleGraphSummary.configSurfaces?.length ? (
              <div>
                <div className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-500">Config surfaces</div>
                <BulletList items={moduleGraphSummary.configSurfaces} />
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {readingOrder.length || data.readingChecklist?.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <FolderTree className="h-4 w-4 text-accentWarm" />
            Recommended reading order
          </div>
          {readingOrder.length ? (
            <div className="space-y-3">
              {readingOrder.map((item: any) => (
                <div key={`${item.path}-${item.why}`} className="rounded-[1.25rem] border border-line bg-white/75 p-4 text-sm">
                  <div className="mb-1 font-medium text-ink">{item.path}</div>
                  <p className="text-slate-700">{item.why}</p>
                </div>
              ))}
            </div>
          ) : null}
          {data.readingChecklist?.length ? <div className={readingOrder.length ? "mt-5" : ""}><BulletList items={data.readingChecklist} /></div> : null}
        </Card>
      ) : null}

      {importantPaths.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <FolderTree className="h-4 w-4 text-accent" />
            Important paths to inspect next
          </div>
          <PathList items={[...new Set(importantPaths)]} />
        </Card>
      ) : null}

      {dependencyUp.length || dependencyDown.length || data.dependencyNotes?.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Network className="h-4 w-4 text-accentWarm" />
            Dependency directions
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            {dependencyUp.length ? (
              <div>
                <div className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-500">Upstream</div>
                <BulletList items={dependencyUp} />
              </div>
            ) : null}
            {dependencyDown.length ? (
              <div>
                <div className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-500">Downstream</div>
                <BulletList items={dependencyDown} />
              </div>
            ) : null}
          </div>
          {data.dependencyNotes?.length ? <div className="mt-5"><BulletList items={data.dependencyNotes} /></div> : null}
        </Card>
      ) : null}

      {executionRole || callers.length || callees.length || declaredSymbols.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Network className="h-4 w-4 text-accentWarm" />
            Execution role
          </div>
          {executionRole ? <p className="mb-5 text-sm leading-7 text-slate-700">{executionRole}</p> : null}
          <div className="grid gap-5 md:grid-cols-2">
            {callers.length ? (
              <div>
                <div className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-500">Called by</div>
                <BulletList items={callers} />
              </div>
            ) : null}
            {callees.length ? (
              <div>
                <div className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-500">Calls out</div>
                <BulletList items={callees} />
              </div>
            ) : null}
          </div>
          {declaredSymbols.length ? (
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {declaredSymbols.map((symbol: any) => (
                <div key={`${symbol.kind}-${symbol.name}`} className="rounded-[1.25rem] border border-line bg-white/75 p-4">
                  <div className="mb-1 font-medium text-ink">{symbol.name}</div>
                  <p className="text-sm text-slate-700">{symbol.kind}</p>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      {miniFlowCards.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Route className="h-4 w-4 text-accentWarm" />
            Key function mini flow
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {miniFlowCards.map((item: any, index: number) => (
              <div key={`${item.title}-${index}`} className="rounded-[1.25rem] border border-line bg-white/75 p-4">
                <div className="mb-2 inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold tracking-[0.16em] text-slate-500">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div className="mb-2 font-medium text-ink">{item.title}</div>
                <p className="mb-2 text-sm leading-7 text-slate-700">{item.detail}</p>
                <p className="text-xs leading-6 text-slate-500">{item.note}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {artifact.metadata && typeof artifact.metadata.sourcePreviewHtml === "string" ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <ArrowDownToLine className="h-4 w-4 text-accent" />
            Source preview
          </div>
          <div dangerouslySetInnerHTML={{ __html: artifact.metadata.sourcePreviewHtml }} />
        </Card>
      ) : null}

      {evidenceCards.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Lightbulb className="h-4 w-4 text-warning" />
            Evidence cards
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {evidenceCards.map((item: any, index: number) => (
              <div key={`${item.path}-${item.symbol || index}`} className="rounded-[1.25rem] border border-line bg-white/75 p-4">
                <div className="mb-1 font-medium text-ink">{item.title}</div>
                <div className="mb-1 text-xs uppercase tracking-[0.18em] text-slate-500">{item.kind}</div>
                <div className="mb-2 text-sm text-slate-700">{item.path}{item.symbol ? ` · ${item.symbol}` : ""}</div>
                <p className="text-sm leading-6 text-slate-700">{item.evidence}</p>
                <p className="mt-2 text-sm leading-6 text-slate-700"><strong>Why it matters:</strong> {item.whyItMatters}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {data.diagram?.nodes?.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 text-sm font-medium text-ink">Architecture visualization</div>
          <GraphView graph={data.diagram} />
        </Card>
      ) : null}

      {artifact.mermaidText ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 text-sm font-medium text-ink">Mermaid export</div>
          <pre className="overflow-x-auto rounded-[1.25rem] border border-line bg-white/80 p-4 text-xs leading-6 text-slate-700">{artifact.mermaidText}</pre>
        </Card>
      ) : null}

      {data.technicalPoints?.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Lightbulb className="h-4 w-4 text-warning" />
            Technical points
          </div>
          <BulletList items={data.technicalPoints} />
        </Card>
      ) : null}

      {data.developerNotes?.length || data.patterns?.length || data.concepts?.length || data.crossCuttingConcerns?.length || data.callSequence?.length || keySymbols.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 text-sm font-medium text-ink">Developer understanding</div>
          <div className="grid gap-5 md:grid-cols-2">
            {data.developerNotes?.length ? <BulletList items={data.developerNotes} /> : null}
            {data.patterns?.length ? <BulletList items={data.patterns} /> : null}
            {data.concepts?.length ? <BulletList items={data.concepts} /> : null}
            {data.inputsOutputs?.length ? <BulletList items={data.inputsOutputs} /> : null}
            {data.crossCuttingConcerns?.length ? <BulletList items={data.crossCuttingConcerns} /> : null}
            {data.callSequence?.length ? <BulletList items={data.callSequence} /> : null}
          </div>
          {keySymbols.length ? (
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {keySymbols.map((symbol: any) => (
                <div key={symbol.name} className="rounded-[1.25rem] border border-line bg-white/75 p-4">
                  <div className="mb-1 font-medium text-ink">{symbol.name}</div>
                  <p className="text-sm text-slate-700">{symbol.role}</p>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      {designTradeoffs.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <Sparkles className="h-4 w-4 text-accent" />
            Design tradeoffs
          </div>
          <div className="space-y-3">
            {designTradeoffs.map((item: any) => (
              <div key={item.decision} className="rounded-[1.25rem] border border-line bg-white/75 p-4 text-sm">
                <div className="mb-1 font-medium text-ink">{item.decision}</div>
                <p className="text-slate-700"><strong>Why:</strong> {item.rationale}</p>
                <p className="mt-2 text-slate-700"><strong>Cost:</strong> {item.downside}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {data.risks?.length || data.considerations?.length || data.pitfalls?.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <ShieldAlert className="h-4 w-4 text-danger" />
            Risks and considerations
          </div>
          <BulletList items={[...(data.risks || []), ...(data.considerations || []), ...(data.pitfalls || [])]} />
        </Card>
      ) : null}

      {data.recentCommits?.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <GitCommitHorizontal className="h-4 w-4 text-accent" />
            Recent history
          </div>
          <div className="space-y-3">
            {data.recentCommits.map((commit: any) => (
              <div key={commit.sha} className="rounded-[1.25rem] border border-line bg-white/75 p-4 text-sm">
                <div className="mb-1 font-medium text-ink">{commit.message}</div>
                <div className="mb-2 text-xs text-slate-500">{commit.sha.slice(0, 8)} · {commit.author} · {commit.date}</div>
                <p className="text-slate-700">{commit.impact}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {data.hotspots?.length ? (
        <Card className="rounded-[2rem] p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-ink">
            <CalendarClock className="h-4 w-4 text-warning" />
            Change hotspots
          </div>
          <div className="space-y-3">
            {data.hotspots.map((item: any) => (
              <div key={item.path} className="rounded-[1.25rem] border border-line bg-white/75 p-4 text-sm">
                <div className="mb-1 font-medium text-ink">{item.path}</div>
                <div className="mb-2 text-xs text-slate-500">{item.changeCount} recent changes</div>
                <p className="text-slate-700">{item.reason}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
