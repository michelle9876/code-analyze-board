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

function toResponseJsonSchema<T extends z.ZodTypeAny>(schema: T, schemaName: string) {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none"
  }) as Record<string, unknown>;

  delete jsonSchema.$schema;

  return jsonSchema;
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

  const response = await client.models.generateContent({
    model,
    contents: user,
    config: {
      systemInstruction: system,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseJsonSchema: toResponseJsonSchema(schema, schemaName)
    }
  });

  const text = typeof response.text === "string" ? response.text : String(response.text || "");
  return schema.parse(JSON.parse(text));
}
