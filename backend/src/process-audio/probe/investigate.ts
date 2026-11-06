/**
 * Probe evidence collector (voice edition).
 * Same Lambda investigation path as original Probe — without nested OpenAI.
 * The voice chat model turns this evidence into a spoken reply.
 */
import {
  collectCloudFormation,
  collectLambda,
  collectLogs,
  collectMetrics,
} from "./collectors";
import { redactText, redactValue } from "./redact";

const DEFAULT_REGION = process.env.INVESTIGATION_REGION || "us-east-1";
const LOOKBACK = Number(process.env.LOG_LOOKBACK_MINUTES || "60");
const MAX_EVENTS = Number(process.env.MAX_LOG_EVENTS || "40");

const FUNCTION_HINT =
  /\b(?:lambda|function)\s+["']?([A-Za-z0-9_+=,.@-]{1,140})["']?/i;
const REGION_HINT = /\b(us|eu|ap|sa|ca|me|af)-[a-z]+-\d\b/;

export interface InvestigateInput {
  functionName?: string | null;
  region?: string | null;
  question?: string | null;
  lookbackMinutes?: number | null;
  maxLogEvents?: number | null;
  includeCloudFormation?: boolean;
}

export function extractFunctionName(text: string): string | null {
  const match = FUNCTION_HINT.exec(text || "");
  if (!match) return null;
  const name = match[1]!.replace(/[.,?!]+$/, "");
  if (["function", "lambda", "my", "the", "a", "an"].includes(name.toLowerCase())) {
    return null;
  }
  return name;
}

export function extractRegion(text: string): string | null {
  const match = REGION_HINT.exec(text || "");
  return match ? match[0] : null;
}

export async function collectLambdaEvidence(input: InvestigateInput) {
  const resolvedName =
    (input.functionName || "").trim() ||
    extractFunctionName(input.question || "") ||
    "";
  const resolvedRegion =
    (input.region || "").trim() ||
    extractRegion(input.question || "") ||
    DEFAULT_REGION;
  const lookback = input.lookbackMinutes || LOOKBACK;
  const maxEvents = Math.min(input.maxLogEvents || MAX_EVENTS, 40);
  const includeCfn = input.includeCloudFormation !== false;

  if (!resolvedName) {
    return {
      ok: false,
      error: {
        code: "MissingFunctionName",
        message: "Provide a Lambda function name to investigate.",
      },
      investigation_type: "lambda_errors",
      region: resolvedRegion,
    };
  }

  const [lambdaInfo, logs, metrics, cfn] = await Promise.all([
    collectLambda(resolvedName, resolvedRegion),
    collectLogs(resolvedName, resolvedRegion, {
      lookbackMinutes: lookback,
      maxEvents,
    }),
    collectMetrics(resolvedName, resolvedRegion, {
      lookbackMinutes: lookback,
    }),
    includeCfn
      ? collectCloudFormation(resolvedName, resolvedRegion)
      : Promise.resolve(null),
  ]);

  const evidence = redactValue({
    resource: {
      type: "AWS::Lambda::Function",
      name: resolvedName,
      region: resolvedRegion,
    },
    investigation_type: "lambda_errors",
    question: input.question,
    lambda: lambdaInfo,
    logs: {
      ok: logs.ok,
      log_group: logs.log_group,
      lookback_minutes: logs.lookback_minutes,
      error_like_count: logs.error_like_count,
      note: logs.note,
      error: logs.error,
      events: logs.events.map((ev) => ({
        timestamp: ev.timestamp,
        message: redactText((ev.message || "").slice(0, 600)),
      })),
    },
    metrics,
    cloudformation: cfn
      ? {
          ok: cfn.ok,
          matched_stacks: cfn.matched_stacks.map((s) => ({
            stack_name: s.stack_name,
            resource_status: s.resource_status,
            resource_status_reason: s.resource_status_reason,
          })),
          note: cfn.note,
          error: cfn.error,
        }
      : null,
  });

  return {
    ok: Boolean(lambdaInfo.ok || logs.ok || metrics.ok),
    investigation_type: "lambda_errors",
    evidence,
  };
}
