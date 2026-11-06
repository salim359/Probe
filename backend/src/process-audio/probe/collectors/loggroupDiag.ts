import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

export interface LogGroupDiagResult {
  ok: boolean;
  region: string;
  log_group_name: string;
  stored_bytes?: number | null;
  retention_days?: number | null;
  metric_filter_count?: number | null;
  recent_streams?: Array<{
    name: string;
    last_event_at: string | null;
    stored_bytes?: number;
  }>;
  recent_error_like_events?: Array<{
    timestamp: string | null;
    message: string;
  }>;
  error_like_count?: number;
  lookback_minutes?: number;
  error?: { code: string; message: string };
}

const ERROR_FILTER =
  "?ERROR ?Error ?Exception ?Timed ?timeout ?FAILED ?failed";

export async function collectLogGroup(
  logGroupName: string,
  region: string,
  opts: { lookbackMinutes?: number } = {},
): Promise<LogGroupDiagResult> {
  const client = new CloudWatchLogsClient({ region });
  const name = logGroupName.trim();
  const lookback = opts.lookbackMinutes ?? 60;
  const base: LogGroupDiagResult = {
    ok: false,
    region,
    log_group_name: name,
    lookback_minutes: lookback,
  };

  try {
    const groups = await client.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: name, limit: 20 }),
    );
    const group =
      (groups.logGroups ?? []).find((g) => g.logGroupName === name) ||
      groups.logGroups?.[0];
    if (!group?.logGroupName) {
      return {
        ...base,
        error: { code: "NotFound", message: `Log group not found: ${name}` },
      };
    }

    const streams = await client.send(
      new DescribeLogStreamsCommand({
        logGroupName: group.logGroupName,
        orderBy: "LastEventTime",
        descending: true,
        limit: 8,
      }),
    );

    const startTime = Date.now() - lookback * 60_000;
    let errorEvents: LogGroupDiagResult["recent_error_like_events"] = [];
    let errorCount = 0;
    try {
      const filtered = await client.send(
        new FilterLogEventsCommand({
          logGroupName: group.logGroupName,
          startTime,
          filterPattern: ERROR_FILTER,
          limit: 40,
        }),
      );
      errorEvents = (filtered.events ?? []).map((e) => ({
        timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : null,
        message: (e.message || "").slice(0, 500),
      }));
      errorCount = errorEvents.length;
    } catch {
      // Filter pattern may fail on some groups; fall back to recent unfiltered sample
      try {
        const recent = await client.send(
          new FilterLogEventsCommand({
            logGroupName: group.logGroupName,
            startTime,
            limit: 20,
          }),
        );
        errorEvents = (recent.events ?? [])
          .filter((e) =>
            /error|exception|timeout|failed/i.test(e.message || ""),
          )
          .map((e) => ({
            timestamp: e.timestamp
              ? new Date(e.timestamp).toISOString()
              : null,
            message: (e.message || "").slice(0, 500),
          }));
        errorCount = errorEvents.length;
      } catch {
        errorEvents = [];
      }
    }

    return {
      ok: true,
      region,
      log_group_name: group.logGroupName,
      stored_bytes: group.storedBytes ?? null,
      retention_days: group.retentionInDays ?? null,
      metric_filter_count: group.metricFilterCount ?? null,
      recent_streams: (streams.logStreams ?? []).map((s) => ({
        name: s.logStreamName || "",
        last_event_at: s.lastEventTimestamp
          ? new Date(s.lastEventTimestamp).toISOString()
          : null,
        stored_bytes: s.storedBytes,
      })),
      recent_error_like_events: errorEvents,
      error_like_count: errorCount,
      lookback_minutes: lookback,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: {
        code: e.name || "LogGroupError",
        message: e.message || String(err),
      },
    };
  }
}
