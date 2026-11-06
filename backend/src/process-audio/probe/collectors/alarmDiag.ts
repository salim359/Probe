import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";

export interface AlarmDiagResult {
  ok: boolean;
  region: string;
  alarm_name: string;
  state?: string | null;
  state_reason?: string | null;
  state_reason_data?: unknown;
  state_updated_at?: string | null;
  description?: string | null;
  namespace?: string | null;
  metric_name?: string | null;
  statistic?: string | null;
  period_seconds?: number | null;
  evaluation_periods?: number | null;
  datapoints_to_alarm?: number | null;
  threshold?: number | null;
  comparison_operator?: string | null;
  treat_missing_data?: string | null;
  dimensions?: Array<{ name: string; value: string }>;
  actions?: {
    alarm?: string[];
    ok?: string[];
    insufficient_data?: string[];
  };
  history?: Array<{
    type?: string;
    summary?: string;
    timestamp?: string | null;
  }>;
  why_triggered?: string;
  error?: { code: string; message: string };
}

export async function collectAlarm(
  alarmName: string,
  region: string,
): Promise<AlarmDiagResult> {
  const client = new CloudWatchClient({ region });
  const name = alarmName.trim();
  const base: AlarmDiagResult = { ok: false, region, alarm_name: name };

  try {
    const desc = await client.send(
      new DescribeAlarmsCommand({
        AlarmNames: [name],
        AlarmTypes: ["MetricAlarm"],
      }),
    );
    const alarm = desc.MetricAlarms?.[0];
    if (!alarm) {
      return {
        ...base,
        error: { code: "NotFound", message: `Alarm not found: ${name}` },
      };
    }

    let history: AlarmDiagResult["history"] = [];
    try {
      const hist = await client.send(
        new DescribeAlarmHistoryCommand({
          AlarmName: name,
          HistoryItemType: "StateUpdate",
          MaxRecords: 15,
        }),
      );
      history = (hist.AlarmHistoryItems ?? []).map((h) => ({
        type: h.HistoryItemType,
        summary: h.HistorySummary,
        timestamp: h.Timestamp?.toISOString() ?? null,
      }));
    } catch {
      history = [];
    }

    let stateReasonData: unknown = null;
    if (alarm.StateReasonData) {
      try {
        stateReasonData = JSON.parse(alarm.StateReasonData);
      } catch {
        stateReasonData = alarm.StateReasonData;
      }
    }

    const dimensions = (alarm.Dimensions ?? [])
      .filter((d) => d.Name && d.Value)
      .map((d) => ({ name: d.Name!, value: d.Value! }));

    const why =
      alarm.StateValue === "ALARM"
        ? [
            `Alarm is in ALARM because: ${alarm.StateReason || "no reason text"}.`,
            alarm.MetricName && alarm.Threshold != null
              ? `It watches ${alarm.Namespace}/${alarm.MetricName} ${alarm.ComparisonOperator} ${alarm.Threshold} over ${alarm.EvaluationPeriods} period(s).`
              : null,
          ]
            .filter(Boolean)
            .join(" ")
        : `Alarm state is ${alarm.StateValue}. Reason: ${alarm.StateReason || "n/a"}.`;

    return {
      ok: true,
      region,
      alarm_name: alarm.AlarmName || name,
      state: alarm.StateValue ?? null,
      state_reason: alarm.StateReason ?? null,
      state_reason_data: stateReasonData,
      state_updated_at: alarm.StateUpdatedTimestamp?.toISOString() ?? null,
      description: alarm.AlarmDescription ?? null,
      namespace: alarm.Namespace ?? null,
      metric_name: alarm.MetricName ?? null,
      statistic: alarm.Statistic || alarm.ExtendedStatistic || null,
      period_seconds: alarm.Period ?? null,
      evaluation_periods: alarm.EvaluationPeriods ?? null,
      datapoints_to_alarm: alarm.DatapointsToAlarm ?? null,
      threshold: alarm.Threshold ?? null,
      comparison_operator: alarm.ComparisonOperator ?? null,
      treat_missing_data: alarm.TreatMissingData ?? null,
      dimensions,
      actions: {
        alarm: alarm.AlarmActions ?? [],
        ok: alarm.OKActions ?? [],
        insufficient_data: alarm.InsufficientDataActions ?? [],
      },
      history,
      why_triggered: why,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: {
        code: e.name || "AlarmError",
        message: e.message || String(err),
      },
    };
  }
}
