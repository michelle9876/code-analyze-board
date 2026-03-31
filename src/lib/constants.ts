export const DEFAULT_CATEGORIES = [
  { name: "Frontend", color: "#165DFF", description: "UI, web app, interaction-heavy projects" },
  { name: "Backend", color: "#0F766E", description: "API, server, data pipeline projects" },
  { name: "AI/ML", color: "#9333EA", description: "Modeling, agents, AI-enabled systems" },
  { name: "DevTools", color: "#D95F3D", description: "CLI, tooling, build and developer workflow" },
  { name: "Infra", color: "#475569", description: "Deployment, infrastructure, platform work" },
  { name: "Library", color: "#8B5CF6", description: "Reusable packages and shared modules" }
] as const;

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  ".cache",
  ".idea",
  ".vscode",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  "dist",
  "build",
  "out",
  "node_modules",
  "vendor",
  "Pods",
  "target"
]);

export const IGNORED_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".mp3",
  ".wav",
  ".mp4",
  ".mov",
  ".ttf",
  ".woff",
  ".woff2",
  ".eot",
  ".jar",
  ".dll",
  ".so",
  ".dylib",
  ".exe",
  ".bin",
  ".pyc",
  ".lock"
]);

export const IMPORTANT_ENTRY_FILES = [
  "package.json",
  "README.md",
  "next.config.js",
  "next.config.mjs",
  "vite.config.ts",
  "vite.config.js",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "manage.py",
  "Dockerfile",
  "docker-compose.yml",
  "src/app/page.tsx",
  "src/index.ts",
  "src/main.ts",
  "app/page.tsx",
  "main.py"
];

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".scala": "Scala",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML",
  ".md": "Markdown",
  ".json": "JSON",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".sql": "SQL",
  ".sh": "Shell",
  ".bash": "Shell"
};

export const MAX_TREE_DEPTH = 6;
export const MAX_DIRECTORY_CHILDREN = 80;
export const MAX_FILE_BYTES = 24000;
export const MAX_REPRESENTATIVE_FILES = 8;
export const MAX_CONTEXT_FILES = 6;
export const MAX_SOURCE_PREVIEW_CHARS = 6000;
export const MAX_COMMITS_FOR_HISTORY = 20;
export const MAX_COMMITS_PER_PATH = 10;

export const MODEL_DEFAULTS = {
  repo: process.env.GEMINI_MODEL_REPO || "gemini-2.5-pro",
  deep: process.env.GEMINI_MODEL_DEEP || "gemini-2.5-flash",
  fast: process.env.GEMINI_MODEL_FAST || "gemini-2.5-flash-lite"
};
