import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { listAlarms } from "./probe/alarms";
import {
  collectAlarm,
  collectApiGateway,
  collectBudget,
  collectDynamo,
  collectEc2,
  collectLogGroup,
  collectS3,
  collectSns,
  collectSqs,
  listBudgets,
} from "./probe/collectors";
import { collectLambdaEvidence } from "./probe/investigate";
import { listResources, RESOURCE_TYPES } from "./probe/listResources";

const sts = new STSClient({});
const DEFAULT_REGION = process.env.INVESTIGATION_REGION || "us-east-1";

let cachedAccountId: string | null = null;

async function accountId(): Promise<string> {
  if (cachedAccountId) return cachedAccountId;
  const id = await sts.send(new GetCallerIdentityCommand({}));
  cachedAccountId = id.Account || "";
  return cachedAccountId;
}

function truncate(value: unknown, max = 6000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? String(args[key]).trim() : "";
}

export const awsTroubleshootTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_account_identity",
      description: "Get AWS account ID, caller ARN, and investigation region.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_alarms",
      description:
        "List CloudWatch alarms (optionally only those in ALARM state).",
      parameters: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: ["ALARM", "OK", "INSUFFICIENT_DATA", "ANY"],
          },
          maxResults: { type: "number" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_resources",
      description:
        "List resources: lambda, s3, ec2, dynamodb, sqs, sns, apigateway, loggroup, alarm, budget.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...RESOURCE_TYPES] },
          region: { type: "string" },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_alarm",
      description:
        "Why a CloudWatch alarm is ALARM/OK: threshold, metric, state reason, recent state history.",
      parameters: {
        type: "object",
        properties: {
          alarmName: { type: "string" },
          region: { type: "string" },
        },
        required: ["alarmName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_budgets",
      description:
        "List AWS Budgets with limit, actual spend, and forecasted spend for the current period.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_budget",
      description:
        "Budget limit, actual spend so far, forecasted spend for the period, and % of budget used.",
      parameters: {
        type: "object",
        properties: {
          budgetName: { type: "string" },
        },
        required: ["budgetName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "investigate_lambda",
      description:
        "Deep-investigate a Lambda: config, logs, metrics, CloudFormation.",
      parameters: {
        type: "object",
        properties: {
          functionName: { type: "string" },
          region: { type: "string" },
          question: { type: "string" },
          lookbackMinutes: { type: "number" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_sqs_queue",
      description:
        "SQS queue depth (visible/in-flight/delayed), retention, DLQ redrive, whether queue is a DLQ.",
      parameters: {
        type: "object",
        properties: {
          queueName: { type: "string" },
          region: { type: "string" },
        },
        required: ["queueName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_sns_topic",
      description:
        "SNS topic subscription counts and endpoint/protocol details.",
      parameters: {
        type: "object",
        properties: {
          topicName: { type: "string" },
          region: { type: "string" },
        },
        required: ["topicName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_s3_bucket",
      description:
        "S3 bucket region, versioning, approximate object count/size, sample keys.",
      parameters: {
        type: "object",
        properties: {
          bucketName: { type: "string" },
          region: { type: "string" },
        },
        required: ["bucketName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_ec2_instance",
      description:
        "EC2 instance state, networking, security groups, status checks, CPU/network metrics.",
      parameters: {
        type: "object",
        properties: {
          instanceId: {
            type: "string",
            description: "Instance id (i-…) or Name tag",
          },
          region: { type: "string" },
        },
        required: ["instanceId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_dynamodb_table",
      description:
        "DynamoDB table status, item count/size, capacity/billing, TTL, throttle/error metrics.",
      parameters: {
        type: "object",
        properties: {
          tableName: { type: "string" },
          region: { type: "string" },
        },
        required: ["tableName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_apigateway",
      description:
        "API Gateway REST API stages, sample methods/integrations, 4xx/5xx/latency metrics.",
      parameters: {
        type: "object",
        properties: {
          apiId: {
            type: "string",
            description: "REST API id from the resource list",
          },
          region: { type: "string" },
        },
        required: ["apiId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_log_group",
      description:
        "CloudWatch log group size/retention, recent streams, recent error-like events.",
      parameters: {
        type: "object",
        properties: {
          logGroupName: { type: "string" },
          region: { type: "string" },
          lookbackMinutes: { type: "number" },
        },
        required: ["logGroupName"],
        additionalProperties: false,
      },
    },
  },
];

type ToolArgs = Record<string, unknown>;

export async function runAwsTool(
  name: string,
  rawArgs: string,
): Promise<string> {
  let args: ToolArgs = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as ToolArgs) : {};
  } catch {
    return JSON.stringify({ error: "Invalid tool arguments JSON" });
  }

  const region = str(args, "region") || DEFAULT_REGION;

  try {
    switch (name) {
      case "get_account_identity": {
        const id = await sts.send(new GetCallerIdentityCommand({}));
        return truncate({
          account: id.Account,
          arn: id.Arn,
          region: DEFAULT_REGION,
        });
      }

      case "list_alarms": {
        const stateRaw = String(args.state ?? "ALARM");
        const state =
          stateRaw === "ANY" || stateRaw === "ALL" ? "ALL" : stateRaw;
        const result = await listAlarms(DEFAULT_REGION, { state });
        if (
          typeof args.maxResults === "number" &&
          Number.isFinite(args.maxResults) &&
          result.ok
        ) {
          const max = Math.min(Math.max(1, Math.floor(args.maxResults)), 25);
          return truncate({
            ...result,
            alarms: result.alarms.slice(0, max),
            count: Math.min(result.count, max),
          });
        }
        return truncate(result);
      }

      case "list_resources":
        return truncate(await listResources(str(args, "type"), region));

      case "investigate_lambda":
        return truncate(
          await collectLambdaEvidence({
            functionName: str(args, "functionName") || null,
            region,
            question: str(args, "question") || null,
            lookbackMinutes:
              typeof args.lookbackMinutes === "number"
                ? args.lookbackMinutes
                : null,
          }),
        );

      case "inspect_sqs_queue": {
        const queueName = str(args, "queueName");
        if (!queueName) return JSON.stringify({ error: "queueName required" });
        return truncate(await collectSqs(queueName, region));
      }

      case "inspect_sns_topic": {
        const topicName = str(args, "topicName");
        if (!topicName) return JSON.stringify({ error: "topicName required" });
        return truncate(await collectSns(topicName, region, await accountId()));
      }

      case "inspect_s3_bucket": {
        const bucketName = str(args, "bucketName");
        if (!bucketName) return JSON.stringify({ error: "bucketName required" });
        return truncate(await collectS3(bucketName, region));
      }

      case "inspect_ec2_instance": {
        const instanceId = str(args, "instanceId");
        if (!instanceId) return JSON.stringify({ error: "instanceId required" });
        return truncate(await collectEc2(instanceId, region));
      }

      case "inspect_dynamodb_table": {
        const tableName = str(args, "tableName");
        if (!tableName) return JSON.stringify({ error: "tableName required" });
        return truncate(await collectDynamo(tableName, region));
      }

      case "inspect_apigateway": {
        const apiId = str(args, "apiId");
        if (!apiId) return JSON.stringify({ error: "apiId required" });
        return truncate(await collectApiGateway(apiId, region));
      }

      case "inspect_log_group": {
        const logGroupName = str(args, "logGroupName");
        if (!logGroupName) {
          return JSON.stringify({ error: "logGroupName required" });
        }
        return truncate(
          await collectLogGroup(logGroupName, region, {
            lookbackMinutes:
              typeof args.lookbackMinutes === "number"
                ? args.lookbackMinutes
                : 60,
          }),
        );
      }

      case "inspect_alarm": {
        const alarmName = str(args, "alarmName");
        if (!alarmName) return JSON.stringify({ error: "alarmName required" });
        return truncate(await collectAlarm(alarmName, region));
      }

      case "list_budgets":
        return truncate(await listBudgets());

      case "inspect_budget": {
        const budgetName = str(args, "budgetName");
        if (!budgetName) return JSON.stringify({ error: "budgetName required" });
        return truncate(await collectBudget(budgetName));
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool failed";
    return JSON.stringify({ error: message });
  }
}
