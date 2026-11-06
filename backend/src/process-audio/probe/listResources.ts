/**
 * Read-only listing of AWS resources for the Target picker.
 * Caps results so large accounts stay responsive.
 */

import {
  DescribeInstancesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import {
  LambdaClient,
  ListFunctionsCommand,
} from "@aws-sdk/client-lambda";
import {
  ListBucketsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ListTopicsCommand,
  SNSClient,
} from "@aws-sdk/client-sns";
import {
  ListQueuesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  APIGatewayClient,
  GetRestApisCommand,
} from "@aws-sdk/client-api-gateway";
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  BudgetsClient,
  DescribeBudgetsCommand,
} from "@aws-sdk/client-budgets";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";

export const RESOURCE_TYPES = [
  "lambda",
  "s3",
  "ec2",
  "dynamodb",
  "sqs",
  "sns",
  "apigateway",
  "loggroup",
  "alarm",
  "budget",
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface ListedResource {
  id: string;
  name: string;
  arn?: string;
  region?: string;
  meta?: string;
}

export interface ListResourcesResult {
  ok: boolean;
  type: string;
  region: string;
  count: number;
  truncated: boolean;
  resources: ListedResource[];
  investigate_supported: boolean;
  error?: { code: string; message: string };
}

const MAX = 200;

export function isResourceType(value: string): value is ResourceType {
  return (RESOURCE_TYPES as readonly string[]).includes(value);
}

export async function listResources(
  type: string,
  region: string,
): Promise<ListResourcesResult> {
  const normalized = type.trim().toLowerCase();
  const base: ListResourcesResult = {
    ok: false,
    type: normalized,
    region,
    count: 0,
    truncated: false,
    resources: [],
    investigate_supported: true,
  };

  if (!isResourceType(normalized)) {
    return {
      ...base,
      error: {
        code: "UnsupportedType",
        message: `Unsupported type "${type}". Use one of: ${RESOURCE_TYPES.join(", ")}`,
      },
    };
  }

  try {
    let resources: ListedResource[] = [];
    switch (normalized) {
      case "lambda":
        resources = await listLambdas(region);
        break;
      case "s3":
        resources = await listS3(region);
        break;
      case "ec2":
        resources = await listEc2(region);
        break;
      case "dynamodb":
        resources = await listDynamo(region);
        break;
      case "sqs":
        resources = await listSqs(region);
        break;
      case "sns":
        resources = await listSns(region);
        break;
      case "apigateway":
        resources = await listApiGateway(region);
        break;
      case "loggroup":
        resources = await listLogGroups(region);
        break;
      case "alarm":
        resources = await listAlarmResources(region);
        break;
      case "budget":
        resources = await listBudgetResources();
        break;
    }

    const truncated = resources.length > MAX;
    const sliced = resources.slice(0, MAX).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return {
      ok: true,
      type: normalized,
      region,
      count: sliced.length,
      truncated,
      resources: sliced,
      investigate_supported: true,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: {
        code: e.name || "ListError",
        message: e.message || String(err),
      },
    };
  }
}

async function listLambdas(region: string): Promise<ListedResource[]> {
  const client = new LambdaClient({ region });
  const out: ListedResource[] = [];
  let marker: string | undefined;
  do {
    const resp = await client.send(
      new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }),
    );
    for (const fn of resp.Functions ?? []) {
      if (!fn.FunctionName) continue;
      out.push({
        id: fn.FunctionName,
        name: fn.FunctionName,
        arn: fn.FunctionArn,
        region,
        meta: fn.Runtime,
      });
    }
    marker = resp.NextMarker;
  } while (marker && out.length < MAX + 1);
  return out;
}

async function listS3(region: string): Promise<ListedResource[]> {
  // Buckets are global; client region is still required by the SDK.
  const client = new S3Client({ region });
  const resp = await client.send(new ListBucketsCommand({}));
  return (resp.Buckets ?? [])
    .filter((b) => b.Name)
    .map((b) => ({
      id: b.Name!,
      name: b.Name!,
      region: "global",
      meta: b.CreationDate?.toISOString()?.slice(0, 10),
    }));
}

async function listEc2(region: string): Promise<ListedResource[]> {
  const client = new EC2Client({ region });
  const out: ListedResource[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(
      new DescribeInstancesCommand({
        NextToken: nextToken,
        MaxResults: 50,
      }),
    );
    for (const reservation of resp.Reservations ?? []) {
      for (const inst of reservation.Instances ?? []) {
        if (!inst.InstanceId) continue;
        const nameTag = (inst.Tags ?? []).find((t) => t.Key === "Name")?.Value;
        out.push({
          id: inst.InstanceId,
          name: nameTag || inst.InstanceId,
          region,
          meta: `${inst.State?.Name || "unknown"} · ${inst.InstanceType || ""}`.trim(),
        });
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken && out.length < MAX + 1);
  return out;
}

async function listDynamo(region: string): Promise<ListedResource[]> {
  const client = new DynamoDBClient({ region });
  const out: ListedResource[] = [];
  let startKey: string | undefined;
  do {
    const resp = await client.send(
      new ListTablesCommand({
        ExclusiveStartTableName: startKey,
        Limit: 100,
      }),
    );
    for (const name of resp.TableNames ?? []) {
      out.push({ id: name, name, region });
    }
    startKey = resp.LastEvaluatedTableName;
  } while (startKey && out.length < MAX + 1);
  return out;
}

async function listSqs(region: string): Promise<ListedResource[]> {
  const client = new SQSClient({ region });
  const resp = await client.send(new ListQueuesCommand({ MaxResults: 1000 }));
  return (resp.QueueUrls ?? []).map((url) => {
    const name = url.split("/").pop() || url;
    return { id: url, name, arn: undefined, region, meta: "queue" };
  });
}

async function listSns(region: string): Promise<ListedResource[]> {
  const client = new SNSClient({ region });
  const out: ListedResource[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(
      new ListTopicsCommand({ NextToken: nextToken }),
    );
    for (const topic of resp.Topics ?? []) {
      const arn = topic.TopicArn;
      if (!arn) continue;
      const name = arn.split(":").pop() || arn;
      out.push({ id: arn, name, arn, region });
    }
    nextToken = resp.NextToken;
  } while (nextToken && out.length < MAX + 1);
  return out;
}

async function listApiGateway(region: string): Promise<ListedResource[]> {
  const client = new APIGatewayClient({ region });
  const out: ListedResource[] = [];
  let position: string | undefined;
  do {
    const resp = await client.send(
      new GetRestApisCommand({ position, limit: 500 }),
    );
    for (const api of resp.items ?? []) {
      if (!api.id || !api.name) continue;
      out.push({
        id: api.id,
        name: api.name,
        region,
        meta: api.id,
      });
    }
    position = resp.position;
  } while (position && out.length < MAX + 1);
  return out;
}

async function listLogGroups(region: string): Promise<ListedResource[]> {
  const client = new CloudWatchLogsClient({ region });
  const out: ListedResource[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(
      new DescribeLogGroupsCommand({
        nextToken,
        limit: 50,
      }),
    );
    for (const g of resp.logGroups ?? []) {
      if (!g.logGroupName) continue;
      out.push({
        id: g.logGroupName,
        name: g.logGroupName,
        arn: g.arn,
        region,
        meta: g.storedBytes != null ? `${g.storedBytes} bytes` : undefined,
      });
    }
    nextToken = resp.nextToken;
  } while (nextToken && out.length < MAX + 1);
  return out;
}

async function listAlarmResources(region: string): Promise<ListedResource[]> {
  const client = new CloudWatchClient({ region });
  const out: ListedResource[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(
      new DescribeAlarmsCommand({
        MaxRecords: 100,
        NextToken: nextToken,
      }),
    );
    for (const a of resp.MetricAlarms ?? []) {
      if (!a.AlarmName) continue;
      out.push({
        id: a.AlarmName,
        name: a.AlarmName,
        arn: a.AlarmArn,
        region,
        meta: a.StateValue ?? undefined,
      });
    }
    for (const a of resp.CompositeAlarms ?? []) {
      if (!a.AlarmName) continue;
      out.push({
        id: a.AlarmName,
        name: a.AlarmName,
        arn: a.AlarmArn,
        region,
        meta: a.StateValue ?? undefined,
      });
    }
    nextToken = resp.NextToken;
  } while (nextToken && out.length < MAX + 1);
  return out;
}

async function listBudgetResources(): Promise<ListedResource[]> {
  const sts = new STSClient({});
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account;
  if (!accountId) return [];

  const client = new BudgetsClient({ region: "us-east-1" });
  const out: ListedResource[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await client.send(
      new DescribeBudgetsCommand({
        AccountId: accountId,
        MaxResults: 100,
        NextToken: nextToken,
      }),
    );
    for (const b of resp.Budgets ?? []) {
      if (!b.BudgetName) continue;
      const limit = b.BudgetLimit
        ? `${b.BudgetLimit.Amount} ${b.BudgetLimit.Unit}`
        : undefined;
      out.push({
        id: b.BudgetName,
        name: b.BudgetName,
        region: "us-east-1",
        meta: [b.BudgetType, b.TimeUnit, limit].filter(Boolean).join(" · "),
      });
    }
    nextToken = resp.NextToken;
  } while (nextToken && out.length < MAX + 1);
  return out;
}
