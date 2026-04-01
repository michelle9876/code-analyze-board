export function normalizeGitHubUrl(input: string) {
  const trimmed = input.trim();

  const sshMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") {
      throw new Error("GitHub URL만 지원합니다.");
    }

    const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("owner/repo 형식의 GitHub URL이 필요합니다.");
    }

    return `https://github.com/${parts[0]}/${parts[1]}`;
  } catch (error) {
    if (trimmed.startsWith("http")) {
      throw error;
    }

    throw new Error("유효한 GitHub URL을 입력해주세요.");
  }
}

export function parseGitHubUrl(input: string) {
  const canonicalUrl = normalizeGitHubUrl(input);
  const parts = canonicalUrl.replace("https://github.com/", "").split("/");

  return {
    canonicalUrl,
    owner: parts[0],
    name: parts[1]
  };
}

export function resolveGitHubCloneUrl(input: string) {
  const trimmed = input.trim();

  const sshMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return `ssh://git@github.com/${sshMatch[1]}/${sshMatch[2]}.git`;
  }

  const sshProtocolMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (sshProtocolMatch) {
    return `ssh://git@github.com/${sshProtocolMatch[1]}/${sshProtocolMatch[2]}.git`;
  }

  const canonicalUrl = normalizeGitHubUrl(trimmed);
  return `${canonicalUrl}.git`;
}
