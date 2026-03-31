import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function readEnvValue(key) {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return undefined;
  }

  const envContents = fs.readFileSync(envPath, "utf8");
  for (const line of envContents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const currentKey = trimmed.slice(0, separatorIndex).trim();
    if (currentKey !== key) {
      continue;
    }

    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    return rawValue.replace(/^['"]|['"]$/g, "");
  }

  return undefined;
}

function resolveSqliteFilePath(databaseUrl) {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(`Only SQLite file URLs are supported. Received: ${databaseUrl}`);
  }

  const sqliteRef = databaseUrl.slice("file:".length);
  if (!sqliteRef) {
    throw new Error("DATABASE_URL must point to a SQLite file.");
  }

  if (sqliteRef.startsWith("/")) {
    return sqliteRef;
  }

  return path.resolve(process.cwd(), "prisma", sqliteRef);
}

const databaseUrl = process.env.DATABASE_URL || readEnvValue("DATABASE_URL") || "file:./dev.db";
const databasePath = resolveSqliteFilePath(databaseUrl);

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const sql = `
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS "Category" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "Category_name_key" ON "Category"("name");

CREATE TABLE IF NOT EXISTS "Repository" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "owner" TEXT,
  "url" TEXT NOT NULL,
  "canonicalUrl" TEXT NOT NULL,
  "defaultBranch" TEXT,
  "clonePath" TEXT NOT NULL,
  "headCommitSha" TEXT,
  "status" TEXT NOT NULL DEFAULT 'IMPORTING',
  "errorMessage" TEXT,
  "quickSummary" TEXT,
  "architectureOverview" TEXT,
  "aiSuggestedCategory" TEXT,
  "aiTagsJson" TEXT,
  "detectedLanguagesJson" TEXT,
  "detectedFrameworksJson" TEXT,
  "importProgress" INTEGER NOT NULL DEFAULT 0,
  "lastAnalyzedAt" DATETIME,
  "categoryId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Repository_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Repository_canonicalUrl_key" ON "Repository"("canonicalUrl");
CREATE INDEX IF NOT EXISTS "Repository_status_updatedAt_idx" ON "Repository"("status", "updatedAt");

CREATE TABLE IF NOT EXISTS "AnalysisJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "repositoryId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "scope" TEXT,
  "path" TEXT,
  "force" BOOLEAN NOT NULL DEFAULT false,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "payloadJson" TEXT,
  "errorMessage" TEXT,
  "startedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalysisJob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AnalysisJob_status_priority_createdAt_idx" ON "AnalysisJob"("status", "priority", "createdAt");
CREATE INDEX IF NOT EXISTS "AnalysisJob_repositoryId_type_scope_path_idx" ON "AnalysisJob"("repositoryId", "type", "scope", "path");

CREATE TABLE IF NOT EXISTS "AnalysisArtifact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "repositoryId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "path" TEXT NOT NULL DEFAULT '',
  "commitSha" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'READY',
  "summary" TEXT,
  "markdown" TEXT,
  "dataJson" TEXT NOT NULL,
  "sourceExcerpt" TEXT,
  "metadataJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalysisArtifact_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AnalysisArtifact_repositoryId_scope_path_commitSha_key" ON "AnalysisArtifact"("repositoryId", "scope", "path", "commitSha");
CREATE INDEX IF NOT EXISTS "AnalysisArtifact_repositoryId_scope_path_idx" ON "AnalysisArtifact"("repositoryId", "scope", "path");
`;

execFileSync("sqlite3", [databasePath], {
  input: sql,
  stdio: ["pipe", "inherit", "inherit"]
});

console.log(`SQLite schema ensured at ${databasePath}`);
