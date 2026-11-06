import OpenAI, { toFile } from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { awsTroubleshootTools, runAwsTool } from "./aws-tools";
import { getOpenAIApiKey } from "./secrets";

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export type InvestigationScope = {
  type?: string;
  name?: string;
  id?: string;
  region?: string;
  arn?: string;
};

const DEFAULT_SYSTEM = [
  "You are Probe 2.0 — the voice edition of Probe, an account-aware AWS troubleshooting assistant.",
  "Same job as original Probe: diagnose issues in THIS AWS account using read-only evidence.",
  "Prefer tools before guessing.",
  "If the user selected a scope target, treat that resource as the default subject unless they clearly ask about something else.",
  "Match the selected scope type to the matching inspect tool:",
  "lambda → investigate_lambda; sqs → inspect_sqs_queue; sns → inspect_sns_topic; s3 → inspect_s3_bucket;",
  "ec2 → inspect_ec2_instance; dynamodb → inspect_dynamodb_table; apigateway → inspect_apigateway; loggroup → inspect_log_group;",
  "alarm → inspect_alarm; budget → inspect_budget (or list_budgets for all).",
  "Use list_resources to discover names, list_alarms for firing alarms, inspect_alarm for why an alarm triggered,",
  "list_budgets/inspect_budget for monthly budget limit, actual spend, and forecast, get_account_identity for account/region.",
  "Explain likely root causes using ONLY tool evidence. If evidence is thin, say so.",
  "Do not invent resources, metrics, or log lines.",
  "Never suggest destructive actions first; prefer inspect/verify steps.",
  "You are speaking aloud: 2–5 short sentences, concrete next steps, no markdown or bullet lists.",
  "Stay on AWS troubleshooting. Briefly redirect unrelated requests.",
].join(" ");

function scopeContext(scope: InvestigationScope | null | undefined): string | null {
  if (!scope?.name || !scope.type) return null;
  return [
    "Selected investigation scope from the UI:",
    `type=${scope.type}`,
    `name=${scope.name}`,
    scope.id ? `id=${scope.id}` : null,
    scope.region ? `region=${scope.region}` : null,
    scope.arn ? `arn=${scope.arn}` : null,
    "Use this target unless the user clearly asks about a different resource.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function client(): Promise<OpenAI> {
  return new OpenAI({ apiKey: await getOpenAIApiKey() });
}

export async function transcribeAudio(
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  const openai = await client();
  const file = await toFile(Buffer.from(bytes), filename);

  const result = await openai.audio.transcriptions.create({
    file,
    model: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe",
  });

  const text = result.text?.trim() ?? "";
  if (!text) {
    throw new Error("Transcription returned empty text");
  }
  return text;
}

function sanitizeHistory(history: ChatTurn[] | undefined): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 2000) }))
    .slice(-12);
}

export async function generateReply(
  transcript: string,
  history?: ChatTurn[],
  scope?: InvestigationScope | null,
): Promise<string> {
  const openai = await client();
  const system = process.env.ASSISTANT_SYSTEM_PROMPT ?? DEFAULT_SYSTEM;
  const prior = sanitizeHistory(history);
  const scopeNote = scopeContext(scope);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...(scopeNote
      ? [{ role: "system" as const, content: scopeNote }]
      : []),
    ...prior,
    { role: "user", content: transcript },
  ];

  const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
  const maxRounds = 3;

  for (let round = 0; round < maxRounds; round++) {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 320,
      tools: awsTroubleshootTools,
      tool_choice: round === maxRounds - 1 ? "none" : "auto",
      messages,
    });

    const message = completion.choices[0]?.message;
    if (!message) {
      throw new Error("Assistant returned an empty message");
    }

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const reply = message.content?.trim() ?? "";
      if (!reply) {
        throw new Error("Assistant returned an empty reply");
      }
      return reply;
    }

    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      const result = await runAwsTool(
        call.function.name,
        call.function.arguments ?? "{}",
      );
      const toolMessage: ChatCompletionToolMessageParam = {
        role: "tool",
        tool_call_id: call.id,
        content: result,
      };
      messages.push(toolMessage);
    }
  }

  throw new Error("Assistant exceeded tool-call rounds without a final reply");
}
