import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

export interface LogEventSample {
  timestamp?: number;
  message: string;
  log_stream?: string;
}

export interface LogsDiagResult {
  log_group: string;
  region: string;
  lookback_minutes: number;
  start_ms: number;
  end_ms: number;
  ok: boolean;
  events: LogEventSample[];
  event_count?: number;
  error_like_count: number;
  note?: string;
  error?: { code: string; message: string };
  filter_errors?: Array<{ pattern: string; code: string; message: string }>;
}

function clientError(err: unknown): { code: string; message: string } {
  const e = err as { name?: string; message?: string };
  return { code: e.name || "ClientError", message: e.message || String(err) };
}

function looksLikeError(message: string): boolean {
  const markers = [
    "ERROR",
    "Error",
    "Exception",
    "Traceback",
    "Task timed out",
    "Runtime.ExitError",
    "Process exited",
  ];
  return markers.some((m) => message.includes(m));
}

export async function collectLogs(
  functionName: string,
  region: string,
  opts: { lookbackMinutes?: number; maxEvents?: number } = {},
): Promise<LogsDiagResult> {
  const lookbackMinutes = opts.lookbackMinutes ?? 60;
  const maxEvents = opts.maxEvents ?? 50;
  const client = new CloudWatchLogsClient({ region });
  const logGroup = `/aws/lambda/${functionName}`;
  const endMs = Date.now();
  const startMs = endMs - lookbackMinutes * 60 * 1000;

  const result: LogsDiagResult = {
    log_group: logGroup,
    region,
    lookback_minutes: lookbackMinutes,
    start_ms: startMs,
    end_ms: endMs,
    ok: false,
    events: [],
    error_like_count: 0,
  };

  try {
    const groups = await client.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: logGroup,
        limit: 5,
      }),
    );
    const names = (groups.logGroups ?? []).map((g) => g.logGroupName);
    if (!names.includes(logGroup)) {
      result.error = {
        code: "LogGroupNotFound",
        message: `No log group named ${logGroup}. Function may never have been invoked.`,
      };
      return result;
    }
  } catch (err) {
    result.error = clientError(err);
    return result;
  }

  const filterPatterns = [
    '?ERROR ?Error ?Exception ?"Task timed out" ?"Runtime.ExitError" ?Traceback',
    "ERROR",
  ];

  let events: LogEventSample[] = [];
  for (const pattern of filterPatterns) {
    try {
      const resp = await client.send(
        new FilterLogEventsCommand({
          logGroupName: logGroup,
          startTime: startMs,
          endTime: endMs,
          filterPattern: pattern,
          limit: maxEvents,
          interleaved: true,
        }),
      );
      events = (resp.events ?? []).map((ev) => ({
        timestamp: ev.timestamp,
        message: ev.message ?? "",
        log_stream: ev.logStreamName,
      }));
      if (events.length) break;
    } catch (err) {
      const e = clientError(err);
      result.filter_errors = result.filter_errors ?? [];
      result.filter_errors.push({ pattern, ...e });
    }
  }

  if (!events.length) {
    try {
      const resp = await client.send(
        new FilterLogEventsCommand({
          logGroupName: logGroup,
          startTime: startMs,
          endTime: endMs,
          limit: Math.min(maxEvents, 20),
          interleaved: true,
        }),
      );
      events = (resp.events ?? []).map((ev) => ({
        timestamp: ev.timestamp,
        message: ev.message ?? "",
        log_stream: ev.logStreamName,
      }));
      result.note =
        "No ERROR-pattern matches; returning recent log sample.";
    } catch (err) {
      result.error = clientError(err);
      return result;
    }
  }

  const seen = new Set<string>();
  const unique: LogEventSample[] = [];
  for (const ev of events.sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
  )) {
    const key = `${ev.timestamp}|${ev.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ev);
  }

  const trimmed = unique.slice(-maxEvents);
  result.ok = true;
  result.events = trimmed;
  result.event_count = trimmed.length;
  result.error_like_count = trimmed.filter((e) =>
    looksLikeError(e.message),
  ).length;
  return result;
}
