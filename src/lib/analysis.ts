import type { ArtifactScope } from "@prisma/client";
import {
  type CommitSummary
} from "@/lib/git";
import {
  type FileAnalysisContext,
  type FolderAnalysisContext,
  type RepositorySnapshot,
  deriveLanguageFromPath
} from "@/lib/repository";
import {
  type ArtifactMetadata,
  type DiagramGraph,
  type FileAnalysisWithPreview,
  type FolderAnalysis,
  type HistorySummary,
  type QuickScan,
  type RepoAnalysis,
  fileAnalysisSchema,
  folderAnalysisSchema,
  historySummarySchema,
  quickScanSchema,
  repoAnalysisSchema
} from "@/lib/contracts";
import { MODEL_DEFAULTS } from "@/lib/constants";
import { generateStructuredOutput, hasOpenAIClient } from "@/lib/openai";
import { truncate, uniqueStrings } from "@/lib/utils";

type AnalysisResult<T> = {
  model: string;
  data: T;
  mermaidText: string;
  markdown: string;
  metadata?: Record<string, unknown>;
  sourceExcerpt?: string;
};

const PROMPT_VERSION = "v2";

function buildMetadata(
  provider: ArtifactMetadata["provider"],
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh",
  extra: Partial<Omit<ArtifactMetadata, "provider" | "promptVersion" | "reasoningEffort">> = {}
): ArtifactMetadata {
  return {
    provider,
    promptVersion: PROMPT_VERSION,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...extra
  };
}

function buildReadingOrder(paths: string[]) {
  return uniqueStrings(paths)
    .filter(Boolean)
    .slice(0, 6)
    .map((pathValue, index) => ({
      path: pathValue,
      why:
        index === 0
          ? "전체 구조를 이해하는 첫 진입점입니다."
          : index < 3
            ? "핵심 책임과 모듈 경계를 파악하기 좋은 경로입니다."
            : "세부 구현과 보조 흐름을 따라가기 전에 읽어두면 좋은 경로입니다."
    }));
}

function extractConcernPaths(commits: CommitSummary[]) {
  return uniqueStrings(commits.flatMap((commit) => commit.changedPaths).filter(Boolean)).slice(0, 4);
}

function pickCategory(snapshot: RepositorySnapshot) {
  const labels = [...snapshot.frameworks, ...snapshot.languages.map((language) => language.name)];
  if (labels.some((label) => ["Next.js", "React", "CSS", "Tailwind CSS"].includes(label))) return "Frontend";
  if (labels.some((label) => ["Django", "Express", "Fastify", "NestJS", "Go Modules"].includes(label))) return "Backend";
  if (labels.some((label) => ["Prisma", "Cargo", "Library"].includes(label))) return "DevTools";
  return "Library";
}

function graphFromPaths(paths: string[], title: string): DiagramGraph {
  const nodes = [
    {
      id: "root",
      label: title,
      kind: "entry" as const,
      note: "Main analysis entrypoint"
    },
    ...paths.slice(0, 8).map((pathValue, index) => ({
      id: `node-${index}`,
      label: pathValue,
      kind: pathValue.includes("/") ? (pathValue.endsWith(".ts") || pathValue.endsWith(".tsx") || pathValue.endsWith(".js") || pathValue.endsWith(".py") ? "file" : "folder") : "module",
      note: "Important repository path"
    }))
  ];

  const edges = nodes.slice(1).map((node) => ({
    from: "root",
    to: node.id,
    label: "contains"
  }));

  return { nodes, edges };
}

export function diagramToMermaid(graph: DiagramGraph) {
  const lines = ["flowchart TD"];

  for (const node of graph.nodes) {
    const safeLabel = node.label.replace(/"/g, "'");
    lines.push(`  ${node.id}[\"${safeLabel}\"]`);
  }

  for (const edge of graph.edges) {
    const safeLabel = edge.label.replace(/"/g, "'");
    lines.push(`  ${edge.from} -->|\"${safeLabel}\"| ${edge.to}`);
  }

  return lines.join("\n");
}

export function buildArtifactMarkdown(scope: ArtifactScope, data: RepoAnalysis | FolderAnalysis | FileAnalysisWithPreview | HistorySummary) {
  if (scope === "REPO") {
    const repo = data as RepoAnalysis;
    return [
      `# ${repo.summary}`,
      "",
      `## Architecture overview`,
      repo.architectureOverview,
      "",
      `## Recommended reading order`,
      ...repo.recommendedReadingOrder.map((item) => `- ${item.path}: ${item.why}`),
      "",
      `## Technical points`,
      ...repo.technicalPoints.map((item) => `- ${item}`),
      "",
      `## Risks`,
      ...repo.risks.map((item) => `- ${item}`)
    ].join("\n");
  }

  if (scope === "FOLDER") {
    const folder = data as FolderAnalysis;
    return [
      `# ${folder.summary}`,
      "",
      `## Responsibility`,
      folder.responsibility,
      "",
      `## Reading order`,
      ...folder.readingOrder.map((item) => `- ${item.path}: ${item.why}`),
      "",
      `## Concepts`,
      ...folder.concepts.map((item) => `- ${item}`)
    ].join("\n");
  }

  if (scope === "FILE") {
    const file = data as FileAnalysisWithPreview;
    return [
      `# ${file.summary}`,
      "",
      `## Purpose`,
      file.purpose,
      "",
      `## Reading checklist`,
      ...file.readingChecklist.map((item) => `- ${item}`),
      "",
      `## Technical points`,
      ...file.technicalPoints.map((item) => `- ${item}`)
    ].join("\n");
  }

  const history = data as HistorySummary;
  return [
    `# ${history.summary}`,
    "",
    `## Evolution themes`,
    ...history.evolutionThemes.map((item) => `- ${item}`)
  ].join("\n");
}

function fallbackQuickScan(snapshot: RepositorySnapshot): QuickScan {
  return {
    summary: `${snapshot.frameworks.join(", ") || snapshot.languages[0]?.name || "Mixed"} 기반의 저장소로 보이며, ${snapshot.totalFiles}개 파일과 ${snapshot.totalDirectories}개 디렉터리를 포함합니다.`,
    suggestedCategory: pickCategory(snapshot),
    tags: uniqueStrings([
      ...snapshot.frameworks,
      ...snapshot.languages.slice(0, 3).map((item) => item.name),
      "Architecture",
      "Codebase"
    ]).slice(0, 8),
    stackHighlights: uniqueStrings([...snapshot.frameworks, ...snapshot.languages.slice(0, 4).map((item) => item.name)]).slice(0, 6),
    notableFolders: snapshot.topLevelDirectories.slice(0, 5).map((pathValue) => ({
      path: pathValue,
      reason: "상위 레벨에서 프로젝트 구조를 이해하는 핵심 디렉터리입니다."
    })),
    notableFiles: snapshot.importantEntries.slice(0, 5).map((pathValue) => ({
      path: pathValue,
      reason: "엔트리포인트 또는 설정 이해에 중요한 파일입니다."
    }))
  };
}

function fallbackRepoAnalysis(snapshot: RepositorySnapshot, recentCommits: CommitSummary[]): RepoAnalysis {
  const majorPaths = [...snapshot.topLevelDirectories, ...snapshot.importantEntries].slice(0, 6);
  const graph = graphFromPaths(majorPaths, "repository");
  const readingOrder = buildReadingOrder([...snapshot.importantEntries, ...snapshot.topLevelDirectories]);
  const hotspotPaths = extractConcernPaths(recentCommits);

  return {
    summary: `${snapshot.frameworks.join(", ") || snapshot.languages[0]?.name || "Mixed"} 중심 구조의 코드베이스입니다.`,
    architectureOverview: `상위 디렉터리와 대표 엔트리 파일을 기준으로 보면, 이 저장소는 ${snapshot.topLevelDirectories.length || 1}개의 주요 서브시스템으로 분리되어 있으며 대표 설정 파일과 애플리케이션 엔트리포인트를 통해 구조가 드러납니다.`,
    majorSubsystems: majorPaths.map((pathValue) => ({
      name: pathValue.split("/").pop() || pathValue,
      responsibility: "저장소의 주요 기능 또는 설정 중심 역할을 담당합니다.",
      importantPaths: [pathValue]
    })),
    keyFlows: [
      {
        title: "Entry to execution",
        steps: uniqueStrings([...snapshot.importantEntries, ...snapshot.topLevelDirectories]).slice(0, 4)
      }
    ],
    recommendedReadingOrder: readingOrder,
    crossCuttingConcerns: uniqueStrings([
      snapshot.frameworks.length ? `프레임워크 경계: ${snapshot.frameworks.join(", ")}` : "",
      snapshot.languages.length > 1 ? `다중 언어 표면: ${snapshot.languages.slice(0, 3).map((item) => item.name).join(", ")}` : "",
      hotspotPaths[0] ? `최근 변화 hotspot: ${hotspotPaths[0]}` : "최근 변경 이력을 함께 보면 아키텍처 의도를 더 빨리 파악할 수 있습니다."
    ]).filter(Boolean),
    designTradeoffs: [
      {
        decision: "상위 폴더 중심 구조",
        rationale: "초기 탐색 시 모듈 경계를 빠르게 파악할 수 있습니다.",
        downside: "세부 호출 흐름은 파일 단위 drilldown이 필요합니다."
      },
      {
        decision: "대표 엔트리/설정 파일 우선 탐색",
        rationale: "초기 학습 비용을 낮추고 전체 구조를 빠르게 요약할 수 있습니다.",
        downside: "깊은 런타임 분기와 숨은 의존성은 놓칠 수 있습니다."
      }
    ],
    stack: uniqueStrings([...snapshot.frameworks, ...snapshot.languages.map((item) => item.name)]).slice(0, 6).map((name) => ({
      name,
      role: "프로젝트의 구현 및 구조를 구성하는 핵심 기술입니다."
    })),
    developerNotes: [
      "대표 파일을 먼저 읽고 하위 폴더로 내려가면 구조를 빠르게 이해할 수 있습니다.",
      "quick scan으로 선정된 경로를 중심으로 상세 분석을 이어가는 구성이 적합합니다."
    ],
    technicalPoints: [
      "상위 폴더 기반 모듈 분리가 잘 드러납니다.",
      "대표 설정 파일과 엔트리 파일을 함께 보는 것이 중요합니다."
    ],
    risks: [
      snapshot.representativeFiles.length === 0 ? "대표 소스 파일을 충분히 읽지 못한 상태입니다." : "자동 샘플링 기반이므로 일부 세부 모듈은 후속 drilldown이 필요합니다."
    ],
    diagram: graph
  };
}

function fallbackFolderAnalysis(context: FolderAnalysisContext): FolderAnalysis {
  const graph = graphFromPaths([...context.childDirectories, ...context.childFiles].slice(0, 8), context.path);
  const coChangedOutsidePaths = uniqueStrings(
    context.recentCommits
      .flatMap((commit) => commit.changedPaths)
      .filter((pathValue) => pathValue && pathValue !== context.path && !pathValue.startsWith(`${context.path}/`))
  ).slice(0, 6);
  const downstream = uniqueStrings(
    context.representativeFiles.flatMap((file) => file.excerpt.match(/from\s+["']([^"']+)["']/g) || [])
  ).slice(0, 6);

  return {
    summary: `${context.path} 폴더는 ${context.childDirectories.length}개 하위 디렉터리와 ${context.childFiles.length}개 파일을 포함합니다.`,
    responsibility: "관련 기능이 한 폴더로 묶여 있으며, 하위 파일/디렉터리 구성을 통해 관심사를 나누는 역할을 담당합니다.",
    importantChildren: [...context.childDirectories, ...context.childFiles].slice(0, 6).map((pathValue) => ({
      path: pathValue,
      reason: "이 폴더 안에서 흐름을 이해하는 기준점입니다."
    })),
    upstreamDependencies: coChangedOutsidePaths,
    downstreamDependencies: downstream,
    patterns: ["폴더 단위 응집", "책임 기반 분리"],
    concepts: ["하위 모듈 탐색", "연관 파일 묶음 이해"],
    technicalPoints: [
      "대표 파일을 통해 폴더의 책임과 협력 관계를 빠르게 파악할 수 있습니다.",
      "하위 디렉터리와 엔트리 파일을 같이 보면 의도를 읽기 쉽습니다."
    ],
    considerations: ["정확한 의존성 방향은 파일 단위 분석으로 보완하는 것이 좋습니다."],
    readingOrder: buildReadingOrder([...context.childDirectories, ...context.childFiles]),
    diagram: graph
  };
}

function fallbackFileAnalysis(context: FileAnalysisContext): FileAnalysisWithPreview {
  const graph = graphFromPaths([...context.imports, ...context.exportedSymbols].slice(0, 8), context.path);
  const keySymbols = (context.exportedSymbols.length > 0 ? context.exportedSymbols : [context.path.split("/").pop() || context.path])
    .slice(0, 6)
    .map((symbol) => ({
      name: symbol,
      role: "파일에서 먼저 추적해야 할 핵심 식별자입니다."
    }));

  return {
    summary: `${context.path} 파일은 ${context.language}로 작성되었고 ${context.lineCount}줄 규모입니다.`,
    purpose: "파일명과 코드 시그널 기준으로 보면 특정 기능, 설정, 또는 모듈 인터페이스를 담당합니다.",
    architectureRole: context.path.includes("page") || context.path.includes("component") ? "UI/entry role" : context.path.includes("api") ? "API role" : "Module role",
    inputsOutputs: uniqueStrings([
      ...context.imports.slice(0, 5).map((value) => `import:${value}`),
      ...context.exportedSymbols.slice(0, 5).map((value) => `export:${value}`)
    ]),
    controlFlow: [
      "상단 import/setup을 읽고, 주요 선언부를 따라가며, export 지점을 확인하는 순서가 적합합니다."
    ],
    callSequence: [
      ...context.imports.slice(0, 3).map((value) => `Resolve dependency: ${value}`),
      "Trace top-level declarations and state initialization.",
      "Follow the main symbol or exported surface back to its callers."
    ].slice(0, 5),
    patterns: ["모듈화", context.imports.length > 0 ? "의존성 주입 또는 import 기반 조합" : "자체 로직 중심"],
    keySymbols,
    glossary: context.exportedSymbols.slice(0, 5).map((symbol) => ({
      term: symbol,
      description: "파일에서 중요한 식별자입니다."
    })),
    dependencyNotes: [
      context.imports.length > 0 ? `이 파일은 ${context.imports.length}개의 import 시그널에 의존합니다.` : "외부 의존성 시그널이 적어 파일 자체 책임이 상대적으로 선명합니다.",
      context.recentCommits[0] ? `최근 변경 맥락은 '${truncate(context.recentCommits[0].message, 80)}' 커밋과 함께 읽는 것이 좋습니다.` : "최근 커밋 정보가 제한적이라 호출 관계 중심으로 읽는 편이 좋습니다."
    ],
    technicalPoints: [
      `import ${context.imports.length}개, export 시그널 ${context.exportedSymbols.length}개가 감지되었습니다.`,
      "구체적 호출 흐름은 관련 파일과 함께 봐야 더 정확합니다."
    ],
    pitfalls: ["자동 요약 기반이므로 런타임 분기나 동적 로딩은 후속 검토가 필요할 수 있습니다."],
    readingChecklist: [
      "import 목록으로 외부 의존성을 먼저 확인합니다.",
      "상단 선언부와 핵심 심볼 정의를 읽습니다.",
      "최근 관련 커밋과 함께 파일 책임 변화를 확인합니다."
    ],
    relatedFiles: context.imports.slice(0, 8),
    relatedCommits: context.recentCommits.slice(0, 5).map((commit) => ({ sha: commit.sha, message: commit.message })),
    diagram: graph,
    sourcePreviewHtml: context.sourcePreviewHtml,
    sourceLanguage: context.language,
    sourceExcerpt: context.excerpt
  };
}

function fallbackHistorySummary(commits: CommitSummary[]): HistorySummary {
  const changeCount = new Map<string, number>();

  for (const commit of commits) {
    for (const changedPath of commit.changedPaths) {
      changeCount.set(changedPath, (changeCount.get(changedPath) || 0) + 1);
    }
  }

  const hotspots = [...changeCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([pathValue, count]) => ({
      path: pathValue,
      changeCount: count,
      reason: "최근 커밋에서 반복적으로 변경되었습니다."
    }));

  return {
    summary: `최근 ${commits.length}개 커밋 기준으로 코드베이스의 변화 흐름을 요약했습니다.`,
    evolutionThemes: [
      "상위 변경 hotspot 경로 중심으로 구조가 진화하고 있습니다.",
      commits[0] ? `가장 최근 커밋 메시지는 '${truncate(commits[0].message, 80)}' 입니다.` : "최근 커밋 데이터가 제한적입니다."
    ],
    hotspots,
    recentCommits: commits.slice(0, 10).map((commit) => ({
      sha: commit.sha,
      author: commit.author,
      date: commit.date,
      message: commit.message,
      changedPaths: commit.changedPaths.slice(0, 8),
      impact: commit.changedPaths[0] ? `${commit.changedPaths[0]} 중심 변경이어서 관련 모듈 책임이나 호출 경계에 영향을 줄 수 있습니다.` : "병합 또는 메타 변경 성격이어서 관련 브랜치 컨텍스트와 함께 읽는 것이 좋습니다."
    })),
    pathHighlights: hotspots.slice(0, 5).map((hotspot) => ({
      path: hotspot.path,
      note: "변경 빈도와 구조 영향이 높아 우선 drilldown할 가치가 있는 경로입니다."
    }))
  };
}

export async function analyzeQuickScan(snapshot: RepositorySnapshot): Promise<AnalysisResult<QuickScan>> {
  if (!hasOpenAIClient()) {
    const data = fallbackQuickScan(snapshot);
    return {
      model: MODEL_DEFAULTS.fast,
      data,
      mermaidText: diagramToMermaid(graphFromPaths([...snapshot.topLevelDirectories, ...snapshot.importantEntries].slice(0, 8), "quick-scan")),
      markdown: `# ${data.summary}`
    };
  }

  try {
    const data = await generateStructuredOutput({
      schema: quickScanSchema,
      schemaName: "quick_scan",
      model: MODEL_DEFAULTS.fast,
      reasoningEffort: "none",
      verbosity: "low",
      maxOutputTokens: 1400,
      system: "You are a staff engineer triaging a newly imported repository for a developer-facing analysis board. Return concise JSON grounded only in the provided snapshot. Highlight the most important entry paths, practical tags, and the best first drilldown targets. Prefer specific file and folder paths over generic commentary.",
      user: JSON.stringify(
        {
          totalFiles: snapshot.totalFiles,
          totalDirectories: snapshot.totalDirectories,
          languages: snapshot.languages,
          frameworks: snapshot.frameworks,
          importantEntries: snapshot.importantEntries,
          topLevelDirectories: snapshot.topLevelDirectories,
          representativeFiles: snapshot.representativeFiles.map((file) => ({
            path: file.path,
            language: file.language,
            excerpt: truncate(file.excerpt, 1200)
          }))
        },
        null,
        2
      )
    });

    return {
      model: MODEL_DEFAULTS.fast,
      data,
      mermaidText: diagramToMermaid(graphFromPaths([...snapshot.topLevelDirectories, ...snapshot.importantEntries].slice(0, 8), "quick-scan")),
      markdown: `# ${data.summary}`
    };
  } catch {
    const data = fallbackQuickScan(snapshot);
    return {
      model: MODEL_DEFAULTS.fast,
      data,
      mermaidText: diagramToMermaid(graphFromPaths([...snapshot.topLevelDirectories, ...snapshot.importantEntries].slice(0, 8), "quick-scan")),
      markdown: `# ${data.summary}`
    };
  }
}

export async function analyzeRepository(snapshot: RepositorySnapshot, recentCommits: CommitSummary[]): Promise<AnalysisResult<RepoAnalysis>> {
  const fallback = fallbackRepoAnalysis(snapshot, recentCommits);

  if (!hasOpenAIClient()) {
    return {
      model: MODEL_DEFAULTS.repo,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("REPO", fallback),
      metadata: buildMetadata("fallback", "medium")
    };
  }

  try {
    const reasoningEffort = "medium" as const;
    const data = await generateStructuredOutput({
      schema: repoAnalysisSchema,
      schemaName: "repo_analysis",
      model: MODEL_DEFAULTS.repo,
      reasoningEffort,
      verbosity: "high",
      maxOutputTokens: 4200,
      system: "You are a principal engineer writing a deep-dive repository briefing for another engineer joining the codebase. Return structured JSON only. Be concrete, path-aware, and grounded in the provided snapshot. Emphasize architecture boundaries, subsystem responsibilities, practical reading order, cross-cutting concerns, technical tradeoffs, and developer-facing risks. Prefer empty arrays over invented claims when evidence is weak.",
      user: JSON.stringify(
        {
          snapshot: {
            totalFiles: snapshot.totalFiles,
            totalDirectories: snapshot.totalDirectories,
            languages: snapshot.languages,
            frameworks: snapshot.frameworks,
            importantEntries: snapshot.importantEntries,
            topLevelDirectories: snapshot.topLevelDirectories,
            representativeFiles: snapshot.representativeFiles.map((file) => ({
              path: file.path,
              language: file.language,
              lineCount: file.lineCount,
              excerpt: truncate(file.excerpt, 1800)
            }))
          },
          recentCommits: recentCommits.slice(0, 8)
        },
        null,
        2
      )
    });

    return {
      model: MODEL_DEFAULTS.repo,
      data,
      mermaidText: diagramToMermaid(data.diagram),
      markdown: buildArtifactMarkdown("REPO", data),
      metadata: buildMetadata("openai", reasoningEffort)
    };
  } catch {
    return {
      model: MODEL_DEFAULTS.repo,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("REPO", fallback),
      metadata: buildMetadata("fallback", "medium")
    };
  }
}

export async function analyzeFolder(context: FolderAnalysisContext): Promise<AnalysisResult<FolderAnalysis>> {
  const fallback = fallbackFolderAnalysis(context);

  if (!hasOpenAIClient()) {
    return {
      model: MODEL_DEFAULTS.deep,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("FOLDER", fallback),
      metadata: buildMetadata("fallback", "low")
    };
  }

  try {
    const reasoningEffort = "low" as const;
    const data = await generateStructuredOutput({
      schema: folderAnalysisSchema,
      schemaName: "folder_analysis",
      model: MODEL_DEFAULTS.deep,
      reasoningEffort,
      verbosity: "medium",
      maxOutputTokens: 2600,
      system: "You are a senior engineer documenting a folder-level architectural deep dive for another developer. Return structured JSON only. Explain the folder's responsibility, the most important child paths, upstream and downstream dependency directions, concepts, technical considerations, and the reading order a developer should follow. Stay grounded in the provided paths, excerpts, and commit context.",
      user: JSON.stringify(
        {
          path: context.path,
          childDirectories: context.childDirectories,
          childFiles: context.childFiles,
          representativeFiles: context.representativeFiles.map((file) => ({
            path: file.path,
            language: file.language,
            excerpt: truncate(file.excerpt, 1400)
          })),
          recentCommits: context.recentCommits.slice(0, 6)
        },
        null,
        2
      )
    });

    return {
      model: MODEL_DEFAULTS.deep,
      data,
      mermaidText: diagramToMermaid(data.diagram),
      markdown: buildArtifactMarkdown("FOLDER", data),
      metadata: buildMetadata("openai", reasoningEffort)
    };
  } catch {
    return {
      model: MODEL_DEFAULTS.deep,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("FOLDER", fallback),
      metadata: buildMetadata("fallback", "low")
    };
  }
}

export async function analyzeFile(context: FileAnalysisContext): Promise<AnalysisResult<FileAnalysisWithPreview>> {
  const highComplexity = context.lineCount > 260 || context.imports.length > 10;
  const selectedModel = highComplexity ? MODEL_DEFAULTS.repo : MODEL_DEFAULTS.deep;
  const fallback = fallbackFileAnalysis(context);

  if (!hasOpenAIClient()) {
    return {
      model: selectedModel,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("FILE", fallback),
      metadata: buildMetadata("fallback", highComplexity ? "medium" : "low", {
        sourceLanguage: context.language,
        sourcePreviewHtml: context.sourcePreviewHtml
      }),
      sourceExcerpt: context.excerpt
    };
  }

  try {
    const reasoningEffort = highComplexity ? "medium" as const : "low" as const;
    const data = await generateStructuredOutput({
      schema: fileAnalysisSchema,
      schemaName: "file_analysis",
      model: selectedModel,
      reasoningEffort,
      verbosity: highComplexity ? "high" : "medium",
      maxOutputTokens: highComplexity ? 3200 : 2400,
      system: "You are a staff engineer producing a file-level deep-dive for another developer. Return structured JSON only. Explain the file's responsibility, architecture role, inputs and outputs, dependency direction, key symbols, call sequence, practical reading checklist, and nearby related files or commits. Stay strict to the provided context and prefer precise developer guidance over generic summaries.",
      user: JSON.stringify(
        {
          path: context.path,
          language: context.language,
          lineCount: context.lineCount,
          imports: context.imports,
          exportedSymbols: context.exportedSymbols,
          recentCommits: context.recentCommits.slice(0, 6),
          excerpt: truncate(context.fullContent, 9000)
        },
        null,
        2
      )
    });

    const withPreview: FileAnalysisWithPreview = {
      ...data,
      sourcePreviewHtml: context.sourcePreviewHtml,
      sourceLanguage: context.language,
      sourceExcerpt: context.excerpt
    };

    return {
      model: selectedModel,
      data: withPreview,
      mermaidText: diagramToMermaid(data.diagram),
      markdown: buildArtifactMarkdown("FILE", withPreview),
      metadata: buildMetadata("openai", reasoningEffort, {
        sourceLanguage: context.language,
        sourcePreviewHtml: context.sourcePreviewHtml
      }),
      sourceExcerpt: context.excerpt
    };
  } catch {
    return {
      model: selectedModel,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("FILE", fallback),
      metadata: buildMetadata("fallback", highComplexity ? "medium" : "low", {
        sourceLanguage: context.language,
        sourcePreviewHtml: context.sourcePreviewHtml
      }),
      sourceExcerpt: context.excerpt
    };
  }
}

export async function analyzeHistory(commits: CommitSummary[]): Promise<AnalysisResult<HistorySummary>> {
  const fallback = fallbackHistorySummary(commits);

  if (!hasOpenAIClient()) {
    return {
      model: MODEL_DEFAULTS.deep,
      data: fallback,
      mermaidText: diagramToMermaid(graphFromPaths(fallback.hotspots.map((item) => item.path), "history")),
      markdown: buildArtifactMarkdown("HISTORY", fallback),
      metadata: buildMetadata("fallback", "low")
    };
  }

  try {
    const reasoningEffort = "low" as const;
    const data = await generateStructuredOutput({
      schema: historySummarySchema,
      schemaName: "history_summary",
      model: MODEL_DEFAULTS.deep,
      reasoningEffort,
      verbosity: "medium",
      maxOutputTokens: 2600,
      system: "You are a technical historian explaining recent codebase evolution to an engineer. Return structured JSON only. Focus on why the recent commits matter, which paths are true hotspots, and what a developer should inspect next. Make impact and note fields actionable from an engineering perspective.",
      user: JSON.stringify(
        {
          commits: commits.slice(0, 20)
        },
        null,
        2
      )
    });

    return {
      model: MODEL_DEFAULTS.deep,
      data,
      mermaidText: diagramToMermaid(graphFromPaths(data.hotspots.map((item) => item.path), "history")),
      markdown: buildArtifactMarkdown("HISTORY", data),
      metadata: buildMetadata("openai", reasoningEffort)
    };
  } catch {
    return {
      model: MODEL_DEFAULTS.deep,
      data: fallback,
      mermaidText: diagramToMermaid(graphFromPaths(fallback.hotspots.map((item) => item.path), "history")),
      markdown: buildArtifactMarkdown("HISTORY", fallback),
      metadata: buildMetadata("fallback", "low")
    };
  }
}

export function explainSourceLanguage(relativePath: string) {
  return deriveLanguageFromPath(relativePath);
}
