import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
  type StackStatus,
} from "@aws-sdk/client-cloudformation";

export interface CloudFormationDiagResult {
  function_name: string;
  region: string;
  ok: boolean;
  matched_stacks: Array<{
    stack_name: string;
    logical_id?: string;
    resource_status?: string;
    resource_status_reason?: string;
    last_updated?: string | null;
    recent_events: Array<{
      timestamp?: string | null;
      logical_id?: string;
      type?: string;
      status?: string;
      reason?: string;
    }>;
  }>;
  note?: string;
  error?: { code: string; message: string };
}

const STACK_STATUSES: StackStatus[] = [
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "CREATE_FAILED",
  "ROLLBACK_COMPLETE",
  "UPDATE_FAILED",
];

export async function collectCloudFormation(
  functionName: string,
  region: string,
  opts: { maxEvents?: number } = {},
): Promise<CloudFormationDiagResult> {
  const maxEvents = opts.maxEvents ?? 20;
  const client = new CloudFormationClient({ region });
  const result: CloudFormationDiagResult = {
    function_name: functionName,
    region,
    ok: true,
    matched_stacks: [],
    note:
      "CloudFormation lookup is best-effort: stacks are matched when a resource PhysicalResourceId equals the function name or ARN suffix.",
  };

  const stackNames: string[] = [];
  try {
    let nextToken: string | undefined;
    do {
      const page = await client.send(
        new ListStacksCommand({
          StackStatusFilter: STACK_STATUSES,
          NextToken: nextToken,
        }),
      );
      for (const s of page.StackSummaries ?? []) {
        if (s.StackName) stackNames.push(s.StackName);
      }
      nextToken = page.NextToken;
    } while (nextToken && stackNames.length < 50);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    result.ok = false;
    result.error = {
      code: e.name || "ClientError",
      message: e.message || String(err),
    };
    return result;
  }

  const matches: CloudFormationDiagResult["matched_stacks"] = [];
  for (const stackName of stackNames) {
    try {
      const resources = await client.send(
        new ListStackResourcesCommand({ StackName: stackName }),
      );
      for (const res of resources.StackResourceSummaries ?? []) {
        if (res.ResourceType !== "AWS::Lambda::Function") continue;
        const physical = res.PhysicalResourceId ?? "";
        if (
          physical !== functionName &&
          !physical.endsWith(`:function:${functionName}`)
        ) {
          continue;
        }

        const events = await recentEvents(client, stackName, maxEvents);
        matches.push({
          stack_name: stackName,
          logical_id: res.LogicalResourceId,
          resource_status: res.ResourceStatus,
          resource_status_reason: res.ResourceStatusReason,
          last_updated: res.LastUpdatedTimestamp?.toISOString() ?? null,
          recent_events: events,
        });
        break;
      }
    } catch {
      continue;
    }
    if (matches.length >= 3) break;
  }

  result.matched_stacks = matches;
  if (!matches.length) {
    result.note =
      "No CloudFormation stack resource matched this function name (it may be unmanaged or named differently).";
  }
  return result;
}

async function recentEvents(
  client: CloudFormationClient,
  stackName: string,
  maxEvents: number,
) {
  try {
    const resp = await client.send(
      new DescribeStackEventsCommand({ StackName: stackName }),
    );
    return (resp.StackEvents ?? []).slice(0, maxEvents).map((ev) => ({
      timestamp: ev.Timestamp?.toISOString() ?? null,
      logical_id: ev.LogicalResourceId,
      type: ev.ResourceType,
      status: ev.ResourceStatus,
      reason: ev.ResourceStatusReason,
    }));
  } catch {
    return [];
  }
}
