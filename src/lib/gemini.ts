import { loadEnvConfig } from "@next/env";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

let cachedClient: GoogleGenAI | null | undefined;

function ensureGeminiEnvLoaded() {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    if (process.env.GEMINI_API_KEY === "") {
      delete process.env.GEMINI_API_KEY;
    }

    if (process.env.GOOGLE_API_KEY === "") {
      delete process.env.GOOGLE_API_KEY;
    }

    loadEnvConfig(process.cwd());
  }
}

function buildApiKey() {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
}

export function getGeminiClient() {
  ensureGeminiEnvLoaded();

  if (cachedClient !== undefined) {
    return cachedClient;
  }

  const apiKey = buildApiKey();
  cachedClient = apiKey ? new GoogleGenAI({ apiKey }) : null;
  return cachedClient;
}

export function hasGeminiClient() {
  return Boolean(getGeminiClient());
}

type GenerateStructuredOutputParams<T extends z.ZodTypeAny> = {
  schema: T;
  schemaName: string;
  model: string;
  system: string;
  user: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  verbosity?: "low" | "medium" | "high";
  maxOutputTokens?: number;
};

const JSON_ONLY_RETRY_NOTE = [
  "Return a single valid JSON document only.",
  "Do not wrap the response in markdown or code fences.",
  "Keep every string concise.",
  "If the answer is long, shorten explanations instead of truncating JSON."
].join(" ");

const JSON_REPAIR_NOTE = [
  "You are repairing malformed JSON.",
  "Return one valid JSON document only.",
  "Preserve the same meaning, but shorten long strings if needed.",
  "Do not add markdown fences or extra commentary."
].join(" ");

function toResponseJsonSchema<T extends z.ZodTypeAny>(schema: T, schemaName: string) {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none"
  }) as Record<string, unknown>;

  delete jsonSchema.$schema;

  return jsonSchema;
}

function stripCodeFences(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

function extractBalancedJson(value: string) {
  const start = value.search(/[\[{]/);

  if (start === -1) {
    return null;
  }

  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;

      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseStructuredJson<T extends z.ZodTypeAny>(schema: T, value: string) {
  const attempts = [value, stripCodeFences(value)];
  const balanced = extractBalancedJson(stripCodeFences(value));

  if (balanced) {
    attempts.push(balanced);
  }

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      return schema.parse(JSON.parse(attempt));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export async function generateStructuredOutput<T extends z.ZodTypeAny>({
  schema,
  schemaName,
  model,
  system,
  user,
  maxOutputTokens = 4000
}: GenerateStructuredOutputParams<T>): Promise<z.infer<T>> {
  const client = getGeminiClient();

  if (!client) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const responseJsonSchema = toResponseJsonSchema(schema, schemaName);

  const generate = async (systemInstruction: string) =>
    client.models.generateContent({
      model,
      contents: user,
      config: {
        systemInstruction,
        maxOutputTokens,
        responseMimeType: "application/json",
        responseJsonSchema
      }
    });

  const repair = async (brokenJson: string) =>
    client.models.generateContent({
      model,
      contents: [
        "Repair the malformed JSON below so it becomes valid and matches the requested schema.",
        "",
        brokenJson
      ].join("\n"),
      config: {
        systemInstruction: `${system}\n\n${JSON_REPAIR_NOTE}`,
        maxOutputTokens,
        responseMimeType: "application/json",
        responseJsonSchema
      }
    });

  const initialResponse = await generate(system);
  const initialText =
    typeof initialResponse.text === "string"
      ? initialResponse.text
      : String(initialResponse.text || "");

  try {
    return parseStructuredJson(schema, initialText);
  } catch (initialError) {
    const retryResponse = await generate(`${system}\n\n${JSON_ONLY_RETRY_NOTE}`);
    const retryText =
      typeof retryResponse.text === "string"
        ? retryResponse.text
        : String(retryResponse.text || "");

    try {
      return parseStructuredJson(schema, retryText);
    } catch {
      const repairResponse = await repair(retryText || initialText);
      const repairText =
        typeof repairResponse.text === "string"
          ? repairResponse.text
          : String(repairResponse.text || "");

      try {
        return parseStructuredJson(schema, repairText);
      } catch {
        throw initialError;
      }
    }
  }
}
