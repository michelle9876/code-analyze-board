import { codeToHtml } from "shiki";

function normalizeLanguage(language: string) {
  const lower = language.toLowerCase();

  if (["ts", "tsx", "typescript"].includes(lower)) return "tsx";
  if (["js", "jsx", "javascript"].includes(lower)) return "jsx";
  if (["bash", "shell", "sh"].includes(lower)) return "bash";
  if (["yml", "yaml"].includes(lower)) return "yaml";
  if (lower === "md") return "markdown";

  return lower || "text";
}

export async function renderCodePreview(code: string, language: string) {
  try {
    return await codeToHtml(code, {
      lang: normalizeLanguage(language),
      theme: "github-light"
    });
  } catch {
    return await codeToHtml(code, {
      lang: "text",
      theme: "github-light"
    });
  }
}
