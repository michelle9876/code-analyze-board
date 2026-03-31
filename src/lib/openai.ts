import { loadEnvConfig } from "@next/env";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

let cachedClient: OpenAI | null | undefined;

function ensureOpenAIEnvLoaded() {
  if (!process.env.OPENAI_API_KEY) {
    if (process.env.OPENAI_API_KEY === "") {
      delete process.env.OPENAI_API_KEY;
    }

    loadEnvConfig(process.cwd());
  }
}

export function getOpenAIClient() {
  ensureOpenAIEnvLoaded();

  if (cachedClient !== undefined) {
    return cachedClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  cachedClient = apiKey ? new OpenAI({ apiKey }) : null;
  return cachedClient;
}

export function hasOpenAIClient() {
  return Boolean(getOpenAIClient());
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

function extractParsedResponse<T extends z.ZodTypeAny>(schema: T, response: any) {
  for (const output of response.output ?? []) {
    if (output.type !== "message") {
      continue;
    }

    for (const item of output.content ?? []) {
      if (item.type === "refusal") {
        throw new Error(item.refusal || "Model refused to answer.");
      }

      if ("parsed" in item && item.parsed) {
        return schema.parse(item.parsed);
      }

      if (item.type === "output_text" && typeof item.text === "string") {
        try {
          return schema.parse(JSON.parse(item.text));
        } catch {
          continue;
        }
      }
    }
  }

  if (typeof response.output_text === "string") {
    return schema.parse(JSON.parse(response.output_text));
  }

  throw new Error("Structured output parse failed.");
}

export async function generateStructuredOutput<T extends z.ZodTypeAny>({
  schema,
  schemaName,
  model,
  system,
  user,
  reasoningEffort,
  verbosity = "medium",
  maxOutputTokens = 4000
}: GenerateStructuredOutputParams<T>): Promise<z.infer<T>> {
  const client = getOpenAIClient();

  if (!client) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await client.responses.parse({
    model,
    store: false,
    reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
    max_output_tokens: maxOutputTokens,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    text: {
      verbosity,
      format: zodTextFormat(schema, schemaName)
    }
  });

  return extractParsedResponse(schema, response);
}
