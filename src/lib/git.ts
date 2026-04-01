import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { MAX_COMMITS_FOR_HISTORY, MAX_COMMITS_PER_PATH } from "@/lib/constants";
import { parseGitHubUrl } from "@/lib/url";
import { hashString, slugify } from "@/lib/utils";

export type CommitSummary = {
  sha: string;
  author: string;
  date: string;
  message: string;
  changedPaths: string[];
};

function getRepoStorageRoot() {
  const configured = process.env.REPO_STORAGE_ROOT || "./data/repos";
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

export function getRepositoryClonePath(canonicalUrl: string) {
  const { owner, name } = parseGitHubUrl(canonicalUrl);
  return path.join(getRepoStorageRoot(), `${slugify(owner)}__${slugify(name)}-${hashString(canonicalUrl)}`);
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buildGitClient(baseDir?: string) {
  const client = baseDir ? simpleGit(baseDir) : simpleGit();

  client.env("GIT_TERMINAL_PROMPT", "0");
  client.env("GIT_ASKPASS", "/usr/bin/true");
  client.env("GCM_INTERACTIVE", "Never");

  return client;
}

function normalizeGitAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Git operation failed.");
  const lowered = message.toLowerCase();

  if (
    lowered.includes("could not read username") ||
    lowered.includes("could not read password") ||
    lowered.includes("authentication failed") ||
    lowered.includes("repository not found") ||
    lowered.includes("terminal prompts disabled")
  ) {
    return new Error("Git authentication is required for this repository. Public repos import immediately, but private repos need credentials or SSH access.");
  }

  return error instanceof Error ? error : new Error(message);
}

export async function ensureRepositoryClone(canonicalUrl: string, existingClonePath?: string) {
  const clonePath = existingClonePath || getRepositoryClonePath(canonicalUrl);
  await fs.mkdir(getRepoStorageRoot(), { recursive: true });

  try {
    if (await pathExists(path.join(clonePath, ".git"))) {
      const git = buildGitClient(clonePath);
      await git.fetch(["--all", "--prune"]);

      const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "HEAD");
      if (currentBranch !== "HEAD") {
        await git.pull("origin", currentBranch);
      }
    } else {
      await buildGitClient().clone(canonicalUrl, clonePath, ["--depth", "50"]);
    }
  } catch (error) {
    throw normalizeGitAuthError(error);
  }

  const git = buildGitClient(clonePath);
  const defaultBranch = await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "main");
  const headCommitSha = await git.revparse(["HEAD"]);

  return {
    clonePath,
    defaultBranch: defaultBranch === "HEAD" ? "main" : defaultBranch,
    headCommitSha
  };
}

export async function getHeadCommitSha(clonePath: string) {
  return buildGitClient(clonePath).revparse(["HEAD"]);
}

function parseCommitLog(raw: string) {
  const commits: CommitSummary[] = [];
  let current: CommitSummary | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.includes("\u001f")) {
      if (current) {
        commits.push(current);
      }

      const [sha, author, date, message] = trimmed.replace(/\u001e/g, "").split("\u001f");
      current = {
        sha,
        author,
        date,
        message,
        changedPaths: []
      };
      continue;
    }

    if (current) {
      current.changedPaths.push(trimmed.replace(/\u001e/g, ""));
    }
  }

  if (current) {
    commits.push(current);
  }

  return commits;
}

export async function readRecentCommits(clonePath: string, limit = MAX_COMMITS_FOR_HISTORY) {
  const git = buildGitClient(clonePath);
  const raw = await git.raw([
    "log",
    "--date=short",
    `--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1e`,
    "--name-only",
    "-n",
    String(limit)
  ]);

  return parseCommitLog(raw);
}

export async function readPathCommits(clonePath: string, relativePath: string, limit = MAX_COMMITS_PER_PATH) {
  const git = buildGitClient(clonePath);
  const raw = await git.raw([
    "log",
    "--date=short",
    `--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1e`,
    "--name-only",
    "-n",
    String(limit),
    "--",
    relativePath
  ]);

  return parseCommitLog(raw);
}
