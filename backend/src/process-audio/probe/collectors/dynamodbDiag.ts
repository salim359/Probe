import {
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ListTagsOfResourceCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

export interface DynamoDiagResult {
  ok: boolean;
  region: string;
  table_name: string;
  table_arn?: string;
  table_status?: string | null;
  item_count?: number | null;
  table_size_bytes?: number | null;
  billing_mode?: string | null;
  read_capacity_units?: number | null;
  write_capacity_units?: number | null;
  stream_enabled?: boolean;
  stream_view_type?: string | null;
  gsi_count?: number;
  lsi_count?: number;
  ttl_status?: string | null;
  deletion_protection?: boolean | null;
  metrics_1h?: {
    consumed_read_avg?: number | null;
    consumed_write_avg?: number | null;
    throttled_requests_sum?: number | null;
    user_errors_sum?: number | null;
    system_errors_sum?: number | null;
  };
  error?: { code: string; message: string };
}

export async function collectDynamo(
  tableName: string,
  region: string,
): Promise<DynamoDiagResult> {
  const client = new DynamoDBClient({ region });
  const name = tableName.trim();
  const base: DynamoDiagResult = { ok: false, region, table_name: name };

  try {
    const desc = await client.send(
      new DescribeTableCommand({ TableName: name }),
    );
    const table = desc.Table;
    if (!table) {
      return {
        ...base,
        error: { code: "NotFound", message: `Table ${name} not found` },
      };
    }

    let ttlStatus: string | null = null;
    try {
      const ttl = await client.send(
        new DescribeTimeToLiveCommand({ TableName: name }),
      );
      ttlStatus = ttl.TimeToLiveDescription?.TimeToLiveStatus ?? null;
    } catch {
      ttlStatus = null;
    }

    // Tags are optional; ignore failures
    if (table.TableArn) {
      try {
        await client.send(
          new ListTagsOfResourceCommand({ ResourceArn: table.TableArn }),
        );
      } catch {
        /* ignore */
      }
    }

    const metrics_1h = await fetchDdbMetrics(name, region);

    return {
      ok: true,
      region,
      table_name: name,
      table_arn: table.TableArn,
      table_status: table.TableStatus ?? null,
      item_count: table.ItemCount ?? null,
      table_size_bytes: table.TableSizeBytes ?? null,
      billing_mode: table.BillingModeSummary?.BillingMode ?? "PROVISIONED",
      read_capacity_units: table.ProvisionedThroughput?.ReadCapacityUnits ?? null,
      write_capacity_units:
        table.ProvisionedThroughput?.WriteCapacityUnits ?? null,
      stream_enabled: Boolean(table.StreamSpecification?.StreamEnabled),
      stream_view_type: table.StreamSpecification?.StreamViewType ?? null,
      gsi_count: table.GlobalSecondaryIndexes?.length ?? 0,
      lsi_count: table.LocalSecondaryIndexes?.length ?? 0,
      ttl_status: ttlStatus,
      deletion_protection: table.DeletionProtectionEnabled ?? null,
      metrics_1h,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: {
        code: e.name || "DynamoError",
        message: e.message || String(err),
      },
    };
  }
}

async function fetchDdbMetrics(tableName: string, region: string) {
  try {
    const cw = new CloudWatchClient({ region });
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const dim = [{ Name: "TableName", Value: tableName }];
    const resp = await cw.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: [
          metric("r", "ConsumedReadCapacityUnits", dim, "Average", 300),
          metric("w", "ConsumedWriteCapacityUnits", dim, "Average", 300),
          metric("th", "ThrottledRequests", dim, "Sum", 3600),
          metric("ue", "UserErrors", dim, "Sum", 3600),
          metric("se", "SystemErrors", dim, "Sum", 3600),
        ],
      }),
    );
    const byId = Object.fromEntries(
      (resp.MetricDataResults ?? []).map((r) => [r.Id || "", r]),
    );
    const avg = (id: string) => {
      const vals = byId[id]?.Values ?? [];
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const sum = (id: string) => {
      const vals = byId[id]?.Values ?? [];
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0);
    };
    return {
      consumed_read_avg: avg("r"),
      consumed_write_avg: avg("w"),
      throttled_requests_sum: sum("th"),
      user_errors_sum: sum("ue"),
      system_errors_sum: sum("se"),
    };
  } catch {
    return undefined;
  }
}

function metric(
  id: string,
  name: string,
  dimensions: Array<{ Name: string; Value: string }>,
  stat: string,
  period: number,
) {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: "AWS/DynamoDB",
        MetricName: name,
        Dimensions: dimensions,
      },
      Period: period,
      Stat: stat,
    },
  };
}
