import fs from "node:fs/promises";
import path from "node:path";
import {
  IGNORED_DIRECTORIES,
  IGNORED_FILE_EXTENSIONS,
  IMPORTANT_ENTRY_FILES,
  LANGUAGE_BY_EXTENSION,
  MAX_CONTEXT_FILES,
  MAX_DIRECTORY_CHILDREN,
  MAX_FILE_BYTES,
  MAX_REPRESENTATIVE_FILES,
  MAX_SOURCE_PREVIEW_CHARS,
  MAX_TREE_DEPTH
} from "@/lib/constants";
import { renderCodePreview } from "@/lib/highlight";
import { type CommitSummary } from "@/lib/git";
import { truncate, uniqueStrings } from "@/lib/utils";

export type RepositoryTreeNode = {
  name: string;
  path: string;
  type: "directory" | "file";
  extension: string | null;
  size: number | null;
  children?: RepositoryTreeNode[];
};

export type RepresentativeFile = {
  path: string;
  language: string;
  excerpt: string;
  lineCount: number;
};

export type RepositorySnapshot = {
  tree: RepositoryTreeNode[];
  totalFiles: number;
  totalDirectories: number;
  languages: { name: string; count: number }[];
  frameworks: string[];
  importantEntries: string[];
  representativeFiles: RepresentativeFile[];
  topLevelDirectories: string[];
};

export type FolderAnalysisContext = {
  path: string;
  childDirectories: string[];
  childFiles: string[];
  representativeFiles: RepresentativeFile[];
  recentCommits: CommitSummary[];
};

export type FileAnalysisContext = {
  path: string;
  language: string;
  lineCount: number;
  excerpt: string;
  fullContent: string;
  imports: string[];
  exportedSymbols: string[];
  recentCommits: CommitSummary[];
  sourcePreviewHtml: string;
};

function shouldIgnoreDirectory(name: string) {
  return IGNORED_DIRECTORIES.has(name);
}

function shouldIgnoreFile(relativePath: string, extension: string) {
  return IGNORED_FILE_EXTENSIONS.has(extension) || /\.min\.(js|css)$/i.test(relativePath);
}

async function isProbablyTextFile(absolutePath: string) {
  const handle = await fs.open(absolutePath, "r");
  const buffer = Buffer.alloc(1024);

  try {
    const { bytesRead } = await handle.read(buffer, 0, 1024, 0);
    const slice = buffer.subarray(0, bytesRead);
    return !slice.includes(0);
  } finally {
    await handle.close();
  }
}

async function scanDirectory(rootPath: string, relativePath = "", depth = 0): Promise<RepositoryTreeNode[]> {
  const absolutePath = relativePath ? path.join(rootPath, relativePath) : rootPath;
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });

  const sorted = entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_DIRECTORY_CHILDREN);

  const nodes: RepositoryTreeNode[] = [];

  for (const entry of sorted) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childAbsolutePath = path.join(rootPath, childRelativePath);

    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name)) {
        continue;
      }

      const children = depth >= MAX_TREE_DEPTH ? [] : await scanDirectory(rootPath, childRelativePath, depth + 1);
      nodes.push({
        name: entry.name,
        path: childRelativePath,
        type: "directory",
        extension: null,
        size: null,
        children
      });
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (shouldIgnoreFile(childRelativePath, extension)) {
      continue;
    }

    if (!(await isProbablyTextFile(childAbsolutePath))) {
      continue;
    }

    const stats = await fs.stat(childAbsolutePath);
    nodes.push({
      name: entry.name,
      path: childRelativePath,
      type: "file",
      extension: extension || null,
      size: stats.size
    });
  }

  return nodes;
}

export async function scanRepositoryTree(rootPath: string) {
  return scanDirectory(rootPath);
}

export function flattenTree(nodes: RepositoryTreeNode[]) {
  const output: RepositoryTreeNode[] = [];

  for (const node of nodes) {
    output.push(node);
    if (node.children) {
      output.push(...flattenTree(node.children));
    }
  }

  return output;
}

export function findTreeNode(nodes: RepositoryTreeNode[], relativePath: string): RepositoryTreeNode | null {
  for (const node of nodes) {
    if (node.path === relativePath) {
      return node;
    }

    if (node.children) {
      const match = findTreeNode(node.children, relativePath);
      if (match) {
        return match;
      }
    }
  }

  return null;
}

export function deriveLanguageFromPath(relativePath: string) {
  const extension = path.extname(relativePath).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] || "Text";
}

async function readTextFileExcerpt(absolutePath: string) {
  const content = await fs.readFile(absolutePath, "utf8");
  return content.slice(0, MAX_FILE_BYTES);
}

function countLines(content: string) {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

async function detectFrameworks(rootPath: string, flatNodes: RepositoryTreeNode[]) {
  const frameworks = new Set<string>();
  const nodePaths = new Set(flatNodes.map((node) => node.path));

  if (nodePaths.has("next.config.js") || nodePaths.has("next.config.mjs") || nodePaths.has("src/app/page.tsx") || nodePaths.has("app/page.tsx")) {
    frameworks.add("Next.js");
    frameworks.add("React");
  }

  if (nodePaths.has("manage.py")) {
    frameworks.add("Django");
  }

  if (nodePaths.has("go.mod")) {
    frameworks.add("Go Modules");
  }

  if (nodePaths.has("Cargo.toml")) {
    frameworks.add("Cargo");
  }

  try {
    const packageJsonPath = path.join(rootPath, "package.json");
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const deps = new Set([
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.devDependencies || {})
    ]);

    if (deps.has("next")) frameworks.add("Next.js");
    if (deps.has("react")) frameworks.add("React");
    if (deps.has("express")) frameworks.add("Express");
    if (deps.has("fastify")) frameworks.add("Fastify");
    if (deps.has("nestjs")) frameworks.add("NestJS");
    if (deps.has("vite")) frameworks.add("Vite");
    if (deps.has("tailwindcss")) frameworks.add("Tailwind CSS");
    if (deps.has("prisma")) frameworks.add("Prisma");
  } catch {
    // ignore package.json detection failures
  }

  try {
    const pyproject = await fs.readFile(path.join(rootPath, "pyproject.toml"), "utf8");
    if (/fastapi/i.test(pyproject)) frameworks.add("FastAPI");
    if (/flask/i.test(pyproject)) frameworks.add("Flask");
  } catch {
    // ignore python manifest detection failures
  }

  return [...frameworks];
}

async function buildRepresentativeFiles(rootPath: string, flatNodes: RepositoryTreeNode[]) {
  const files = flatNodes.filter((node) => node.type === "file");
  const importantMatches = IMPORTANT_ENTRY_FILES.filter((candidate) => files.some((file) => file.path === candidate));
  const fallbackFiles = files
    .filter((file) => /\.(ts|tsx|js|jsx|py|go|rs|java|kt)$/i.test(file.path))
    .slice(0, MAX_REPRESENTATIVE_FILES);

  const selected = uniqueStrings([...importantMatches, ...fallbackFiles.map((file) => file.path)]).slice(0, MAX_REPRESENTATIVE_FILES);
  const output: RepresentativeFile[] = [];

  for (const relativePath of selected) {
    const absolutePath = path.join(rootPath, relativePath);
    try {
      const excerpt = await readTextFileExcerpt(absolutePath);
      output.push({
        path: relativePath,
        language: deriveLanguageFromPath(relativePath),
        excerpt,
        lineCount: countLines(excerpt)
      });
    } catch {
      continue;
    }
  }

  return output;
}

export async function buildRepositorySnapshot(rootPath: string): Promise<RepositorySnapshot> {
  const tree = await scanRepositoryTree(rootPath);
  const flatNodes = flattenTree(tree);
  const fileNodes = flatNodes.filter((node) => node.type === "file");
  const directoryNodes = flatNodes.filter((node) => node.type === "directory");
  const languageCount = new Map<string, number>();

  for (const file of fileNodes) {
    const language = deriveLanguageFromPath(file.path);
    languageCount.set(language, (languageCount.get(language) || 0) + 1);
  }

  const languages = [...languageCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const frameworks = await detectFrameworks(rootPath, flatNodes);
  const importantEntries = IMPORTANT_ENTRY_FILES.filter((candidate) => fileNodes.some((file) => file.path === candidate));
  const representativeFiles = await buildRepresentativeFiles(rootPath, flatNodes);

  return {
    tree,
    totalFiles: fileNodes.length,
    totalDirectories: directoryNodes.length,
    languages,
    frameworks,
    importantEntries,
    representativeFiles,
    topLevelDirectories: tree.filter((node) => node.type === "directory").map((node) => node.path)
  };
}

export function extractImports(content: string) {
  const imports = new Set<string>();
  const jsMatches = content.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g);
  const pyMatches = content.matchAll(/(?:from\s+([\w./-]+)\s+import|import\s+([\w.,\s]+))/g);

  for (const match of jsMatches) {
    if (match[1]) imports.add(match[1]);
  }

  for (const match of pyMatches) {
    if (match[1]) imports.add(match[1]);
    if (match[2]) imports.add(match[2].split(",")[0].trim());
  }

  return [...imports].slice(0, 24);
}

export function extractExportedSymbols(content: string) {
  const exported = new Set<string>();

  const jsMatches = content.matchAll(/export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+([A-Za-z0-9_]+)/g);
  const pyMatches = content.matchAll(/^(?:async\s+def|def|class)\s+([A-Za-z0-9_]+)/gm);

  for (const match of jsMatches) {
    if (match[1]) exported.add(match[1]);
  }

  for (const match of pyMatches) {
    if (match[1]) exported.add(match[1]);
  }

  return [...exported].slice(0, 20);
}

export async function buildFolderAnalysisContext(
  rootPath: string,
  snapshot: RepositorySnapshot,
  relativePath: string,
  recentCommits: CommitSummary[]
): Promise<FolderAnalysisContext> {
  const node = findTreeNode(snapshot.tree, relativePath);
  if (!node || node.type !== "directory") {
    throw new Error(`Folder not found: ${relativePath}`);
  }

  const descendants = flattenTree(node.children || []);
  const childDirectories = (node.children || []).filter((child) => child.type === "directory").map((child) => child.path);
  const childFiles = (node.children || []).filter((child) => child.type === "file").map((child) => child.path);

  const representativeFiles: RepresentativeFile[] = [];
  for (const file of descendants.filter((candidate) => candidate.type === "file").slice(0, MAX_CONTEXT_FILES)) {
    try {
      const excerpt = await readTextFileExcerpt(path.join(rootPath, file.path));
      representativeFiles.push({
        path: file.path,
        language: deriveLanguageFromPath(file.path),
        excerpt,
        lineCount: countLines(excerpt)
      });
    } catch {
      continue;
    }
  }

  return {
    path: relativePath,
    childDirectories,
    childFiles,
    representativeFiles,
    recentCommits
  };
}

export async function buildFileAnalysisContext(
  rootPath: string,
  relativePath: string,
  recentCommits: CommitSummary[]
): Promise<FileAnalysisContext> {
  const absolutePath = path.join(rootPath, relativePath);
  const fullContent = await readTextFileExcerpt(absolutePath);
  const excerpt = fullContent.slice(0, MAX_SOURCE_PREVIEW_CHARS);
  const language = deriveLanguageFromPath(relativePath);

  return {
    path: relativePath,
    language,
    lineCount: countLines(fullContent),
    excerpt,
    fullContent,
    imports: extractImports(fullContent),
    exportedSymbols: extractExportedSymbols(fullContent),
    recentCommits,
    sourcePreviewHtml: await renderCodePreview(excerpt, language)
  };
}

export function createTreePayload(
  tree: RepositoryTreeNode[],
  readyPaths: Set<string>,
  pendingPaths: Set<string>
): import("@/lib/contracts").TreeNodePayload[] {
  return tree.map((node) => {
    const analysisState = readyPaths.has(node.path) ? "ready" : pendingPaths.has(node.path) ? "pending" : "missing";

    return {
      name: node.name,
      path: node.path,
      type: node.type,
      extension: node.extension,
      size: node.size,
      analysisState,
      children: node.children ? createTreePayload(node.children, readyPaths, pendingPaths) : undefined
    };
  });
}

export function summarizeRepresentativeFiles(files: RepresentativeFile[]) {
  return files.map((file) => ({
    path: file.path,
    language: file.language,
    excerpt: truncate(file.excerpt, 3000),
    lineCount: file.lineCount
  }));
}
