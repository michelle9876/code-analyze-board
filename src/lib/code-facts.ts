import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import type { DiagramGraph } from "@/lib/contracts";
import { deriveLanguageFromPath, flattenTree, type RepositorySnapshot } from "@/lib/repository";
import { truncate, uniqueStrings } from "@/lib/utils";

const execFileAsync = promisify(execFile);

const FACTS_VERSION = "v8";
const MAX_FACT_FILE_BYTES = 180_000;
const MAX_FACT_FILES = 220;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".github",
  ".next",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "vendor",
  "venv",
  ".venv",
  "__pycache__"
]);
const SUPPORTED_JS_TS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SUPPORTED_PY_EXTENSIONS = new Set([".py"]);
const ALL_EXTENSIONS = new Set([...SUPPORTED_JS_TS_EXTENSIONS, ...SUPPORTED_PY_EXTENSIONS]);
const IMPORT_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py"];

export type EvidenceKind = "entrypoint" | "handler" | "service" | "external call" | "state" | "config";

export type EvidenceCard = {
  title: string;
  path: string;
  symbol?: string;
  kind: EvidenceKind;
  evidence: string;
  whyItMatters: string;
};

export type CodeSymbol = {
  name: string;
  kind: string;
};

export type CodeEntrypoint = {
  path: string;
  kind: string;
  symbol?: string;
  why: string;
};

export type CodeLogicFlow = {
  title: string;
  steps: string[];
};

export type LocalCallEdge = {
  caller: string;
  callee: string;
};

export type ModuleGraphSummary = {
  summary: string;
  highFanOutModules: string[];
  externalSystems: string[];
  configSurfaces: string[];
};

export type CodeReadingStep = {
  path: string;
  why: string;
};

export type FileCodeFacts = {
  path: string;
  language: string;
  frameworkRole: string;
  declaredSymbols: CodeSymbol[];
  exportedSymbols: CodeSymbol[];
  imports: string[];
  internalImports: string[];
  externalImports: string[];
  callers: string[];
  callees: string[];
  moduleCallers: string[];
  moduleCallees: string[];
  localCalls: string[];
  localCallEdges: LocalCallEdge[];
  configTouches: string[];
  externalCalls: string[];
  isEntrypoint: boolean;
  isHandler: boolean;
  entrySymbol?: string;
  diagram: DiagramGraph;
  evidenceCards: EvidenceCard[];
};

export type RepositoryCodeFacts = {
  repositoryId: string;
  commitSha: string;
  cacheKey: string;
  factLanguages: string[];
  entrypoints: CodeEntrypoint[];
  logicFlows: CodeLogicFlow[];
  evidenceCards: EvidenceCard[];
  moduleGraphSummary: ModuleGraphSummary;
  readingOrder: CodeReadingStep[];
  diagram: DiagramGraph;
  files: Record<string, FileCodeFacts>;
};

type RawFactResult = {
  path: string;
  language: string;
  frameworkRole: string;
  declaredSymbols: CodeSymbol[];
  exportedSymbols: CodeSymbol[];
  imports: string[];
  localCalls: string[];
  localCallEdges: LocalCallEdge[];
  configTouches: string[];
  externalCalls: string[];
  isEntrypoint: boolean;
  isHandler: boolean;
  entrySymbol?: string;
};

function toPosixPath(value: string) {
  return value.replace(/\\/g, "/");
}

function cachePathFor(repositoryId: string, commitSha: string) {
  return path.join(process.cwd(), "data", "facts", repositoryId, `${commitSha}.json`);
}

function fileExtension(filePath: string) {
  return path.extname(filePath).toLowerCase();
}

function scriptKindFromPath(filePath: string) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function baseName(filePath: string) {
  return filePath.split("/").filter(Boolean).pop() || filePath;
}

function diagramKindForRole(filePath: string, frameworkRole: string, isEntrypoint: boolean): DiagramGraph["nodes"][number]["kind"] {
  if (isEntrypoint) return "entry";
  const lower = frameworkRole.toLowerCase();
  const lowerPath = filePath.toLowerCase();

  if (lower.includes("ui") || lowerPath.endsWith(".tsx") || lowerPath.endsWith(".jsx")) return "ui";
  if (lower.includes("config") || lowerPath.includes("config") || lowerPath.endsWith("package.json")) return "config";
  if (lower.includes("service") || lower.includes("handler")) return "service";
  if (lower.includes("data") || /schema|model|store|cache|db|repository/.test(lowerPath)) return "data";
  return "module";
}

function normalizeSymbolKind(kind: string) {
  return kind.toLowerCase().replace(/\s+/g, "-");
}

function collectBindingNames(name: ts.BindingName, output: string[]) {
  if (ts.isIdentifier(name)) {
    output.push(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    collectBindingNames(element.name, output);
  }
}

function hasExportModifier(node: ts.Node) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultModifier(node: ts.Node) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function pushSymbol(output: CodeSymbol[], name: string | undefined, kind: string) {
  const trimmed = name?.trim();
  if (!trimmed) return;
  output.push({ name: trimmed, kind: normalizeSymbolKind(kind) });
}

function getPropertyNameText(name: ts.PropertyName | ts.BindingName | undefined) {
  if (!name) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

function getFunctionScopeName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text;
  }

  if (ts.isMethodDeclaration(node)) {
    return getPropertyNameText(node.name);
  }

  if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent)) {
    return ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
  }

  return undefined;
}

function getCallExpressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const parent = getCallExpressionName(expression.expression);
    return parent ? `${parent}.${expression.name.text}` : expression.name.text;
  }

  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    const parent = getCallExpressionName(expression.expression);
    return parent ? `${parent}.${expression.argumentExpression.text}` : expression.argumentExpression.text;
  }

  if (ts.isCallExpression(expression)) {
    return getCallExpressionName(expression.expression);
  }

  return undefined;
}

function lastSymbolSegment(name: string) {
  return name.split(".").filter(Boolean).pop() || name;
}

function fileStemTokens(relativePath: string) {
  return baseName(relativePath)
    .replace(/\.[^.]+$/, "")
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 4);
}

function isExternalishCallName(name: string) {
  return /fetch|axios|request|client|redis|prisma|query|publish|send|enqueue|cache|db|sql|response\.(json|text)|json\.load|sys\.exit|re\.search|console\.(log|error|warn)/i.test(
    name
  );
}

function formatSymbolLabel(symbol: string) {
  if (symbol === "<module>") return "module bootstrap";
  return symbol.includes("(") ? symbol : `${symbol}()`;
}

function uniqueCallEdges(edges: LocalCallEdge[]) {
  const seen = new Set<string>();
  const output: LocalCallEdge[] = [];

  for (const edge of edges) {
    const key = `${edge.caller}->${edge.callee}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(edge);
  }

  return output;
}

function buildDeveloperCallers(fact: FileCodeFacts) {
  const entryFocused = fact.entrySymbol
    ? fact.localCallEdges
        .filter((edge) => edge.callee === fact.entrySymbol)
        .map((edge) => `${formatSymbolLabel(edge.caller)} -> ${formatSymbolLabel(edge.callee)}`)
    : [];

  const moduleEdges = fact.moduleCallers.map((value) => `imported by ${value}`);
  return uniqueStrings([...entryFocused, ...moduleEdges]).slice(0, 6);
}

function buildDeveloperCallees(fact: FileCodeFacts) {
  const preferredLocalEdges = fact.entrySymbol
    ? fact.localCallEdges.filter((edge) => edge.caller === fact.entrySymbol)
    : fact.localCallEdges;
  const localEdges = preferredLocalEdges.length ? preferredLocalEdges : fact.localCallEdges;
  const formattedLocalEdges = localEdges.map((edge) => `${formatSymbolLabel(edge.caller)} -> ${formatSymbolLabel(edge.callee)}`);
  const moduleEdges = fact.moduleCallees.map((value) => `imports ${value}`);
  const externalEdges = fact.externalCalls.map((value) => `${formatSymbolLabel(fact.entrySymbol || "<module>")} -> ${formatSymbolLabel(value)}`);

  return uniqueStrings([...formattedLocalEdges, ...moduleEdges, ...externalEdges]).slice(0, 6);
}

function buildLocalCallFlowSteps(fact: FileCodeFacts) {
  const localSymbolSet = new Set(
    uniqueStrings([
      ...fact.declaredSymbols.map((symbol) => symbol.name),
      ...fact.exportedSymbols.map((symbol) => symbol.name)
    ]).map((name) => lastSymbolSegment(name))
  );
  const edgesByCaller = new Map<string, LocalCallEdge[]>();

  for (const edge of fact.localCallEdges) {
    const caller = lastSymbolSegment(edge.caller);
    const existing = edgesByCaller.get(caller) || [];
    existing.push(edge);
    edgesByCaller.set(caller, existing);
  }

  const scoreEdge = (edge: LocalCallEdge) => {
    const calleeBase = lastSymbolSegment(edge.callee);
    return (
      (localSymbolSet.has(calleeBase) ? 8 : 0) +
      (isExternalishCallName(edge.callee) ? 6 : 0) +
      (/validate|load|fetch|query|request|save|write|send|publish|enqueue|parse|compile|build|render|create|close|update|delete|run/i.test(calleeBase) ? 4 : 0) +
      (edge.callee.includes(".") ? 1 : 0)
    );
  };

  const visited = new Set<string>();
  const steps: string[] = [];
  let current = fact.entrySymbol || lastSymbolSegment(fact.localCallEdges[0]?.caller || "");

  for (let depth = 0; depth < 4 && current; depth += 1) {
    const candidates = (edgesByCaller.get(lastSymbolSegment(current)) || [])
      .filter((edge) => !visited.has(`${edge.caller}->${edge.callee}`))
      .sort((left, right) => scoreEdge(right) - scoreEdge(left));

    const next = candidates[0];
    if (!next) break;

    steps.push(`${formatSymbolLabel(next.caller)} -> ${formatSymbolLabel(next.callee)}`);
    visited.add(`${next.caller}->${next.callee}`);

    const calleeBase = lastSymbolSegment(next.callee);
    if (!localSymbolSet.has(calleeBase) || calleeBase === lastSymbolSegment(current)) {
      break;
    }

    current = calleeBase;
  }

  return uniqueStrings(steps);
}

function chooseEntrypointSymbol(input: {
  relativePath: string;
  isEntrypoint: boolean;
  isHandler: boolean;
  declaredSymbols: CodeSymbol[];
  exportedSymbols: CodeSymbol[];
  localFunctionSymbols: Set<string>;
  internalCallEdges: LocalCallEdge[];
}) {
  const runtimeNamePriority = ["main", "run", "start", "bootstrap", "handler", "execute", "init", "cli"];
  const functionSymbols = uniqueStrings(
    [
      ...input.exportedSymbols.filter((symbol) => symbol.kind === "function").map((symbol) => symbol.name),
      ...input.declaredSymbols.filter((symbol) => symbol.kind === "function").map((symbol) => symbol.name)
    ].map((name) => lastSymbolSegment(name))
  );
  const classSymbols = uniqueStrings(
    [
      ...input.exportedSymbols.filter((symbol) => symbol.kind === "class").map((symbol) => symbol.name),
      ...input.declaredSymbols.filter((symbol) => symbol.kind === "class").map((symbol) => symbol.name)
    ].map((name) => lastSymbolSegment(name))
  );
  const variableSymbols = uniqueStrings(
    [
      ...input.exportedSymbols.filter((symbol) => symbol.kind === "variable").map((symbol) => symbol.name),
      ...input.declaredSymbols.filter((symbol) => symbol.kind === "variable").map((symbol) => symbol.name)
    ].map((name) => lastSymbolSegment(name))
  );

  const bootstrapTargets = uniqueStrings(
    input.internalCallEdges
      .filter((edge) => edge.caller === "<module>")
      .map((edge) => lastSymbolSegment(edge.callee))
      .filter((name) => input.localFunctionSymbols.has(name))
  );

  if (input.isHandler) {
    const httpMethod = input.exportedSymbols.find((symbol) => ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(symbol.name));
    if (httpMethod) {
      return httpMethod.name;
    }
  }

  for (const preferred of runtimeNamePriority) {
    if (bootstrapTargets.includes(preferred)) return preferred;
    if (functionSymbols.includes(preferred)) return preferred;
    if (classSymbols.includes(preferred)) return preferred;
  }

  if (bootstrapTargets[0]) return bootstrapTargets[0];

  const stemTokens = fileStemTokens(input.relativePath);
  const byStemMatch = functionSymbols.find((name) =>
    stemTokens.some((token) => name.toLowerCase().includes(token))
  );
  if (byStemMatch) return byStemMatch;

  const preferredByPath = [...functionSymbols, ...classSymbols].find((name) => input.relativePath.toLowerCase().includes(name.toLowerCase()));
  if (input.isEntrypoint && preferredByPath) return preferredByPath;

  if (functionSymbols[0]) return functionSymbols[0];
  if (!input.isEntrypoint && classSymbols[0]) return classSymbols[0];
  if (!input.isEntrypoint && variableSymbols[0]) return variableSymbols[0];
  return undefined;
}

function prioritizeInternalCallEdges(edges: LocalCallEdge[], localFunctionSymbols: Set<string>) {
  const score = (edge: LocalCallEdge) => {
    const calleeBase = lastSymbolSegment(edge.callee);
    return (
      (edge.caller === "<module>" && localFunctionSymbols.has(calleeBase) ? 30 : 0) +
      (localFunctionSymbols.has(calleeBase) ? 14 : 0) +
      (isExternalishCallName(edge.callee) ? 8 : 0) +
      (/main|run|start|bootstrap|handler|execute|init|load|fetch|query|request|save|send|publish|enqueue|parse|compile|build|close|update|delete/i.test(calleeBase) ? 5 : 0) +
      (edge.callee.includes(".") ? 1 : 0)
    );
  };

  return [...edges].sort((left, right) => score(right) - score(left));
}

function extractConfigTouches(content: string) {
  return uniqueStrings([
    ...Array.from(content.matchAll(/process\.env\.([A-Z0-9_]+)/g)).map((match) => `process.env.${match[1]}`),
    ...Array.from(content.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)).map((match) => `import.meta.env.${match[1]}`),
    ...Array.from(content.matchAll(/(?:os\.getenv|os\.environ(?:\.get)?)\(["']([^"']+)["']/g)).map((match) => `env:${match[1]}`)
  ]).slice(0, 8);
}

function extractExternalCalls(content: string, localCalls: string[]) {
  const matches = [
    ...Array.from(content.matchAll(/\b(fetch|axios|httpx|requests|boto3|redis|prisma|supabase|amqp|kafka|sqs|sns|sqlalchemy)\b/gi)).map((match) => match[1]),
    ...localCalls.filter((name) => /fetch|axios|request|client|redis|prisma|query|publish|send|enqueue|cache/i.test(name))
  ];

  return uniqueStrings(matches).slice(0, 8);
}

function inferFrameworkRole(filePath: string, exportedSymbols: CodeSymbol[], localCalls: string[], isEntrypointHint = false, isHandlerHint = false) {
  const lower = filePath.toLowerCase();

  if (isHandlerHint || /\/api\/|route\.(t|j)sx?$|controller|router|handler/.test(lower)) return "API handler";
  if (/page\.(t|j)sx?$|layout\.(t|j)sx?$|component|view/.test(lower)) return "UI entry";
  if (/server|main|cli|worker|bin/.test(lower) || isEntrypointHint) return "Runtime entry";
  if (/config|package\.json|dockerfile|pom\.xml|pyproject\.toml|settings/.test(lower)) return "Configuration module";
  if (/schema|types|model|contract/.test(lower)) return "Contract module";
  if (/service|client|gateway|adapter|provider|lib/.test(lower)) return "Service module";
  if (/store|cache|db|repository|dao/.test(lower)) return "Data access module";
  if (exportedSymbols.some((symbol) => /^[A-Z]/.test(symbol.name)) && /\.(tsx|jsx)$/.test(lower)) return "React component";
  if (localCalls.some((name) => /render|createRoot|hydrate/i.test(name))) return "UI module";

  return "Module";
}

function analyzeJsTsFile(relativePath: string, content: string): RawFactResult {
  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, scriptKindFromPath(relativePath));
  const declaredSymbols: CodeSymbol[] = [];
  const exportedSymbols: CodeSymbol[] = [];
  const imports: string[] = [];
  const localCalls: string[] = [];
  const localCallEdges: LocalCallEdge[] = [];
  const localFunctionSymbols = new Set<string>();
  const scopeStack: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      pushSymbol(declaredSymbols, statement.name?.text, "function");
      if (hasExportModifier(statement) || hasDefaultModifier(statement)) {
        pushSymbol(exportedSymbols, statement.name?.text || "default", "function");
      }
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      pushSymbol(declaredSymbols, statement.name?.text, "class");
      if (hasExportModifier(statement) || hasDefaultModifier(statement)) {
        pushSymbol(exportedSymbols, statement.name?.text || "default", "class");
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      pushSymbol(declaredSymbols, statement.name.text, "interface");
      if (hasExportModifier(statement)) {
        pushSymbol(exportedSymbols, statement.name.text, "interface");
      }
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      pushSymbol(declaredSymbols, statement.name.text, "type");
      if (hasExportModifier(statement)) {
        pushSymbol(exportedSymbols, statement.name.text, "type");
      }
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      pushSymbol(declaredSymbols, statement.name.text, "enum");
      if (hasExportModifier(statement)) {
        pushSymbol(exportedSymbols, statement.name.text, "enum");
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const names: string[] = [];
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      for (const name of names) {
        pushSymbol(declaredSymbols, name, "variable");
        if (hasExportModifier(statement)) {
          pushSymbol(exportedSymbols, name, "variable");
        }
      }
    }
  }

  const visit = (node: ts.Node) => {
    const scopeName = getFunctionScopeName(node);
    if (scopeName) {
      localFunctionSymbols.add(scopeName);
      scopeStack.push(scopeName);
    }

    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const calleeName = getCallExpressionName(expression);

      if (calleeName) {
        localCalls.push(calleeName);
        localCallEdges.push({
          caller: scopeStack[scopeStack.length - 1] || "<module>",
          callee: calleeName
        });
      }

      if (
        calleeName === "require" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        imports.push(node.arguments[0].text);
      }
    }

    ts.forEachChild(node, visit);

    if (scopeName) {
      scopeStack.pop();
    }
  };
  visit(sourceFile);

  const exportedNames = exportedSymbols.map((symbol) => symbol.name);
  const hasRouteRegistration = /\b(router|app)\.(get|post|put|patch|delete|options|head)\s*\(/i.test(content);
  const isHandler =
    /\/api\/|route\.(t|j)sx?$|controller|router|handler/.test(relativePath.toLowerCase()) ||
    exportedNames.some((name) => ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(name)) ||
    hasRouteRegistration;
  const isEntrypoint =
    content.startsWith("#!") ||
    /(^|\/)(main|server|app|cli|worker|bin|index)\.(t|j)sx?$/.test(relativePath) ||
    /(^|\/)(page|layout|route)\.(t|j)sx?$/.test(relativePath) ||
    isHandler;

  const frameworkRole = inferFrameworkRole(relativePath, exportedSymbols, localCalls, isEntrypoint, isHandler);
  const internalCallEdges = prioritizeInternalCallEdges(
    uniqueCallEdges(
    localCallEdges.filter((edge) => {
      const calleeBase = lastSymbolSegment(edge.callee);
      return edge.callee !== edge.caller && (localFunctionSymbols.has(calleeBase) || edge.callee.includes(".") || isExternalishCallName(edge.callee));
    })
    ),
    localFunctionSymbols
  ).slice(0, 16);
  const entrySymbol = chooseEntrypointSymbol({
    relativePath,
    isEntrypoint,
    isHandler,
    declaredSymbols,
    exportedSymbols,
    localFunctionSymbols,
    internalCallEdges
  });

  return {
    path: relativePath,
    language: deriveLanguageFromPath(relativePath),
    frameworkRole,
    declaredSymbols: uniqueByName(declaredSymbols).slice(0, 12),
    exportedSymbols: uniqueByName(exportedSymbols).slice(0, 10),
    imports: uniqueStrings(imports).slice(0, 24),
    localCalls: uniqueStrings(localCalls).slice(0, 24),
    localCallEdges: internalCallEdges,
    configTouches: extractConfigTouches(content),
    externalCalls: extractExternalCalls(content, localCalls),
    isEntrypoint,
    isHandler,
    entrySymbol
  };
}

function uniqueByName(symbols: CodeSymbol[]) {
  const seen = new Set<string>();
  const output: CodeSymbol[] = [];

  for (const symbol of symbols) {
    const key = `${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(symbol);
  }

  return output;
}

async function analyzePythonFile(rootPath: string, relativePath: string): Promise<RawFactResult | null> {
  try {
    const absolutePath = path.join(rootPath, relativePath);
    const scriptPath = path.join(process.cwd(), "scripts", "extract_python_facts.py");
    const { stdout } = await execFileAsync("python3", [scriptPath, absolutePath], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024
    });

    const parsed = JSON.parse(stdout) as {
      language?: string;
      frameworkRole?: string;
      declaredSymbols?: CodeSymbol[];
      exportedSymbols?: CodeSymbol[];
      imports?: string[];
      localCalls?: string[];
      configTouches?: string[];
      externalCalls?: string[];
      isEntrypoint?: boolean;
      isHandler?: boolean;
    };

    return {
      path: relativePath,
      language: parsed.language || "Python",
      frameworkRole: parsed.frameworkRole || "Python module",
      declaredSymbols: uniqueByName(Array.isArray(parsed.declaredSymbols) ? parsed.declaredSymbols : []).slice(0, 12),
      exportedSymbols: uniqueByName(Array.isArray(parsed.exportedSymbols) ? parsed.exportedSymbols : []).slice(0, 10),
      imports: uniqueStrings(Array.isArray(parsed.imports) ? parsed.imports : []).slice(0, 24),
      localCalls: uniqueStrings(Array.isArray(parsed.localCalls) ? parsed.localCalls : []).slice(0, 24),
      localCallEdges: uniqueCallEdges(Array.isArray(parsed.localCallEdges) ? parsed.localCallEdges : []).slice(0, 16),
      configTouches: uniqueStrings(Array.isArray(parsed.configTouches) ? parsed.configTouches : []).slice(0, 8),
      externalCalls: uniqueStrings(Array.isArray(parsed.externalCalls) ? parsed.externalCalls : []).slice(0, 8),
      isEntrypoint: Boolean(parsed.isEntrypoint),
      isHandler: Boolean(parsed.isHandler),
      entrySymbol: typeof parsed.entrySymbol === "string" ? parsed.entrySymbol : undefined
    };
  } catch {
    return null;
  }
}

function maybeResolveInternalImport(specifier: string, fromPath: string, availablePaths: Set<string>) {
  const normalized = specifier.trim();
  if (!normalized) return null;

  if (!normalized.startsWith(".") && !normalized.startsWith("@/") && !normalized.startsWith("~/")) {
    return null;
  }

  const currentDir = path.posix.dirname(fromPath);
  let base = normalized;

  if (normalized.startsWith("@/")) {
    base = `src/${normalized.slice(2)}`;
  } else if (normalized.startsWith("~/")) {
    base = normalized.slice(2);
  } else {
    base = path.posix.normalize(path.posix.join(currentDir, normalized));
  }

  return resolveCandidatePath(base, availablePaths);
}

function maybeResolvePythonImport(specifier: string, fromPath: string, availablePaths: Set<string>) {
  const normalized = specifier.trim();
  if (!normalized) return null;

  if (normalized.startsWith(".")) {
    const level = normalized.match(/^\.+/)?.[0].length || 1;
    const remainder = normalized.slice(level).replace(/\./g, "/");
    const currentDir = path.posix.dirname(fromPath).split("/").filter(Boolean);
    const targetDir = currentDir.slice(0, Math.max(0, currentDir.length - (level - 1)));
    const base = [...targetDir, remainder].filter(Boolean).join("/");
    return resolveCandidatePath(base, availablePaths);
  }

  return resolveCandidatePath(normalized.replace(/\./g, "/"), availablePaths);
}

function resolveCandidatePath(base: string, availablePaths: Set<string>) {
  const candidates = [
    base,
    ...IMPORT_RESOLUTION_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...IMPORT_RESOLUTION_EXTENSIONS.map((extension) => path.posix.join(base, `index${extension}`)),
    path.posix.join(base, "__init__.py")
  ];

  for (const candidate of candidates) {
    const normalized = toPosixPath(candidate);
    if (availablePaths.has(normalized)) {
      return normalized;
    }
  }

  return null;
}

function buildFileDiagram(fact: FileCodeFacts, factsByPath: Record<string, FileCodeFacts>): DiagramGraph {
  const nodes: DiagramGraph["nodes"] = [
    {
      id: "current",
      label: fact.path,
      kind: diagramKindForRole(fact.path, fact.frameworkRole, fact.isEntrypoint),
      note: fact.frameworkRole
    }
  ];
  const edges: DiagramGraph["edges"] = [];

  for (const caller of fact.moduleCallers.slice(0, 3)) {
    const callerFact = factsByPath[caller];
    const id = `caller-${nodes.length}`;
    nodes.push({
      id,
      label: caller,
      kind: callerFact ? diagramKindForRole(caller, callerFact.frameworkRole, callerFact.isEntrypoint) : "module",
      note: "Imports or orchestrates this file"
    });
    edges.push({ from: id, to: "current", label: "calls or imports" });
  }

  for (const callee of fact.moduleCallees.slice(0, 4)) {
    const calleeFact = factsByPath[callee];
    const id = `callee-${nodes.length}`;
    nodes.push({
      id,
      label: callee,
      kind: calleeFact ? diagramKindForRole(callee, calleeFact.frameworkRole, calleeFact.isEntrypoint) : "module",
      note: "Called or imported from this file"
    });
    edges.push({ from: "current", to: id, label: "calls or imports" });
  }

  if (fact.entrySymbol) {
    const entryId = `entry-${nodes.length}`;
    nodes.push({
      id: entryId,
      label: fact.entrySymbol,
      kind: fact.isEntrypoint ? "entry" : "service",
      note: "Primary local execution symbol"
    });
    edges.push({ from: "current", to: entryId, label: "defines" });

    for (const edge of fact.localCallEdges.filter((item) => item.caller === fact.entrySymbol).slice(0, 3)) {
      const targetId = `local-${nodes.length}`;
      nodes.push({
        id: targetId,
        label: edge.callee,
        kind: /config|env/i.test(edge.callee) ? "config" : /fetch|client|request|query|publish|send/i.test(edge.callee) ? "external" : "service",
        note: "Local call flow"
      });
      edges.push({ from: entryId, to: targetId, label: "invokes" });
    }
  }

  if (fact.configTouches[0]) {
    nodes.push({
      id: `config-${nodes.length}`,
      label: fact.configTouches[0],
      kind: "config",
      note: "Configuration or env touch point"
    });
    edges.push({ from: `config-${nodes.length - 1}`, to: "current", label: "configures" });
  }

  if (fact.externalCalls[0]) {
    nodes.push({
      id: `external-${nodes.length}`,
      label: fact.externalCalls[0],
      kind: "external",
      note: "External integration hint"
    });
    edges.push({ from: "current", to: `external-${nodes.length - 1}`, label: "reaches" });
  }

  return {
    nodes: nodes.slice(0, 12),
    edges: edges.slice(0, 18)
  };
}

function buildEvidenceCardsForFile(fact: FileCodeFacts): EvidenceCard[] {
  const cards: EvidenceCard[] = [];

  if (fact.isEntrypoint) {
    cards.push({
      title: "Entrypoint signal",
      path: fact.path,
      kind: "entrypoint",
      evidence: `${fact.path} is recognized as a runtime or route entry based on its filename and exported surface.`,
      whyItMatters: "이 파일을 먼저 보면 실행이 어디서 시작되는지와 초기 orchestration 경로를 빠르게 파악할 수 있습니다."
    });
  }

  if (fact.isHandler) {
    cards.push({
      title: "Handler boundary",
      path: fact.path,
      kind: "handler",
      evidence: `${fact.path} shows route/controller-like signals and handler-shaped exports.`,
      whyItMatters: "외부 요청이 내부 로직으로 연결되는 경계면이어서 전체 pipeline을 이해할 때 중요합니다."
    });
  }

  if (fact.configTouches[0]) {
    cards.push({
      title: "Configuration touch",
      path: fact.path,
      kind: "config",
      evidence: truncate(`Touches ${fact.configTouches.join(", ")}`, 120),
      whyItMatters: "환경 변수나 설정 소비 지점은 실행 조건과 배포 영향을 추적할 때 중요한 근거가 됩니다."
    });
  }

  if (fact.externalCalls[0]) {
    cards.push({
      title: "External integration",
      path: fact.path,
      kind: "external call",
      evidence: truncate(`Signals external systems through ${fact.externalCalls.join(", ")}`, 120),
      whyItMatters: "이 파일이 외부 API, DB, queue 같은 바깥 경계와 만나는 지점일 가능성이 높습니다."
    });
  }

  if (fact.localCallEdges[0]) {
    cards.push({
      title: "Local execution flow",
      path: fact.path,
      symbol: fact.entrySymbol || fact.localCallEdges[0].caller,
      kind: "service",
      evidence: truncate(
        buildLocalCallFlowSteps(fact).join(", "),
        120
      ),
      whyItMatters: "파일 안에서 어떤 함수가 다음 함수로 이어지는지 보이면 실제 로직 흐름을 훨씬 빠르게 이해할 수 있습니다."
    });
  }

  const keySymbol = fact.exportedSymbols[0] || fact.declaredSymbols[0];
  if (keySymbol) {
    cards.push({
      title: "Key symbol",
      path: fact.path,
      symbol: keySymbol.name,
      kind: /store|state|cache/i.test(keySymbol.name) ? "state" : "service",
      evidence: `${keySymbol.kind} ${keySymbol.name} is one of the first visible symbols in this file.`,
      whyItMatters: "핵심 심볼을 따라가면 이 파일의 책임과 호출 흐름을 가장 빠르게 이해할 수 있습니다."
    });
  }

  return cards.slice(0, 6);
}

function chooseNextFlowTarget(current: FileCodeFacts, factsByPath: Record<string, FileCodeFacts>, visited: Set<string>) {
  const candidates = current.moduleCallees
    .map((candidatePath) => factsByPath[candidatePath])
    .filter((candidate): candidate is FileCodeFacts => Boolean(candidate) && !visited.has(candidate.path));

  if (!candidates.length) return null;

  return candidates.sort((left, right) => scoreFact(right, factsByPath) - scoreFact(left, factsByPath))[0] || null;
}

function scoreFact(fact: FileCodeFacts, factsByPath: Record<string, FileCodeFacts>) {
  const base =
    (fact.isEntrypoint ? 6 : 0) +
    (fact.isHandler ? 5 : 0) +
    (/service/i.test(fact.frameworkRole) ? 4 : 0) +
    (/data/i.test(fact.frameworkRole) ? 3 : 0) +
    fact.moduleCallers.length +
    fact.moduleCallees.length +
    fact.localCallEdges.length;

  return base + (factsByPath[fact.path]?.externalCalls.length || 0);
}

function buildLogicFlows(entrypoints: CodeEntrypoint[], factsByPath: Record<string, FileCodeFacts>) {
  const flows: CodeLogicFlow[] = [];

  for (const entrypoint of entrypoints.slice(0, 4)) {
    const fact = factsByPath[entrypoint.path];
    if (!fact) continue;

    const visited = new Set<string>([fact.path]);
    const steps = uniqueStrings([
      `${fact.path} (${fact.frameworkRole})`,
      ...buildLocalCallFlowSteps(fact)
    ]);
    let current = fact;

    for (let depth = 0; depth < 3; depth += 1) {
      const next = chooseNextFlowTarget(current, factsByPath, visited);
      if (!next) break;
      visited.add(next.path);
      steps.push(`${next.path} (${next.frameworkRole})`);
      current = next;
    }

    if (current.externalCalls[0]) {
      steps.push(`external:${current.externalCalls[0]}`);
    } else if (current.configTouches[0]) {
      steps.push(`config:${current.configTouches[0]}`);
    }

    flows.push({
      title: `${baseName(entrypoint.path)} logic flow`,
      steps: uniqueStrings(steps).slice(0, 5)
    });
  }

  return flows;
}

function buildReadingOrder(entrypoints: CodeEntrypoint[], summary: ModuleGraphSummary, factsByPath: Record<string, FileCodeFacts>) {
  const orderedPaths = uniqueStrings([
    ...entrypoints.map((item) => item.path),
    ...summary.highFanOutModules,
    ...summary.configSurfaces
  ]).slice(0, 6);

  return orderedPaths.map((filePath, index) => {
    const fact = factsByPath[filePath];
    return {
      path: filePath,
      why:
        index === 0
          ? "실행 진입점 또는 대표 엔트리입니다."
          : fact?.isHandler
            ? "외부 요청이나 이벤트가 내부 로직으로 연결되는 경계입니다."
            : fact?.configTouches[0]
              ? "런타임 동작을 바꾸는 설정 소비 지점입니다."
              : "호출/의존 관계상 중심성이 높아 전체 구조 이해에 도움이 됩니다."
    };
  });
}

function buildRepoDiagram(
  entrypoints: CodeEntrypoint[],
  summary: ModuleGraphSummary,
  factsByPath: Record<string, FileCodeFacts>
): DiagramGraph {
  const nodes: DiagramGraph["nodes"] = [];
  const edges: DiagramGraph["edges"] = [];
  const used = new Set<string>();

  const pushNode = (label: string, kind: DiagramGraph["nodes"][number]["kind"], note: string) => {
    const id = `node-${nodes.length}`;
    if (used.has(label) || nodes.length >= 12) {
      return null;
    }
    used.add(label);
    nodes.push({ id, label, kind, note });
    return id;
  };

  const entryIds = new Map<string, string>();
  for (const entrypoint of entrypoints.slice(0, 4)) {
    const fact = factsByPath[entrypoint.path];
    const id = pushNode(
      entrypoint.path,
      diagramKindForRole(entrypoint.path, fact?.frameworkRole || entrypoint.kind, true),
      entrypoint.why
    );
    if (id) entryIds.set(entrypoint.path, id);
  }

  for (const filePath of summary.highFanOutModules.slice(0, 4)) {
    const fact = factsByPath[filePath];
    const id = pushNode(
      filePath,
      diagramKindForRole(filePath, fact?.frameworkRole || "Module", fact?.isEntrypoint || false),
      fact?.frameworkRole || "Module"
    );
    if (!id) continue;

    const sourceEntrypoint = entrypoints.find((entrypoint) => factsByPath[entrypoint.path]?.moduleCallees.includes(filePath));
    if (sourceEntrypoint && entryIds.has(sourceEntrypoint.path)) {
      edges.push({ from: entryIds.get(sourceEntrypoint.path)!, to: id, label: "flows to" });
    }
  }

  for (const external of summary.externalSystems.slice(0, 3)) {
    const externalId = pushNode(external, "external", "External integration");
    if (!externalId) continue;
    const source = Object.values(factsByPath).find((fact) => fact.externalCalls.includes(external));
    if (source) {
      const sourceId = [...nodes].find((node) => node.label === source.path)?.id;
      if (sourceId) edges.push({ from: sourceId, to: externalId, label: "reaches" });
    }
  }

  for (const configSurface of summary.configSurfaces.slice(0, 3)) {
    const configId = pushNode(configSurface, "config", "Configuration touch point");
    if (!configId) continue;
    const target = Object.values(factsByPath).find((fact) => fact.path === configSurface);
    const source = entrypoints.find((entrypoint) => factsByPath[entrypoint.path]?.moduleCallees.includes(configSurface));
    const sourceId = source ? entryIds.get(source.path) : [...nodes].find((node) => node.label === target?.path)?.id;
    if (sourceId) edges.push({ from: configId, to: sourceId, label: "configures" });
  }

  return {
    nodes,
    edges: edges.slice(0, 18)
  };
}

function buildModuleGraphSummary(factsByPath: Record<string, FileCodeFacts>) {
  const modules = Object.values(factsByPath);
  const ranked = [...modules].sort((left, right) => scoreFact(right, factsByPath) - scoreFact(left, factsByPath));
  const externalSystems = uniqueStrings(modules.flatMap((fact) => [...fact.externalCalls, ...fact.externalImports])).slice(0, 4);
  const configSurfaces = modules.filter((fact) => fact.configTouches.length > 0).map((fact) => fact.path).slice(0, 4);
  const highFanOutModules = ranked.map((fact) => fact.path).slice(0, 4);

  return {
    summary: `AST facts extracted from ${modules.length} files. ${highFanOutModules.length}개 중심 모듈과 ${externalSystems.length}개 외부 시스템, ${configSurfaces.length}개 설정 표면이 감지되었습니다.`,
    highFanOutModules,
    externalSystems,
    configSurfaces
  };
}

function buildRepoEvidenceCards(entrypoints: CodeEntrypoint[], summary: ModuleGraphSummary, factsByPath: Record<string, FileCodeFacts>) {
  const cards: EvidenceCard[] = [];

  for (const entrypoint of entrypoints.slice(0, 3)) {
    cards.push({
      title: "Runtime entrypoint",
      path: entrypoint.path,
      symbol: entrypoint.symbol,
      kind: "entrypoint",
      evidence: entrypoint.why,
      whyItMatters: "실행의 시작점이라 전체 pipeline과 orchestration을 추적할 때 가장 먼저 보는 경로입니다."
    });
  }

  for (const filePath of summary.highFanOutModules.slice(0, 2)) {
    const fact = factsByPath[filePath];
    if (!fact) continue;
    cards.push({
      title: "High-connectivity module",
      path: filePath,
      kind: /data/i.test(fact.frameworkRole) ? "state" : "service",
      evidence: `${filePath} has ${fact.moduleCallers.length} incoming module links, ${fact.moduleCallees.length} outgoing module links, and ${fact.localCallEdges.length} local call edges.`,
      whyItMatters: "이 모듈은 여러 흐름의 중간에서 orchestration 또는 공통 책임을 담당할 가능성이 높습니다."
    });
  }

  if (summary.externalSystems[0]) {
    const source = Object.values(factsByPath).find((fact) => fact.externalCalls.includes(summary.externalSystems[0]));
    if (source) {
      cards.push({
        title: "External boundary",
        path: source.path,
        kind: "external call",
        evidence: `${source.path} signals external integration through ${summary.externalSystems[0]}.`,
        whyItMatters: "외부 API, queue, DB 같은 시스템 경계는 아키텍처의 중요한 pipeline anchor입니다."
      });
    }
  }

  if (summary.configSurfaces[0]) {
    cards.push({
      title: "Config surface",
      path: summary.configSurfaces[0],
      kind: "config",
      evidence: `${summary.configSurfaces[0]} consumes runtime or build configuration values.`,
      whyItMatters: "설정 표면은 실행 조건, 배포 차이, 환경별 동작을 읽는 핵심 근거입니다."
    });
  }

  return cards.slice(0, 8);
}

function buildEntrypoints(factsByPath: Record<string, FileCodeFacts>) {
  const files = Object.values(factsByPath);

  return files
    .filter((fact) => fact.isEntrypoint)
    .sort((left, right) => scoreFact(right, factsByPath) - scoreFact(left, factsByPath))
    .slice(0, 6)
    .map((fact) => ({
      path: fact.path,
      kind: fact.frameworkRole,
      symbol: fact.entrySymbol || fact.exportedSymbols[0]?.name || fact.declaredSymbols[0]?.name,
      why: fact.isHandler
        ? "Route or handler-like exports and path structure indicate this is a request boundary."
        : `${fact.path} matches runtime/bootstrap naming and has entry-like orchestration signals.`
    }));
}

async function readSourceContent(rootPath: string, relativePath: string) {
  const absolutePath = path.join(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  if (stat.size > MAX_FACT_FILE_BYTES) {
    return null;
  }

  const content = await fs.readFile(absolutePath, "utf8");
  return content;
}

function prioritizePaths(paths: string[]) {
  return [...paths].sort((left, right) => scorePath(right) - scorePath(left) || left.localeCompare(right));
}

function scorePath(filePath: string) {
  const lower = filePath.toLowerCase();
  let score = 0;

  if (/page|route|server|main|app|cli|worker|api|controller/.test(lower)) score += 6;
  if (/package\.json|pyproject\.toml|settings|config/.test(lower)) score += 4;
  if (/src\//.test(lower)) score += 3;
  if (/test|spec/.test(lower)) score -= 2;

  return score;
}

async function collectSupportedPaths(rootPath: string, snapshot?: RepositorySnapshot) {
  const discovered: string[] = [];
  const visit = async (relativePath = ""): Promise<void> => {
    const absolutePath = relativePath ? path.join(rootPath, relativePath) : rootPath;
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await visit(childRelativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (ALL_EXTENSIONS.has(fileExtension(childRelativePath))) {
        discovered.push(childRelativePath);
      }
    }
  };

  await visit();

  const snapshotPaths = snapshot
    ? flattenTree(snapshot.tree)
        .filter((node) => node.type === "file" && ALL_EXTENSIONS.has(fileExtension(node.path)))
        .map((node) => node.path)
    : [];

  return prioritizePaths(uniqueStrings([...snapshotPaths, ...discovered])).slice(0, MAX_FACT_FILES);
}

function summarizeImports(imports: string[], relativePath: string, availablePaths: Set<string>) {
  const internalImports: string[] = [];
  const externalImports: string[] = [];

  for (const specifier of imports) {
    const resolved = specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("~/")
      ? maybeResolveInternalImport(specifier, relativePath, availablePaths)
      : maybeResolvePythonImport(specifier, relativePath, availablePaths);

    if (resolved) {
      internalImports.push(resolved);
      continue;
    }

    if (!specifier.startsWith(".")) {
      externalImports.push(specifier);
    }
  }

  return {
    internalImports: uniqueStrings(internalImports).slice(0, 10),
    externalImports: uniqueStrings(externalImports).slice(0, 10)
  };
}

async function buildRepositoryFacts(
  repositoryId: string,
  commitSha: string,
  rootPath: string,
  snapshot?: RepositorySnapshot
): Promise<RepositoryCodeFacts | null> {
  const filePaths = await collectSupportedPaths(rootPath, snapshot);
  if (!filePaths.length) {
    return null;
  }

  const rawFacts: RawFactResult[] = [];

  for (const relativePath of filePaths) {
    const content = await readSourceContent(rootPath, relativePath);
    if (!content) continue;

    const extension = fileExtension(relativePath);
    if (SUPPORTED_JS_TS_EXTENSIONS.has(extension)) {
      rawFacts.push(analyzeJsTsFile(relativePath, content));
      continue;
    }

    if (SUPPORTED_PY_EXTENSIONS.has(extension)) {
      const result = await analyzePythonFile(rootPath, relativePath);
      if (result) {
        rawFacts.push(result);
      }
    }
  }

  if (!rawFacts.length) {
    return null;
  }

  const availablePaths = new Set(rawFacts.map((fact) => fact.path));
  const factsByPath: Record<string, FileCodeFacts> = {};

  for (const rawFact of rawFacts) {
    const importSummary = summarizeImports(rawFact.imports, rawFact.path, availablePaths);

    factsByPath[rawFact.path] = {
      path: rawFact.path,
      language: rawFact.language,
      frameworkRole: rawFact.frameworkRole,
      declaredSymbols: rawFact.declaredSymbols,
      exportedSymbols: rawFact.exportedSymbols,
      imports: rawFact.imports,
      internalImports: importSummary.internalImports,
      externalImports: importSummary.externalImports,
      callers: [],
      callees: [],
      moduleCallers: [],
      moduleCallees: importSummary.internalImports,
      localCalls: rawFact.localCalls,
      localCallEdges: rawFact.localCallEdges,
      configTouches: rawFact.configTouches,
      externalCalls: rawFact.externalCalls,
      isEntrypoint: rawFact.isEntrypoint,
      isHandler: rawFact.isHandler,
      entrySymbol: rawFact.entrySymbol,
      diagram: { nodes: [], edges: [] },
      evidenceCards: []
    };
  }

  const reverseImports = new Map<string, string[]>();
  for (const fact of Object.values(factsByPath)) {
    for (const callee of fact.moduleCallees) {
      const existing = reverseImports.get(callee) || [];
      existing.push(fact.path);
      reverseImports.set(callee, existing);
    }
  }

  for (const fact of Object.values(factsByPath)) {
    fact.moduleCallers = uniqueStrings(reverseImports.get(fact.path) || []).slice(0, 10);
    fact.callers = buildDeveloperCallers(fact);
    fact.callees = buildDeveloperCallees(fact);
    fact.evidenceCards = buildEvidenceCardsForFile(fact);
    fact.diagram = buildFileDiagram(fact, factsByPath);
  }

  const entrypoints = buildEntrypoints(factsByPath);
  const moduleGraphSummary = buildModuleGraphSummary(factsByPath);
  const logicFlows = buildLogicFlows(entrypoints, factsByPath);
  const readingOrder = buildReadingOrder(entrypoints, moduleGraphSummary, factsByPath);
  const evidenceCards = buildRepoEvidenceCards(entrypoints, moduleGraphSummary, factsByPath);
  const diagram = buildRepoDiagram(entrypoints, moduleGraphSummary, factsByPath);
  const factLanguages = uniqueStrings(Object.values(factsByPath).map((fact) => fact.language));

  return {
    repositoryId,
    commitSha,
    cacheKey: `${FACTS_VERSION}:${repositoryId}:${commitSha}`,
    factLanguages,
    entrypoints,
    logicFlows,
    evidenceCards,
    moduleGraphSummary,
    readingOrder,
    diagram,
    files: factsByPath
  };
}

export async function loadOrBuildRepositoryFacts(input: {
  repositoryId: string;
  commitSha: string;
  rootPath: string;
  snapshot?: RepositorySnapshot;
}): Promise<RepositoryCodeFacts | null> {
  const cachePath = cachePathFor(input.repositoryId, input.commitSha);
  const expectedCacheKey = `${FACTS_VERSION}:${input.repositoryId}:${input.commitSha}`;

  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8")) as RepositoryCodeFacts;
    if (cached?.cacheKey === expectedCacheKey && cached.commitSha === input.commitSha) {
      return cached;
    }
  } catch {
    // rebuild below
  }

  try {
    const facts = await buildRepositoryFacts(input.repositoryId, input.commitSha, input.rootPath, input.snapshot);
    if (!facts) {
      return null;
    }

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(facts, null, 2), "utf8");
    return facts;
  } catch {
    return null;
  }
}

export function getFileFacts(facts: RepositoryCodeFacts | null | undefined, relativePath: string) {
  if (!facts) return null;
  return facts.files[relativePath] || null;
}
