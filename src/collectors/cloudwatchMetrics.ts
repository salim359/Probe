import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";

export interface MetricsDiagResult {
  function_name: string;
  region: string;
  lookback_minutes: number;
  ok: boolean;
  metrics: Record<
    string,
    {
      sum_or_avg_total: number;
      datapoints: number;
      latest: number | null;
      latest_timestamp: string | null;
      status?: string;
    }
  >;
  error?: { code: string; message: string };
}

export async function collectMetrics(
  functionName: string,
  region: string,
  opts: { lookbackMinutes?: number } = {},
): Promise<MetricsDiagResult> {
  const lookbackMinutes = opts.lookbackMinutes ?? 60;
  const client = new CloudWatchClient({ region });
  const end = new Date();
  const start = new Date(end.getTime() - lookbackMinutes * 60 * 1000);
  const period = lookbackMinutes <= 180 ? 60 : 300;

  const metricNames = [
    "Errors",
    "Invocations",
    "Throttles",
    "Duration",
    "ConcurrentExecutions",
  ] as const;

  const queries: MetricDataQuery[] = metricNames.map((name, i) => ({
    Id: `m${i}`,
    MetricStat: {
      Metric: {
        Namespace: "AWS/Lambda",
        MetricName: name,
        Dimensions: [{ Name: "FunctionName", Value: functionName }],
      },
      Period: period,
      Stat: name === "Duration" ? "Average" : "Sum",
    },
    ReturnData: true,
  }));

  const result: MetricsDiagResult = {
    function_name: functionName,
    region,
    lookback_minutes: lookbackMinutes,
    ok: false,
    metrics: {},
  };

  try {
    const resp = await client.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: start,
        EndTime: end,
        ScanBy: "TimestampAscending",
      }),
    );

    const idToName = Object.fromEntries(
      metricNames.map((n, i) => [`m${i}`, n]),
    );

    for (const series of resp.MetricDataResults ?? []) {
      const name =
        idToName[series.Id ?? ""] ?? series.Label ?? "unknown";
      const values = series.Values ?? [];
      const timestamps = series.Timestamps ?? [];
      result.metrics[name] = {
        sum_or_avg_total: values.length
          ? Math.round(values.reduce((a, b) => a + b, 0) * 1000) / 1000
          : 0,
        datapoints: values.length,
        latest: values.length
          ? Math.round(values[values.length - 1]! * 1000) / 1000
          : null,
        latest_timestamp: timestamps.length
          ? timestamps[timestamps.length - 1]!.toISOString()
          : null,
        status: series.StatusCode,
      };
    }
    result.ok = true;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    result.error = {
      code: e.name || "ClientError",
      message: e.message || String(err),
    };
  }

  return result;
}
