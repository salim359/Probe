/**
 * List CloudWatch alarms with state reasons (why they fired).
 */

import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type MetricAlarm,
  type StateValue,
} from "@aws-sdk/client-cloudwatch";

const MAX = 100;

export interface AlarmSummary {
  alarm_name: string;
  state: string;
  state_reason: string;
  state_updated_at: string | null;
  namespace: string | null;
  metric_name: string | null;
  statistic: string | null;
  threshold: number | null;
  comparison_operator: string | null;
  dimensions: Array<{ name: string; value: string }>;
  related_lambda: string | null;
  description: string | null;
}

export interface ListAlarmsResult {
  ok: boolean;
  region: string;
  state_filter: string;
  count: number;
  truncated: boolean;
  alarms: AlarmSummary[];
  error?: { code: string; message: string };
}

export async function listAlarms(
  region: string,
  opts: { state?: string | null } = {},
): Promise<ListAlarmsResult> {
  const rawState = (opts.state || "ALARM").trim().toUpperCase();
  const allowed: StateValue[] = ["ALARM", "OK", "INSUFFICIENT_DATA"];
  const stateFilter: "ALL" | StateValue =
    rawState === "ALL" || rawState === "*"
      ? "ALL"
      : allowed.includes(rawState as StateValue)
        ? (rawState as StateValue)
        : "ALARM";

  const base: ListAlarmsResult = {
    ok: false,
    region,
    state_filter: stateFilter,
    count: 0,
    truncated: false,
    alarms: [],
  };

  try {
    const client = new CloudWatchClient({ region });
    const collected: MetricAlarm[] = [];
    let nextToken: string | undefined;

    do {
      const resp = await client.send(
        new DescribeAlarmsCommand({
          StateValue: stateFilter === "ALL" ? undefined : stateFilter,
          MaxRecords: 50,
          NextToken: nextToken,
          AlarmTypes: ["MetricAlarm"],
        }),
      );
      collected.push(...(resp.MetricAlarms ?? []));
      nextToken = resp.NextToken;
    } while (nextToken && collected.length < MAX + 1);

    const truncated = collected.length > MAX;
    const alarms = collected
      .slice(0, MAX)
      .map(toSummary)
      .sort((a, b) => {
        const rank = (s: string) =>
          s === "ALARM" ? 0 : s === "INSUFFICIENT_DATA" ? 1 : 2;
        const byState = rank(a.state) - rank(b.state);
        if (byState !== 0) return byState;
        const at = a.state_updated_at || "";
        const bt = b.state_updated_at || "";
        return bt.localeCompare(at) || a.alarm_name.localeCompare(b.alarm_name);
      });

    return {
      ...base,
      ok: true,
      count: alarms.length,
      truncated,
      alarms,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: {
        code: e.name || "ListAlarmsError",
        message: e.message || String(err),
      },
    };
  }
}

function toSummary(alarm: MetricAlarm): AlarmSummary {
  const dimensions = (alarm.Dimensions ?? [])
    .filter((d) => d.Name && d.Value)
    .map((d) => ({ name: d.Name!, value: d.Value! }));

  const relatedLambda =
    dimensions.find((d) => d.name === "FunctionName")?.value || null;

  return {
    alarm_name: alarm.AlarmName || "unknown",
    state: alarm.StateValue || "UNKNOWN",
    state_reason: alarm.StateReason || "No state reason provided.",
    state_updated_at: alarm.StateUpdatedTimestamp
      ? alarm.StateUpdatedTimestamp.toISOString()
      : null,
    namespace: alarm.Namespace || null,
    metric_name: alarm.MetricName || null,
    statistic: alarm.Statistic || alarm.ExtendedStatistic || null,
    threshold: alarm.Threshold ?? null,
    comparison_operator: alarm.ComparisonOperator || null,
    dimensions,
    related_lambda: relatedLambda,
    description: alarm.AlarmDescription || null,
  };
}
