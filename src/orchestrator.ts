import {
  collectCloudFormation,
  collectLambda,
  collectLogs,
  collectMetrics,
} from "./collectors";
import type { Diagnosis } from "./openaiClient";
import { analyzeEvidence } from "./openaiClient";
import { redactText, redactValue } from "./redact";

const DEFAULT_REGION = process.env.INVESTIGATION_REGION || "us-east-1";
const LOOKBACK = Number(process.env.LOG_LOOKBACK_MINUTES || "60");
const MAX_EVENTS = Number(process.env.MAX_LOG_EVENTS || "50");

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

export async function investigate(input: InvestigateInput) {
  const resolvedName =
    (input.functionName || "").trim() ||
    extractFunctionName(input.question || "") ||
    "";
  const resolvedRegion =
    (input.region || "").trim() ||
    extractRegion(input.question || "") ||
    DEFAULT_REGION;
  const lookback = input.lookbackMinutes || LOOKBACK;
  const maxEvents = input.maxLogEvents || MAX_EVENTS;
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

  const resource = {
    type: "AWS::Lambda::Function",
    name: resolvedName,
    region: resolvedRegion,
  };

  const evidence = redactValue({
    resource,
    investigation_type: "lambda_errors",
    question: input.question,
    lambda: lambdaInfo,
    logs: trimLogsForModel(logs),
    metrics,
    cloudformation: cfn,
  }) as Record<string, unknown>;

  let diagnosis: Diagnosis;
  try {
    diagnosis = await analyzeEvidence(evidence, input.question);
  } catch (err) {
    diagnosis = {
      summary: "Analysis step failed; returning raw evidence summary.",
      likely_causes: [],
      supporting_evidence: evidenceSummaryBullets(evidence),
      recommended_next_steps: [
        "Inspect CloudWatch Logs in the console for the function.",
        "Confirm OPENAI_PARAMETER_NAME and network egress.",
      ],
      open_questions: [],
      error: {
        code: "AnalysisError",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const lambdaSummaryKeys = [
    "ok",
    "runtime",
    "timeout",
    "memory_mb",
    "state",
    "state_reason",
    "last_update_status",
    "last_update_status_reason",
    "vpc_configured",
    "reserved_concurrent_executions",
    "environment_variable_names",
  ] as const;

  const lambdaRecord = lambdaInfo as unknown as Record<string, unknown>;
  const lambdaEvidence = !lambdaInfo.ok
    ? lambdaInfo
    : Object.fromEntries(
        lambdaSummaryKeys
          .filter((k) => k in lambdaInfo)
          .map((k) => [k, lambdaRecord[k]]),
      );

  return {
    ok: Boolean(lambdaInfo.ok || logs.ok || metrics.ok),
    investigation_type: "lambda_errors",
    resource,
    findings: diagnosis,
    evidence: {
      lambda: lambdaEvidence,
      logs: {
        ok: logs.ok,
        log_group: logs.log_group,
        lookback_minutes: logs.lookback_minutes,
        event_count: logs.event_count ?? logs.events.length,
        error_like_count: logs.error_like_count,
        note: logs.note,
        error: logs.error,
        sample_messages: logs.events
          .slice(-5)
          .map((e) => redactText(e.message).slice(0, 500)),
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
    },
  };
}

function trimLogsForModel(logs: Awaited<ReturnType<typeof collectLogs>>) {
  return {
    ok: logs.ok,
    log_group: logs.log_group,
    lookback_minutes: logs.lookback_minutes,
    error_like_count: logs.error_like_count,
    note: logs.note,
    error: logs.error,
    events: logs.events.map((ev) => ({
      timestamp: ev.timestamp,
      message: (ev.message || "").slice(0, 800),
    })),
  };
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

function evidenceSummaryBullets(evidence: Record<string, unknown>): string[] {
  const bullets: string[] = [];
  const lam = (evidence.lambda || {}) as Record<string, unknown>;
  if (lam.state_reason) bullets.push(`Lambda state reason: ${lam.state_reason}`);
  if (lam.last_update_status_reason) {
    bullets.push(`Last update: ${lam.last_update_status_reason}`);
  }
  const logs = (evidence.logs || {}) as Record<string, unknown>;
  if (logs.error_like_count) {
    bullets.push(`Error-like log events: ${logs.error_like_count}`);
  }
  const metrics = (
    (evidence.metrics as { metrics?: Record<string, { sum_or_avg_total?: number }> })
      ?.metrics || {}
  );
  if (metrics.Errors?.sum_or_avg_total) {
    bullets.push(`Errors metric total: ${metrics.Errors.sum_or_avg_total}`);
  }
  if (metrics.Throttles?.sum_or_avg_total) {
    bullets.push(
      `Throttles metric total: ${metrics.Throttles.sum_or_avg_total}`,
    );
  }
  return bullets;
}
