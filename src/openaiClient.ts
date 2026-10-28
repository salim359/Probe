import {
  GetParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { redactValue } from "./redact";

const parameterCache = new Map<string, string>();

export interface Diagnosis {
  summary: string;
  likely_causes: Array<{
    cause: string;
    confidence: string;
    evidence: string[];
  }>;
  supporting_evidence: string[];
  recommended_next_steps: string[];
  open_questions: string[];
  model?: string;
  error?: { code: string; message: string };
  mode?: string;
}

export async function getOpenAiApiKey(parameterName?: string): Promise<string> {
  const name = parameterName || process.env.OPENAI_PARAMETER_NAME;
  if (!name) throw new Error("OPENAI_PARAMETER_NAME is not configured");
  const cached = parameterCache.get(name);
  if (cached) return cached;

  const client = new SSMClient({});
  const resp = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  const raw = resp.Parameter?.Value ?? "";
  const key = parseParameterValue(raw);
  if (!key) throw new Error("OpenAI parameter is empty or missing api_key");
  parameterCache.set(name, key);
  return key;
}

function parseParameterValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      for (const field of ["api_key", "OPENAI_API_KEY", "openai_api_key", "key"]) {
        if (data[field]) return String(data[field]).trim();
      }
      return "";
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export async function analyzeEvidence(
  evidence: Record<string, unknown>,
  question?: string | null,
): Promise<Diagnosis> {
  const safe = redactValue(evidence);
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const apiKey = await getOpenAiApiKey();

  const system =
    "You are Probe, an AWS troubleshooting assistant with read-only evidence from " +
    "Lambda, CloudWatch Logs/Metrics, and CloudFormation. " +
    "Explain likely root causes using ONLY the provided evidence. " +
    "If evidence is insufficient, say so. " +
    "Do not invent resources, metrics, or log lines. " +
    "Never suggest destructive actions as the first step; prefer inspect/verify steps. " +
    "Respond with compact JSON only matching this schema: " +
    '{"summary": string, "likely_causes": [{"cause": string, "confidence": "high|medium|low", "evidence": [string]}], ' +
    '"supporting_evidence": [string], "recommended_next_steps": [string], "open_questions": [string]}';

  const resource = (safe as { resource?: { name?: string } }).resource;
  const userPayload = {
    question:
      question ||
      `Why is Lambda ${resource?.name ?? "unknown"} failing?`,
    evidence: safe,
  };

  const body = JSON.stringify({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
  };
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(45_000),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 500);
      return {
        summary: "OpenAI analysis failed.",
        likely_causes: [],
        supporting_evidence: [],
        recommended_next_steps: [
          "Verify the OpenAI API key in SSM Parameter Store.",
          "Retry the investigation after checking API quota.",
        ],
        open_questions: [],
        error: { code: `HTTP_${resp.status}`, message: detail },
      };
    }
    payload = (await resp.json()) as typeof payload;
  } catch (err) {
    return {
      summary: "Could not reach OpenAI API.",
      likely_causes: [],
      supporting_evidence: [],
      recommended_next_steps: [
        "Ensure the Lambda has outbound internet access (or VPC endpoints).",
      ],
      open_questions: [],
      error: {
        code: "URLError",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const content = payload.choices?.[0]?.message?.content ?? "{}";
  let parsed: Partial<Diagnosis>;
  try {
    parsed = JSON.parse(content) as Partial<Diagnosis>;
  } catch {
    parsed = {
      summary: content.slice(0, 1000),
      likely_causes: [],
      supporting_evidence: [],
      recommended_next_steps: [],
      open_questions: [],
    };
  }

  return {
    summary: parsed.summary || "",
    likely_causes: parsed.likely_causes || [],
    supporting_evidence: parsed.supporting_evidence || [],
    recommended_next_steps: parsed.recommended_next_steps || [],
    open_questions: parsed.open_questions || [],
    model,
  };
}
