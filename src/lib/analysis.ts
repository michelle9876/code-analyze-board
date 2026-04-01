import type { ArtifactScope } from "@prisma/client";
import { z } from "zod";
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
  type FileCodeFacts,
  type RepositoryCodeFacts,
  getFileFacts
} from "@/lib/code-facts";
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
} from "@/lib/contracts";
import { MODEL_DEFAULTS } from "@/lib/constants";
import { generatePlainText, generateStructuredOutput, hasGeminiClient } from "@/lib/gemini";
import { truncate, uniqueStrings } from "@/lib/utils";

type AnalysisResult<T> = {
  model: string;
  data: T;
  mermaidText: string;
  markdown: string;
  metadata?: Record<string, unknown>;
  sourceExcerpt?: string;
};

const PROMPT_VERSION = "v3";

const repoModelSchema = z.object({
  summary: z.string(),
  architectureOverview: z.string(),
  majorSubsystems: z.array(
    z.object({
      name: z.string(),
      responsibility: z.string(),
      importantPaths: z.array(z.string()).max(3)
    })
  ).max(3),
  stack: z.array(
    z.object({
      name: z.string(),
      role: z.string()
    })
  ).max(4),
  developerNotes: z.array(z.string()).max(3),
  risks: z.array(z.string()).max(3)
});

const repoUltraCompactSchema = z.object({
  summary: z.string(),
  architectureOverview: z.string(),
  stack: z.array(
    z.object({
      name: z.string(),
      role: z.string()
    })
  ).max(3),
  developerNotes: z.array(z.string()).max(2),
  risks: z.array(z.string()).max(2)
});

const folderModelSchema = z.object({
  summary: z.string(),
  responsibility: z.string(),
  importantChildren: z.array(
    z.object({
      path: z.string(),
      reason: z.string()
    })
  ).max(4),
  upstreamDependencies: z.array(z.string()).max(3),
  downstreamDependencies: z.array(z.string()).max(3),
  patterns: z.array(z.string()).max(3),
  concepts: z.array(z.string()).max(3),
  considerations: z.array(z.string()).max(2)
});

const fileModelSchema = z.object({
  summary: z.string(),
  purpose: z.string(),
  architectureRole: z.string(),
  inputsOutputs: z.array(z.string()).max(4),
  controlFlow: z.array(z.string()).max(3),
  callSequence: z.array(z.string()).max(4),
  patterns: z.array(z.string()).max(3),
  keySymbols: z.array(
    z.object({
      name: z.string(),
      role: z.string()
    })
  ).max(4),
  dependencyNotes: z.array(z.string()).max(3),
  technicalPoints: z.array(z.string()).max(3),
  pitfalls: z.array(z.string()).max(2)
});

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

function describeFallback(error?: unknown): Partial<ArtifactMetadata> {
  if (!error) {
    return {
      fallbackReason: "missing_api_key",
      fallbackMessage: "Gemini API key is not configured for this process."
    };
  }

  const message = truncate(
    (error instanceof Error ? error.message : typeof error === "string" ? error : "Gemini analysis failed.")
      .replace(/\s+/g, " ")
      .trim(),
    180
  );
  const lowered = message.toLowerCase();

  let fallbackReason = "api_error";

  if (lowered.includes("quota")) {
    fallbackReason = "quota_exceeded";
  } else if (lowered.includes("rate limit") || lowered.startsWith("429")) {
    fallbackReason = "rate_limited";
  } else if (lowered.includes("api key") || lowered.includes("unauthorized") || lowered.startsWith("401")) {
    fallbackReason = "invalid_api_key";
  } else if (lowered.includes("refused")) {
    fallbackReason = "model_refusal";
  } else if (
    lowered.includes("unterminated string") ||
    lowered.includes("json at position") ||
    lowered.includes("double-quoted property")
  ) {
    fallbackReason = "structured_output_error";
  } else if (lowered.includes("parse")) {
    fallbackReason = "structured_output_error";
  }

  return {
    fallbackReason,
    fallbackMessage: message
  };
}

function buildReadingOrder(paths: string[]) {
  return uniqueStrings(paths)
    .filter(Boolean)
    .slice(0, 5)
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

function baseName(pathValue: string) {
  return pathValue.split("/").filter(Boolean).pop() || pathValue;
}

function extractQuotedMatches(content: string, patterns: RegExp[]) {
  const values: string[] = [];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) {
        values.push(value);
      }
    }
  }

  return uniqueStrings(values);
}

function extractReferencePaths(content: string) {
  return extractQuotedMatches(content, [
    /from\s+["']([^"']+)["']/g,
    /require\(["']([^"']+)["']\)/g,
    /(?:src|href)=["']([^"']+)["']/g,
    /@import\s+["']([^"']+)["']/g,
    /url\(["']?([^"')]+)["']?\)/g
  ])
    .filter((value) => !value.startsWith("http") && !value.startsWith("data:") && !value.startsWith("#"))
    .slice(0, 8);
}

function extractDeclaredSymbols(content: string) {
  return extractQuotedMatches(content, [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /function\s+([A-Za-z0-9_]+)\s*\(/g,
    /class\s+([A-Za-z0-9_]+)/g,
    /(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=/g,
    /interface\s+([A-Za-z0-9_]+)/g,
    /type\s+([A-Za-z0-9_]+)\s*=/g
  ]).slice(0, 8);
}

function normalizeSectionHeading(line: string) {
  const match = line
    .trim()
    .match(/^(?:[#>*\-\s`]+)?(SUMMARY|ARCHITECTURE|STACK|NOTES|RISKS)(?:\s*:?\s*)$/i);

  return match?.[1]?.toUpperCase() || null;
}

function toBulletItems(lines: string[]) {
  return uniqueStrings(
    lines
      .flatMap((line) => {
        const trimmed = line.trim();
        if (!trimmed) return [];
        if (/^[-*]\s+/.test(trimmed)) return [trimmed.replace(/^[-*]\s+/, "").trim()];
        if (/^\d+\.\s+/.test(trimmed)) return [trimmed.replace(/^\d+\.\s+/, "").trim()];
        return trimmed.split(/\s{2,}|;\s+/).map((item) => item.trim()).filter(Boolean);
      })
      .map((item) => item.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
  );
}

function toParagraph(lines: string[]) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRepoPlainText(raw: string) {
  const sections: Record<string, string[]> = {
    SUMMARY: [],
    ARCHITECTURE: [],
    STACK: [],
    NOTES: [],
    RISKS: []
  };

  let currentSection: keyof typeof sections | null = null;

  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const heading = normalizeSectionHeading(line);
    if (heading && heading in sections) {
      currentSection = heading as keyof typeof sections;
      continue;
    }

    if (currentSection) {
      sections[currentSection].push(line);
    }
  }

  const stack = toBulletItems(sections.STACK)
    .map((item) => {
      const [name, role] = item.split(/\s+(?:::|->|-)\s+|:\s+/);
      const cleanedName = (name || item).trim();
      const cleanedRole = (role || "핵심 기술 요소").trim();
      return cleanedName ? { name: cleanedName, role: cleanedRole } : null;
    })
    .filter((value): value is { name: string; role: string } => Boolean(value))
    .slice(0, 3);

  return {
    summary: toParagraph(sections.SUMMARY),
    architectureOverview: toParagraph(sections.ARCHITECTURE),
    stack,
    developerNotes: toBulletItems(sections.NOTES).slice(0, 2),
    risks: toBulletItems(sections.RISKS).slice(0, 2)
  };
}

function describeSubsystemResponsibility(pathValue: string) {
  const lower = pathValue.toLowerCase();

  if (lower.includes("src")) return "애플리케이션의 핵심 구현과 도메인 로직이 모이는 중심 영역입니다.";
  if (lower.includes("app")) return "실행 진입점과 화면 또는 서비스 조합 로직을 묶는 역할을 합니다.";
  if (lower.includes("component")) return "재사용 가능한 UI 또는 조합 가능한 프리미티브를 담는 영역입니다.";
  if (lower.includes("api") || lower.includes("route")) return "외부 요청을 받아 내부 로직과 연결하는 인터페이스 계층입니다.";
  if (lower.includes("lib") || lower.includes("utils")) return "공통 헬퍼와 재사용 로직을 제공하는 기반 계층입니다.";
  if (lower.includes("config") || lower.includes("package") || lower.includes("pom") || lower.includes("docker"))
    return "프로젝트 설정, 빌드, 런타임 동작을 규정하는 구성 요소입니다.";
  if (lower.endsWith(".md") || lower.includes("readme")) return "프로젝트 사용법과 맥락을 설명하는 문서 진입점입니다.";
  return "저장소 구조를 이해할 때 먼저 확인해야 할 핵심 경로입니다.";
}

function describeFolderResponsibility(context: FolderAnalysisContext) {
  const lower = context.path.toLowerCase();
  const childSummary = `${context.childDirectories.length}개 하위 디렉터리와 ${context.childFiles.length}개 파일`;

  if (lower.includes("component")) return `${childSummary}로 구성된 UI 또는 조합 가능한 화면 단위를 담는 폴더입니다.`;
  if (lower.includes("api") || lower.includes("route")) return `${childSummary}를 통해 요청 진입점과 응답 흐름을 구성하는 폴더입니다.`;
  if (lower.includes("lib") || lower.includes("utils")) return `${childSummary}를 통해 여러 경로에서 재사용되는 공통 로직을 묶는 폴더입니다.`;
  if (lower.includes("test") || lower.includes("spec")) return `${childSummary}로 테스트 시나리오와 검증 코드를 관리하는 폴더입니다.`;
  if (lower.includes("config")) return `${childSummary}로 런타임/빌드 설정을 구성하는 폴더입니다.`;

  return `${childSummary}를 중심으로 한 관심사 단위의 구현 묶음이며, 대표 파일과 하위 경로를 함께 보면 책임 경계가 드러납니다.`;
}

function inferFolderPatterns(context: FolderAnalysisContext, downstream: string[]) {
  const childNames = [...context.childDirectories, ...context.childFiles].map((pathValue) => baseName(pathValue).toLowerCase());
  const patterns = ["폴더 단위 응집"];

  if (childNames.some((name) => name.startsWith("index"))) patterns.push("index 중심 진입점");
  if (childNames.some((name) => name.includes("page") || name.includes("layout"))) patterns.push("화면/레이아웃 조합");
  if (childNames.some((name) => name.includes("route") || name.includes("api"))) patterns.push("라우트 핸들러 분리");
  if (childNames.some((name) => name.includes("test") || name.includes("spec"))) patterns.push("테스트 인접 구성");
  if (downstream.length > 0) patterns.push("인접 모듈 참조");

  return uniqueStrings(patterns).slice(0, 4);
}

function inferArchitectureRole(pathValue: string, content: string) {
  const lower = pathValue.toLowerCase();

  if (lower.endsWith(".md") || lower.includes("readme")) return "Documentation role";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".sass")) return "Styling role";
  if (lower.endsWith(".html")) return "Markup role";
  if (lower.includes("page") || lower.includes("layout") || lower.includes("component") || lower.endsWith(".tsx") || lower.endsWith(".jsx"))
    return "UI role";
  if (lower.includes("api") || lower.includes("route") || lower.includes("controller")) return "API role";
  if (lower.includes("service") || lower.includes("client") || lower.includes("gateway")) return "Service role";
  if (lower.includes("schema") || lower.includes("model") || lower.includes("types")) return "Contract role";
  if (lower.endsWith("package.json") || lower.endsWith("pom.xml") || lower.includes("config") || lower.includes("dockerfile"))
    return "Configuration role";
  if (content.includes("class ")) return "Object-oriented module role";
  return "Module role";
}

function inferFilePatterns(pathValue: string, content: string, imports: string[], exportedSymbols: string[]) {
  const lower = pathValue.toLowerCase();
  const patterns = ["모듈화"];

  if (imports.length > 0) patterns.push("import 기반 조합");
  if (exportedSymbols.length > 0) patterns.push("명시적 공개 API");
  if (content.includes("class ")) patterns.push("class 기반 구조");
  if (content.includes("function ") || content.includes("=>")) patterns.push("함수 중심 로직");
  if (lower.endsWith(".html")) patterns.push("정적 마크업");
  if (lower.endsWith(".css")) patterns.push("스타일 시트 분리");
  if (lower.endsWith(".json") || lower.endsWith(".yml") || lower.endsWith(".yaml") || lower.endsWith(".xml")) patterns.push("구성 파일");

  return uniqueStrings(patterns).slice(0, 4);
}

function describeFilePurpose(pathValue: string, architectureRole: string, relatedPaths: string[]) {
  const fileName = baseName(pathValue);

  if (architectureRole === "Configuration role") {
    return `${fileName}은 프로젝트 설정, 의존성, 또는 빌드/실행 방식을 정의하는 파일입니다.`;
  }
  if (architectureRole === "UI role" || architectureRole === "Markup role") {
    return `${fileName}은 화면 진입점 또는 화면을 구성하는 시각적 구조를 정의하며, 관련 자산과 스타일 경로를 함께 읽는 것이 중요합니다.`;
  }
  if (architectureRole === "API role") {
    return `${fileName}은 요청을 받아 내부 로직으로 연결하거나 응답을 반환하는 인터페이스 계층 역할을 담당합니다.`;
  }
  if (architectureRole === "Service role") {
    return `${fileName}은 외부 시스템 또는 다른 내부 모듈과의 연결·조합 책임을 가진 서비스성 파일입니다.`;
  }
  if (architectureRole === "Documentation role") {
    return `${fileName}은 코드 이해를 돕는 문서 진입점이며, ${relatedPaths[0] ? `${relatedPaths.slice(0, 2).join(", ")} 같은 구현 경로와 함께 보면` : "대표 구현 경로와 함께 보면"} 더 효과적입니다.`;
  }

  return `${fileName}은 ${architectureRole.toLowerCase()}로서 특정 책임을 캡슐화하고, ${relatedPaths[0] ? relatedPaths.slice(0, 2).join(", ") : "인접 모듈"}와의 연결을 통해 동작합니다.`;
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
      kind: (
        pathValue.includes("/")
          ? (pathValue.endsWith(".ts") || pathValue.endsWith(".tsx") || pathValue.endsWith(".js") || pathValue.endsWith(".py") ? "file" : "folder")
          : "module"
      ) as DiagramGraph["nodes"][number]["kind"],
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
      ...(repo.entrypoints.length
        ? [
            `## Entry points`,
            ...repo.entrypoints.map((item) => `- ${item.path}: ${item.why}`),
            ""
          ]
        : []),
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
      `## Execution role`,
      file.frameworkRole,
      "",
      ...(file.callers.length ? [`## Called by`, ...file.callers.map((item) => `- ${item}`), ""] : []),
      ...(file.callees.length ? [`## Calls out`, ...file.callees.map((item) => `- ${item}`), ""] : []),
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

function fallbackRepoAnalysis(
  snapshot: RepositorySnapshot,
  recentCommits: CommitSummary[],
  facts?: RepositoryCodeFacts | null
): RepoAnalysis {
  const representativePaths = snapshot.representativeFiles.map((file) => file.path);
  const hotspotPaths = extractConcernPaths(recentCommits);
  const detectedStack = uniqueStrings([...snapshot.frameworks, ...snapshot.languages.map((item) => item.name)]).slice(0, 5);
  const entryCandidates = uniqueStrings([...snapshot.importantEntries, ...representativePaths]).slice(0, 4);
  const heuristicMajorPaths = uniqueStrings([...snapshot.topLevelDirectories, ...snapshot.importantEntries, ...representativePaths]).slice(0, 6);
  const heuristicGraph = graphFromPaths(heuristicMajorPaths, "repository");
  const heuristicReadingOrder = buildReadingOrder([...snapshot.importantEntries, ...snapshot.topLevelDirectories]);

  if (facts && facts.entrypoints.length) {
    const factMajorPaths = uniqueStrings([
      ...facts.entrypoints.map((item) => item.path),
      ...facts.moduleGraphSummary.highFanOutModules,
      ...facts.moduleGraphSummary.configSurfaces
    ]).slice(0, 6);
    const logicFlows = facts.logicFlows.slice(0, 4);
    const readingOrder = facts.readingOrder.length ? facts.readingOrder.slice(0, 5) : heuristicReadingOrder;

    return {
      summary: `${facts.factLanguages.join(", ") || snapshot.languages[0]?.name || "Mixed"} 기반 코드베이스이며, ${facts.entrypoints[0]?.path || entryCandidates[0] || "대표 엔트리"}를 따라가면 실제 orchestration 흐름을 가장 빨리 이해할 수 있습니다.`,
      architectureOverview: `${facts.moduleGraphSummary.summary} ${facts.entrypoints[0] ? `${facts.entrypoints[0].path}에서 시작해 ${logicFlows[0]?.steps.slice(1, 3).join(" -> ") || "핵심 서비스 모듈"}로 이어지는 흐름이 대표 pipeline입니다.` : "fact cache를 기준으로 entrypoint와 중심 모듈을 추적했습니다."}`,
      entrypoints: facts.entrypoints.slice(0, 6),
      logicFlows,
      evidenceCards: facts.evidenceCards.slice(0, 8),
      moduleGraphSummary: facts.moduleGraphSummary,
      majorSubsystems: factMajorPaths.slice(0, 4).map((pathValue) => ({
        name: baseName(pathValue),
        responsibility: describeSubsystemResponsibility(pathValue),
        importantPaths: [pathValue]
      })),
      keyFlows: logicFlows.slice(0, 3).map((flow) => ({ title: flow.title, steps: flow.steps.slice(0, 4) })),
      recommendedReadingOrder: readingOrder,
      crossCuttingConcerns: uniqueStrings([
        ...facts.moduleGraphSummary.externalSystems.map((system) => `External system boundary: ${system}`),
        ...facts.moduleGraphSummary.configSurfaces.map((pathValue) => `Configuration surface: ${pathValue}`),
        hotspotPaths[0] ? `Recent change hotspot: ${hotspotPaths[0]}` : "",
        facts.entrypoints[0] ? `Entrypoint-driven orchestration starts at ${facts.entrypoints[0].path}` : ""
      ]).filter(Boolean).slice(0, 4),
      designTradeoffs: [
        {
          decision: "Entrypoint-driven modular orchestration",
          rationale: "실행 시작점과 중심 모듈이 비교적 선명해 새로운 개발자가 pipeline을 따라가며 구조를 학습하기 좋습니다.",
          downside: "세부 비즈니스 규칙은 각 service/data 모듈 안으로 흩어져 있어 파일 단위 drilldown이 필요합니다."
        },
        {
          decision: "Configuration and external boundaries are explicit",
          rationale: "설정 소비 지점과 외부 시스템 접점이 드러나 배포/런타임 영향 범위를 추적하기 쉽습니다.",
          downside: "환경별 분기나 외부 의존성 변화가 있을 때 관련 경로를 함께 읽지 않으면 오해하기 쉽습니다."
        }
      ],
      stack: detectedStack.map((name) => ({
        name,
        role: "프로젝트의 구현 및 구조를 구성하는 핵심 기술입니다."
      })),
      developerNotes: uniqueStrings([
        readingOrder[0] ? `${readingOrder[0].path}부터 시작해 logic flow 섹션의 다음 스텝을 따라가면 실행 구조를 빨리 잡을 수 있습니다.` : "",
        facts.moduleGraphSummary.highFanOutModules[0] ? `${facts.moduleGraphSummary.highFanOutModules[0]}는 호출/의존 연결이 많아 구조 이해의 허브 역할을 합니다.` : "",
        facts.moduleGraphSummary.configSurfaces[0] ? `${facts.moduleGraphSummary.configSurfaces[0]}에서 환경 설정이 어디에 영향을 주는지 같이 확인하면 좋습니다.` : ""
      ]).filter(Boolean).slice(0, 4),
      technicalPoints: uniqueStrings([
        `${Object.keys(facts.files).length}개 파일에서 AST 기반 사실을 추출해 entrypoint, import graph, symbol surface를 계산했습니다.`,
        facts.moduleGraphSummary.highFanOutModules[0] ? `중심성 높은 모듈: ${facts.moduleGraphSummary.highFanOutModules.slice(0, 3).join(", ")}` : "",
        facts.moduleGraphSummary.externalSystems[0] ? `감지된 외부 시스템: ${facts.moduleGraphSummary.externalSystems.join(", ")}` : "외부 시스템 경계는 제한적으로 감지되었습니다."
      ]).filter(Boolean).slice(0, 5),
      risks: uniqueStrings([
        snapshot.totalFiles > Object.keys(facts.files).length ? "지원 언어(JS/TS, Python) 기준 fact-backed 분석이라 다른 언어/자산은 heuristic 요약 비중이 남아 있습니다." : "",
        facts.moduleGraphSummary.externalSystems.length > 2 ? "외부 시스템 접점이 여러 곳에 흩어져 있어 장애 영향 범위를 확인할 때 경계 파일들을 함께 읽는 것이 좋습니다." : "",
        hotspotPaths[0] ? `최근 변경이 ${hotspotPaths.slice(0, 2).join(", ")}에 몰려 있어 구조가 아직 진화 중일 수 있습니다.` : ""
      ]).filter(Boolean).slice(0, 4),
      diagram: facts.diagram
    };
  }

  const keyFlows = uniqueStrings([
    JSON.stringify({
      title: "First-pass reading flow",
      steps: uniqueStrings([...entryCandidates, ...snapshot.topLevelDirectories]).slice(0, 4)
    }),
    ...(hotspotPaths.length
      ? [
          JSON.stringify({
            title: "Recent change flow",
            steps: uniqueStrings([...hotspotPaths, ...entryCandidates]).slice(0, 4)
          })
        ]
      : [])
  ]).map((item) => JSON.parse(item) as { title: string; steps: string[] });
  const entrypoints = entryCandidates.map((pathValue) => ({
    path: pathValue,
    kind: "entry file",
    why: "대표 설정 또는 엔트리 파일로 보이는 경로입니다."
  }));
  const evidenceCards = uniqueStrings([...entryCandidates, ...hotspotPaths]).slice(0, 4).map((pathValue, index) => ({
    title: index < entryCandidates.length ? "Representative entry" : "Recent hotspot",
    path: pathValue,
    kind: index < entryCandidates.length ? "entrypoint" as const : "service" as const,
    evidence: index < entryCandidates.length ? `${pathValue} is a representative entry/config file.` : `${pathValue} appears repeatedly in recent commits.`,
    whyItMatters: index < entryCandidates.length ? "구조 이해를 시작하는 기준점이 됩니다." : "최근 구조 변화와 현재 개발 초점을 이해하는 단서가 됩니다."
  }));

  return {
    summary: `${snapshot.frameworks.join(", ") || snapshot.languages[0]?.name || "Mixed"} 중심 구조의 코드베이스이며, ${entryCandidates[0] ? entryCandidates[0] : "대표 엔트리"}를 기준으로 읽기 시작하는 것이 좋습니다.`,
    architectureOverview: `상위 디렉터리, 대표 엔트리 파일, 그리고 샘플링된 구현 파일을 기준으로 보면 이 저장소는 ${snapshot.topLevelDirectories.length || 1}개의 주요 서브시스템으로 나뉘며, ${entryCandidates[0] ? `${entryCandidates[0]} 같은 엔트리 경로` : "대표 설정/엔트리 경로"}가 전체 구조를 연결하는 기준점 역할을 합니다.`,
    entrypoints,
    logicFlows: keyFlows.map((flow) => ({ title: flow.title, steps: flow.steps })),
    evidenceCards,
    moduleGraphSummary: {
      summary: `Representative files and top-level paths were sampled to approximate the module graph for ${snapshot.totalFiles} files.`,
      highFanOutModules: heuristicMajorPaths.slice(0, 4),
      externalSystems: snapshot.frameworks.slice(0, 3),
      configSurfaces: snapshot.importantEntries.filter((pathValue) => /config|package|pom|docker|env/i.test(pathValue)).slice(0, 4)
    },
    majorSubsystems: heuristicMajorPaths.slice(0, 4).map((pathValue) => ({
      name: baseName(pathValue),
      responsibility: describeSubsystemResponsibility(pathValue),
      importantPaths: [pathValue]
    })),
    keyFlows,
    recommendedReadingOrder: heuristicReadingOrder,
    crossCuttingConcerns: uniqueStrings([
      snapshot.frameworks.length ? `프레임워크 경계: ${snapshot.frameworks.join(", ")}` : "",
      snapshot.languages.length > 1 ? `다중 언어 표면: ${snapshot.languages.slice(0, 3).map((item) => item.name).join(", ")}` : "",
      entryCandidates[0] ? `대표 진입 경로: ${entryCandidates[0]}` : "",
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
    stack: detectedStack.map((name) => ({
      name,
      role: "프로젝트의 구현 및 구조를 구성하는 핵심 기술입니다."
    })),
      developerNotes: [
      heuristicReadingOrder[0] ? `${heuristicReadingOrder[0].path}부터 읽고 상위 폴더로 확장하면 구조를 빠르게 이해할 수 있습니다.` : "대표 파일을 먼저 읽고 하위 폴더로 내려가면 구조를 빠르게 이해할 수 있습니다.",
      hotspotPaths[0] ? `최근 변경이 잦은 ${hotspotPaths[0]}를 함께 보면 현재 개발 초점과 구조 변화를 읽기 쉽습니다.` : "quick scan으로 선정된 경로를 중심으로 상세 분석을 이어가는 구성이 적합합니다."
    ],
    technicalPoints: [
      `대표 탐색 경로 ${heuristicMajorPaths.length}개와 샘플 파일 ${snapshot.representativeFiles.length}개를 기준으로 구조를 요약했습니다.`,
      detectedStack.length > 0 ? `감지된 핵심 스택: ${detectedStack.join(", ")}` : "언어/프레임워크 표면이 제한적입니다.",
      entryCandidates[0] ? `대표 설정/엔트리 파일은 ${entryCandidates.join(", ")} 입니다.` : "대표 설정 파일과 엔트리 파일을 함께 보는 것이 중요합니다."
    ],
    risks: [
      snapshot.representativeFiles.length === 0 ? "대표 소스 파일을 충분히 읽지 못한 상태입니다." : "자동 샘플링 기반이므로 일부 세부 모듈과 런타임 분기는 후속 drilldown이 필요합니다.",
      hotspotPaths.length > 2 ? `최근 변경 hotspot이 ${hotspotPaths.slice(0, 3).join(", ")}에 몰려 있어, 현재 구조가 아직 진화 중일 수 있습니다.` : "최근 변경 축이 비교적 좁아 특정 모듈을 중심으로 구조를 파악하기 좋습니다."
    ],
    diagram: heuristicGraph
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
    context.representativeFiles.flatMap((file) => extractReferencePaths(file.excerpt))
  ).slice(0, 6);
  const patterns = inferFolderPatterns(context, downstream);
  const concepts = uniqueStrings([
    context.childDirectories.length > 0 ? "하위 모듈 경계 파악" : "",
    context.childFiles.length > 0 ? "대표 파일 책임 비교" : "",
    downstream.length > 0 ? "의존 경로 추적" : "",
    coChangedOutsidePaths.length > 0 ? "최근 함께 바뀐 경로와의 협력 관계 이해" : ""
  ]).filter(Boolean).slice(0, 4);

  return {
    summary: `${context.path} 폴더는 ${context.childDirectories.length}개 하위 디렉터리와 ${context.childFiles.length}개 파일을 포함합니다.`,
    responsibility: describeFolderResponsibility(context),
    importantChildren: [...context.childDirectories, ...context.childFiles].slice(0, 5).map((pathValue) => ({
      path: pathValue,
      reason: "이 폴더 안에서 흐름을 이해하는 기준점입니다."
    })),
    upstreamDependencies: coChangedOutsidePaths.slice(0, 4),
    downstreamDependencies: downstream.slice(0, 4),
    patterns,
    concepts,
    technicalPoints: [
      `하위 디렉터리 ${context.childDirectories.length}개, 파일 ${context.childFiles.length}개로 책임이 묶여 있습니다.`,
      downstream[0] ? `대표 파일 기준으로 보이는 인접 의존 경로는 ${downstream.slice(0, 3).join(", ")} 입니다.` : "대표 파일을 통해 폴더의 책임과 협력 관계를 빠르게 파악할 수 있습니다.",
      "하위 디렉터리와 엔트리 파일을 같이 보면 의도를 읽기 쉽습니다."
    ],
    considerations: [
      coChangedOutsidePaths[0] ? `최근 함께 변경된 ${coChangedOutsidePaths.slice(0, 2).join(", ")} 경로까지 보면 협력 경계를 더 정확히 읽을 수 있습니다.` : "정확한 의존성 방향은 파일 단위 분석으로 보완하는 것이 좋습니다."
    ],
    readingOrder: buildReadingOrder([...context.childDirectories, ...context.childFiles]).slice(0, 4),
    diagram: graph
  };
}

function fallbackFileAnalysis(context: FileAnalysisContext, fileFacts?: FileCodeFacts | null): FileAnalysisWithPreview {
  const heuristicDeclaredSymbols = extractDeclaredSymbols(context.fullContent);
  const declaredSymbolFacts = fileFacts?.declaredSymbols?.length
    ? fileFacts.declaredSymbols
    : heuristicDeclaredSymbols.slice(0, 8).map((name) => ({ name, kind: "symbol" }));
  const exportedSymbolNames = fileFacts?.exportedSymbols?.length
    ? fileFacts.exportedSymbols.map((symbol) => symbol.name)
    : context.exportedSymbols;
  const relatedPaths = uniqueStrings([
    ...(fileFacts?.callers || []),
    ...(fileFacts?.callees || []),
    ...context.imports,
    ...extractReferencePaths(context.fullContent)
  ]).slice(0, 8);
  const graph = fileFacts?.diagram?.nodes?.length
    ? fileFacts.diagram
    : graphFromPaths([...relatedPaths, ...exportedSymbolNames, ...declaredSymbolFacts.map((symbol) => symbol.name)].slice(0, 8), context.path);
  const architectureRole = fileFacts?.frameworkRole || inferArchitectureRole(context.path, context.fullContent);
  const keySymbols = (
    fileFacts?.exportedSymbols?.length
      ? fileFacts.exportedSymbols.map((symbol) => symbol.name)
      : exportedSymbolNames.length > 0
        ? exportedSymbolNames
        : declaredSymbolFacts.length > 0
          ? declaredSymbolFacts.map((symbol) => symbol.name)
          : [baseName(context.path)]
  )
    .slice(0, 5)
    .map((symbol) => ({
      name: symbol,
      role: "파일에서 먼저 추적해야 할 핵심 식별자입니다."
    }));
  const patterns = inferFilePatterns(context.path, context.fullContent, context.imports, context.exportedSymbols);
  const callers = fileFacts?.callers?.slice(0, 6) || [];
  const callees = fileFacts?.callees?.slice(0, 6) || relatedPaths.slice(0, 6);
  const evidenceCards = fileFacts?.evidenceCards?.slice(0, 8) || [
    {
      title: "Static dependency surface",
      path: context.path,
      symbol: declaredSymbolFacts[0]?.name,
      kind: "service" as const,
      evidence: relatedPaths[0] ? `${context.path} references ${relatedPaths.slice(0, 3).join(", ")}.` : `${context.path} exposes ${exportedSymbolNames.slice(0, 2).join(", ")}.`,
      whyItMatters: "정적 참조와 핵심 심볼을 같이 보면 파일의 책임과 협력 방향을 빠르게 파악할 수 있습니다."
    }
  ];
  const controlFlow =
    architectureRole === "Markup role"
      ? ["문서 구조를 먼저 읽고, 연결된 자산 경로와 본문 콘텐츠 순서로 따라가는 것이 적합합니다."]
      : architectureRole === "Styling role"
        ? ["상단 규칙/토큰 선언을 확인한 뒤, 주요 selector 블록과 재사용 클래스 순서로 읽는 것이 적합합니다."]
        : architectureRole === "Configuration role"
          ? ["상단 설정 키와 의존성 선언을 확인하고, 실행/빌드에 영향을 주는 필드부터 읽는 것이 적합합니다."]
          : fileFacts?.isHandler
            ? ["외부 요청 또는 이벤트가 이 파일에 들어온 뒤, 핵심 handler/export를 따라 내부 service/data 경로로 내려가는 순서가 적합합니다."]
            : fileFacts?.isEntrypoint
              ? ["bootstrap 또는 main 실행 지점을 먼저 확인한 뒤, 이 파일이 위임하는 내부 모듈 순서로 내려가는 것이 좋습니다."]
              : ["상단 import/setup을 읽고, 주요 선언부를 따라가며, export 지점 또는 핵심 심볼을 확인하는 순서가 적합합니다."];

  return {
    summary: fileFacts
      ? `${context.path} 파일은 ${architectureRole.toLowerCase()}이며 ${callers.length}개의 caller와 ${callees.length}개의 callee가 감지되었습니다.`
      : `${context.path} 파일은 ${context.language}로 작성되었고 ${context.lineCount}줄 규모입니다.`,
    purpose: describeFilePurpose(context.path, architectureRole, relatedPaths),
    architectureRole,
    frameworkRole: architectureRole,
    declaredSymbols: declaredSymbolFacts.slice(0, 8),
    callers,
    callees,
    evidenceCards,
    inputsOutputs: uniqueStrings([
      ...relatedPaths.slice(0, 5).map((value) => `depends-on:${value}`),
      ...exportedSymbolNames.slice(0, 5).map((value) => `export:${value}`)
    ]),
    controlFlow,
    callSequence: uniqueStrings([
      callers[0] ? `Called from ${callers.slice(0, 2).join(", ")}.` : "",
      declaredSymbolFacts[0] ? `Inspect primary declarations such as ${declaredSymbolFacts.slice(0, 2).map((symbol) => symbol.name).join(", ")}.` : "Trace top-level declarations and state initialization.",
      callees[0] ? `Delegates work to ${callees.slice(0, 2).join(", ")}.` : "",
      fileFacts?.externalCalls[0] ? `Touches external systems through ${fileFacts.externalCalls.slice(0, 2).join(", ")}.` : "",
      architectureRole === "Configuration role"
        ? "Map the configuration fields back to the runtime or build behavior they influence."
        : "Follow the main symbol or exported surface back to its callers."
    ]).filter(Boolean).slice(0, 5),
    patterns,
    keySymbols,
    glossary: uniqueStrings([...exportedSymbolNames, ...declaredSymbolFacts.map((symbol) => symbol.name)]).slice(0, 4).map((symbol) => ({
      term: symbol,
      description: "파일에서 중요한 식별자입니다."
    })),
    dependencyNotes: [
      callers[0] ? `이 파일을 먼저 호출하는 경로는 ${callers.slice(0, 3).join(", ")} 입니다.` : "이 파일의 상위 caller는 정적 사실 기준으로 제한적입니다.",
      callees[0] ? `이 파일이 내려가는 주요 하위 경로는 ${callees.slice(0, 3).join(", ")} 입니다.` : "정적 callee 시그널이 적어 파일 자체 책임이 상대적으로 선명합니다.",
      fileFacts?.configTouches[0] ? `설정/환경 변수 접점: ${fileFacts.configTouches.slice(0, 3).join(", ")}` : "",
      context.recentCommits[0] ? `최근 변경 맥락은 '${truncate(context.recentCommits[0].message, 80)}' 커밋과 함께 읽는 것이 좋습니다.` : "최근 커밋 정보가 제한적이라 호출 관계 중심으로 읽는 편이 좋습니다."
    ].filter(Boolean).slice(0, 4),
    technicalPoints: [
      `${context.language} 파일 ${context.lineCount}줄 규모이며 import ${context.imports.length}개, export 시그널 ${exportedSymbolNames.length}개가 감지되었습니다.`,
      fileFacts ? `fact-backed 분석 기준 caller ${callers.length}개, callee ${callees.length}개, 핵심 심볼 ${declaredSymbolFacts.length}개를 추적했습니다.` : "현재는 heuristic 기반 요약이므로 정적 호출 관계는 제한적으로 보입니다.",
      relatedPaths.length > 0 ? `정적 참조 경로 ${relatedPaths.length}개가 있어 관련 파일과 함께 보면 흐름이 더 선명합니다.` : "구체적 호출 흐름은 관련 파일과 함께 봐야 더 정확합니다."
    ],
    pitfalls: [
      architectureRole === "Configuration role"
        ? "설정 파일은 값 자체보다 실제 런타임에서 어디서 소비되는지까지 확인해야 영향 범위를 정확히 파악할 수 있습니다."
        : "자동 요약 기반이므로 런타임 분기나 동적 로딩은 후속 검토가 필요할 수 있습니다."
    ],
    readingChecklist: [
      callers[0] ? "상위 caller부터 보고 이 파일이 어떤 흐름 중간에 위치하는지 확인합니다." : relatedPaths[0] ? "정적 참조 경로와 인접 파일부터 확인합니다." : "import 목록으로 외부 의존성을 먼저 확인합니다.",
      declaredSymbolFacts[0] ? `핵심 심볼(${declaredSymbolFacts.slice(0, 2).map((symbol) => symbol.name).join(", ")}) 정의를 읽습니다.` : "상단 선언부와 핵심 심볼 정의를 읽습니다.",
      callees[0] ? "이 파일이 내려가는 service/data 경로를 이어서 읽습니다." : "이 파일이 export하는 표면을 소비하는 지점을 확인합니다.",
      "최근 관련 커밋과 함께 파일 책임 변화를 확인합니다."
    ],
    relatedFiles: relatedPaths.slice(0, 5),
    relatedCommits: context.recentCommits.slice(0, 4).map((commit) => ({ sha: commit.sha, message: commit.message })),
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
    .slice(0, 5)
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
    recentCommits: commits.slice(0, 8).map((commit) => ({
      sha: commit.sha,
      author: commit.author,
      date: commit.date,
      message: commit.message,
      changedPaths: commit.changedPaths.slice(0, 4),
      impact: commit.changedPaths[0] ? `${commit.changedPaths[0]} 중심 변경이어서 관련 모듈 책임이나 호출 경계에 영향을 줄 수 있습니다.` : "병합 또는 메타 변경 성격이어서 관련 브랜치 컨텍스트와 함께 읽는 것이 좋습니다."
    })),
    pathHighlights: hotspots.slice(0, 5).map((hotspot) => ({
      path: hotspot.path,
      note: "변경 빈도와 구조 영향이 높아 우선 drilldown할 가치가 있는 경로입니다."
    }))
  };
}

export async function analyzeQuickScan(snapshot: RepositorySnapshot): Promise<AnalysisResult<QuickScan>> {
  if (!hasGeminiClient()) {
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

export async function analyzeRepository(
  snapshot: RepositorySnapshot,
  recentCommits: CommitSummary[],
  facts?: RepositoryCodeFacts | null
): Promise<AnalysisResult<RepoAnalysis>> {
  const fallback = fallbackRepoAnalysis(snapshot, recentCommits, facts);
  const isHugeRepo = snapshot.totalFiles >= 250 || snapshot.totalDirectories >= 80;
  const factMetadata = facts
    ? {
        analysisMode: "fact-backed" as const,
        factLanguages: facts.factLanguages,
        factCacheKey: facts.cacheKey
      }
    : {
        analysisMode: "heuristic" as const
      };

  if (!hasGeminiClient()) {
    return {
      model: MODEL_DEFAULTS.repo,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("REPO", fallback),
      metadata: buildMetadata("fallback", "medium", {
        ...factMetadata,
        ...describeFallback()
      })
    };
  }

  try {
    const reasoningEffort = "medium" as const;
    const selectedSchema = isHugeRepo ? repoUltraCompactSchema : repoModelSchema;
    const selectedSchemaName = isHugeRepo ? "repo_analysis_ultra_compact" : "repo_analysis_compact";
    const representativeFiles = snapshot.representativeFiles
      .slice(0, isHugeRepo ? 4 : snapshot.representativeFiles.length)
      .map((file) => ({
        path: file.path,
        language: file.language,
        lineCount: file.lineCount,
        excerpt: truncate(file.excerpt, isHugeRepo ? 220 : 420)
      }));
    const payload = facts
      ? {
          snapshot: {
            totalFiles: snapshot.totalFiles,
            totalDirectories: snapshot.totalDirectories,
            languages: snapshot.languages.slice(0, 6),
            frameworks: snapshot.frameworks.slice(0, 4)
          },
          facts: {
            entrypoints: facts.entrypoints.slice(0, 4),
            logicFlows: facts.logicFlows.slice(0, isHugeRepo ? 2 : 4),
            evidenceCards: facts.evidenceCards.slice(0, 5),
            moduleGraphSummary: facts.moduleGraphSummary,
            readingOrder: facts.readingOrder.slice(0, 5)
          },
          representativeFiles
        }
      : isHugeRepo
        ? {
            snapshot: {
              totalFiles: snapshot.totalFiles,
              totalDirectories: snapshot.totalDirectories,
              languages: snapshot.languages.slice(0, 6),
              frameworks: snapshot.frameworks.slice(0, 4),
              importantEntries: snapshot.importantEntries.slice(0, 4),
              topLevelDirectories: snapshot.topLevelDirectories.slice(0, 4),
              representativeFiles
            },
            recentCommits: recentCommits.slice(0, 2).map((commit) => ({
              message: commit.message,
              changedPaths: commit.changedPaths.slice(0, 2)
            }))
          }
        : {
            snapshot: {
              totalFiles: snapshot.totalFiles,
              totalDirectories: snapshot.totalDirectories,
              languages: snapshot.languages,
              frameworks: snapshot.frameworks,
              importantEntries: snapshot.importantEntries.slice(0, 5),
              topLevelDirectories: snapshot.topLevelDirectories.slice(0, 5),
              representativeFiles
            },
            recentCommits: recentCommits.slice(0, 3).map((commit) => ({
              sha: commit.sha,
              message: commit.message,
              changedPaths: commit.changedPaths.slice(0, 3)
            }))
          };
    const modelData = isHugeRepo
      ? await (async () => {
          const plainText = await generatePlainText({
            model: MODEL_DEFAULTS.repo,
            system: [
              "You are a principal engineer briefing another engineer on a very large repository.",
              "Ground the summary in the provided code facts: entrypoints, logic flows, module graph signals, and boundary files.",
              "Return plain text only using exactly these section headings:",
              "SUMMARY",
              "ARCHITECTURE",
              "STACK",
              "NOTES",
              "RISKS",
              "Under STACK, NOTES, and RISKS, use short bullet points.",
              "Do not output JSON.",
              "Do not add any introduction or conclusion outside the sections."
            ].join("\n"),
            user: JSON.stringify(payload, null, 2),
            maxOutputTokens: 700
          });

          const parsed = parseRepoPlainText(plainText);

          return {
            summary: parsed.summary || fallback.summary,
            architectureOverview: parsed.architectureOverview || fallback.architectureOverview,
            stack: parsed.stack.length ? parsed.stack : fallback.stack.slice(0, 3),
            developerNotes: parsed.developerNotes.length ? parsed.developerNotes : fallback.developerNotes.slice(0, 2),
            risks: parsed.risks.length ? parsed.risks : fallback.risks.slice(0, 2)
          };
        })()
      : await generateStructuredOutput({
          schema: selectedSchema,
          schemaName: selectedSchemaName,
          model: MODEL_DEFAULTS.repo,
          reasoningEffort,
          verbosity: "low",
          maxOutputTokens: 1400,
          system: "You are a principal engineer writing a compact developer-grade repository briefing grounded in code facts. Focus on runtime entrypoints, orchestration modules, service/data boundaries, and configuration or external-system touch points. Return structured JSON only. Keep every field very short and concrete. Do not emit markdown. Do not include diagrams, reading order, key flows, cross-cutting concerns, tradeoffs, or technical point lists. Only return summary, architectureOverview, up to 3 subsystem notes, up to 4 stack items, up to 3 developer notes, and up to 3 risks. Prefer empty arrays over invented claims when evidence is weak.",
          user: JSON.stringify(payload, null, 2)
        });

    const data: RepoAnalysis = {
      summary: modelData.summary,
      architectureOverview: modelData.architectureOverview,
      entrypoints: fallback.entrypoints,
      logicFlows: fallback.logicFlows,
      evidenceCards: fallback.evidenceCards,
      moduleGraphSummary: fallback.moduleGraphSummary,
      majorSubsystems: facts || isHugeRepo || !("majorSubsystems" in modelData) ? fallback.majorSubsystems : modelData.majorSubsystems,
      keyFlows: fallback.keyFlows,
      recommendedReadingOrder: fallback.recommendedReadingOrder,
      crossCuttingConcerns: fallback.crossCuttingConcerns,
      designTradeoffs: fallback.designTradeoffs,
      stack: modelData.stack.length ? modelData.stack : fallback.stack,
      developerNotes: uniqueStrings([...modelData.developerNotes, ...fallback.developerNotes]).slice(0, 4),
      technicalPoints: fallback.technicalPoints,
      risks: uniqueStrings([...modelData.risks, ...fallback.risks]).slice(0, 4),
      diagram: fallback.diagram
    };

    return {
      model: MODEL_DEFAULTS.repo,
      data,
      mermaidText: diagramToMermaid(data.diagram),
      markdown: buildArtifactMarkdown("REPO", data),
      metadata: buildMetadata("gemini", reasoningEffort, factMetadata)
    };
  } catch (error) {
    return {
      model: MODEL_DEFAULTS.repo,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("REPO", fallback),
      metadata: buildMetadata("fallback", "medium", {
        ...factMetadata,
        ...describeFallback(error)
      })
    };
  }
}

export async function analyzeFolder(context: FolderAnalysisContext): Promise<AnalysisResult<FolderAnalysis>> {
  const fallback = fallbackFolderAnalysis(context);

  if (!hasGeminiClient()) {
    return {
      model: MODEL_DEFAULTS.deep,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("FOLDER", fallback),
      metadata: buildMetadata("fallback", "low", describeFallback())
    };
  }

  try {
    const reasoningEffort = "low" as const;
    const modelData = await generateStructuredOutput({
      schema: folderModelSchema,
      schemaName: "folder_analysis_compact",
      model: MODEL_DEFAULTS.deep,
      reasoningEffort,
      verbosity: "low",
      maxOutputTokens: 1400,
      system: "You are a senior engineer documenting a compact folder-level brief for another developer. Return structured JSON only. Keep every field short and concrete. Do not emit markdown, diagrams, or reading-order plans. Return only summary, responsibility, up to 4 important children, up to 3 dependencies per direction, up to 3 patterns, up to 3 concepts, and up to 2 concise considerations.",
      user: JSON.stringify(
        {
          path: context.path,
          childDirectories: context.childDirectories.slice(0, 8),
          childFiles: context.childFiles.slice(0, 8),
          representativeFiles: context.representativeFiles.map((file) => ({
            path: file.path,
            language: file.language,
            excerpt: truncate(file.excerpt, 500)
          })),
          recentCommits: context.recentCommits.slice(0, 3).map((commit) => ({
            sha: commit.sha,
            message: commit.message,
            changedPaths: commit.changedPaths.slice(0, 3)
          }))
        },
        null,
        2
      )
    });

    const data: FolderAnalysis = {
      summary: modelData.summary,
      responsibility: modelData.responsibility,
      importantChildren: modelData.importantChildren,
      upstreamDependencies: modelData.upstreamDependencies,
      downstreamDependencies: modelData.downstreamDependencies,
      patterns: modelData.patterns,
      concepts: modelData.concepts,
      technicalPoints: fallback.technicalPoints,
      considerations: modelData.considerations,
      readingOrder: fallback.readingOrder,
      diagram: fallback.diagram
    };

    return {
      model: MODEL_DEFAULTS.deep,
      data,
      mermaidText: diagramToMermaid(data.diagram),
      markdown: buildArtifactMarkdown("FOLDER", data),
      metadata: buildMetadata("gemini", reasoningEffort)
    };
  } catch (error) {
    return {
      model: MODEL_DEFAULTS.deep,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("FOLDER", fallback),
      metadata: buildMetadata("fallback", "low", describeFallback(error))
    };
  }
}

export async function analyzeFile(
  context: FileAnalysisContext,
  facts?: RepositoryCodeFacts | null
): Promise<AnalysisResult<FileAnalysisWithPreview>> {
  const highComplexity = context.lineCount > 260 || context.imports.length > 10;
  const selectedModel = highComplexity ? MODEL_DEFAULTS.repo : MODEL_DEFAULTS.deep;
  const fileFacts = getFileFacts(facts, context.path);
  const fallback = fallbackFileAnalysis(context, fileFacts);
  const factMetadata = facts
    ? {
        analysisMode: "fact-backed" as const,
        factLanguages: facts.factLanguages,
        factCacheKey: facts.cacheKey
      }
    : {
        analysisMode: "heuristic" as const
      };

  if (!hasGeminiClient()) {
    return {
      model: selectedModel,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("FILE", fallback),
      metadata: buildMetadata("fallback", highComplexity ? "medium" : "low", {
        ...factMetadata,
        ...describeFallback(),
        sourceLanguage: context.language,
        sourcePreviewHtml: context.sourcePreviewHtml
      }),
      sourceExcerpt: context.excerpt
    };
  }

  try {
    const reasoningEffort = highComplexity ? "medium" as const : "low" as const;
    const modelData = await generateStructuredOutput({
      schema: fileModelSchema,
      schemaName: "file_analysis_compact",
      model: selectedModel,
      reasoningEffort,
      verbosity: "low",
      maxOutputTokens: highComplexity ? 1800 : 1200,
      system: "You are a staff engineer producing an evidence-backed file brief for another developer. Ground the explanation in the provided code facts: declared/exported symbols, callers, callees, config surfaces, and external boundaries. Return structured JSON only. Keep every field short and concrete. Do not emit markdown, glossary entries, reading checklists, related file lists, related commits, or diagrams. Return only summary, purpose, architectureRole, compact IO/control/call notes, up to 4 key symbols, up to 3 dependency notes, up to 3 technical points, and up to 2 pitfalls.",
      user: JSON.stringify(
        fileFacts
          ? {
              path: context.path,
              language: context.language,
              lineCount: context.lineCount,
              frameworkRole: fileFacts.frameworkRole,
              declaredSymbols: fileFacts.declaredSymbols.slice(0, 6),
              exportedSymbols: fileFacts.exportedSymbols.slice(0, 6),
              callers: fileFacts.callers.slice(0, 4),
              callees: fileFacts.callees.slice(0, 4),
              configTouches: fileFacts.configTouches.slice(0, 4),
              externalCalls: fileFacts.externalCalls.slice(0, 4),
              recentCommits: context.recentCommits.slice(0, 4),
              excerpt: truncate(context.fullContent, highComplexity ? 2200 : 1400)
            }
          : {
              path: context.path,
              language: context.language,
              lineCount: context.lineCount,
              imports: context.imports.slice(0, 8),
              exportedSymbols: context.exportedSymbols.slice(0, 8),
              recentCommits: context.recentCommits.slice(0, 4),
              excerpt: truncate(context.fullContent, highComplexity ? 2600 : 1600)
            },
        null,
        2
      )
    });

    const withPreview: FileAnalysisWithPreview = {
      summary: modelData.summary || fallback.summary,
      purpose: modelData.purpose,
      architectureRole: fallback.architectureRole || modelData.architectureRole,
      frameworkRole: fallback.frameworkRole,
      declaredSymbols: fallback.declaredSymbols,
      callers: fallback.callers,
      callees: fallback.callees,
      evidenceCards: fallback.evidenceCards,
      inputsOutputs: uniqueStrings([...fallback.inputsOutputs, ...modelData.inputsOutputs]).slice(0, 5),
      controlFlow: uniqueStrings([...fallback.controlFlow, ...modelData.controlFlow]).slice(0, 4),
      callSequence: uniqueStrings([...fallback.callSequence, ...modelData.callSequence]).slice(0, 5),
      patterns: uniqueStrings([...fallback.patterns, ...modelData.patterns]).slice(0, 4),
      keySymbols: fallback.keySymbols.length ? fallback.keySymbols : modelData.keySymbols,
      glossary: fallback.glossary,
      dependencyNotes: uniqueStrings([...fallback.dependencyNotes, ...modelData.dependencyNotes]).slice(0, 4),
      technicalPoints: uniqueStrings([...fallback.technicalPoints, ...modelData.technicalPoints]).slice(0, 5),
      pitfalls: modelData.pitfalls,
      readingChecklist: fallback.readingChecklist,
      relatedFiles: fallback.relatedFiles,
      relatedCommits: fallback.relatedCommits,
      diagram: fallback.diagram,
      sourcePreviewHtml: context.sourcePreviewHtml,
      sourceLanguage: context.language,
      sourceExcerpt: context.excerpt
    };

    return {
      model: selectedModel,
      data: withPreview,
      mermaidText: diagramToMermaid(withPreview.diagram),
      markdown: buildArtifactMarkdown("FILE", withPreview),
      metadata: buildMetadata("gemini", reasoningEffort, {
        ...factMetadata,
        sourceLanguage: context.language,
        sourcePreviewHtml: context.sourcePreviewHtml
      }),
      sourceExcerpt: context.excerpt
    };
  } catch (error) {
    return {
      model: selectedModel,
      data: fallback,
      mermaidText: diagramToMermaid(fallback.diagram),
      markdown: buildArtifactMarkdown("FILE", fallback),
      metadata: buildMetadata("fallback", highComplexity ? "medium" : "low", {
        ...factMetadata,
        ...describeFallback(error),
        sourceLanguage: context.language,
        sourcePreviewHtml: context.sourcePreviewHtml
      }),
      sourceExcerpt: context.excerpt
    };
  }
}

export async function analyzeHistory(commits: CommitSummary[]): Promise<AnalysisResult<HistorySummary>> {
  const fallback = fallbackHistorySummary(commits);

  if (!hasGeminiClient()) {
    return {
      model: MODEL_DEFAULTS.deep,
      data: fallback,
      mermaidText: diagramToMermaid(graphFromPaths(fallback.hotspots.map((item) => item.path), "history")),
      markdown: buildArtifactMarkdown("HISTORY", fallback),
      metadata: buildMetadata("fallback", "low", describeFallback())
    };
  }

  try {
    const reasoningEffort = "low" as const;
    const data = await generateStructuredOutput({
      schema: historySummarySchema,
      schemaName: "history_summary",
      model: MODEL_DEFAULTS.deep,
      reasoningEffort,
      verbosity: "low",
      maxOutputTokens: 1800,
      system: "You are a technical historian explaining recent codebase evolution to an engineer. Return structured JSON only. Keep the response compact: 4 themes or fewer, 5 hotspots or fewer, 8 commits or fewer, and short actionable impact notes.",
      user: JSON.stringify(
        {
          commits: commits.slice(0, 12)
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
      metadata: buildMetadata("gemini", reasoningEffort)
    };
  } catch (error) {
    return {
      model: MODEL_DEFAULTS.deep,
      data: fallback,
      mermaidText: diagramToMermaid(graphFromPaths(fallback.hotspots.map((item) => item.path), "history")),
      markdown: buildArtifactMarkdown("HISTORY", fallback),
      metadata: buildMetadata("fallback", "low", describeFallback(error))
    };
  }
}

export function explainSourceLanguage(relativePath: string) {
  return deriveLanguageFromPath(relativePath);
}
