import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListDeadLetterSourceQueuesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

export interface SqsDiagResult {
  ok: boolean;
  region: string;
  queue_name: string;
  queue_url?: string;
  approximate_messages?: number;
  approximate_messages_not_visible?: number;
  approximate_messages_delayed?: number;
  visibility_timeout_seconds?: number;
  message_retention_seconds?: number;
  receive_wait_time_seconds?: number;
  delay_seconds?: number;
  created_timestamp?: string | null;
  last_modified_timestamp?: string | null;
  redrive_policy?: {
    deadLetterTargetArn?: string;
    maxReceiveCount?: number;
  } | null;
  is_dead_letter_queue?: boolean;
  dead_letter_source_queues?: string[];
  error?: { code: string; message: string };
}

function parseIntAttr(attrs: Record<string, string> | undefined, key: string) {
  const raw = attrs?.[key];
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseEpoch(attrs: Record<string, string> | undefined, key: string) {
  const n = parseIntAttr(attrs, key);
  if (n == null) return null;
  return new Date(n * 1000).toISOString();
}

export async function collectSqs(
  queueNameOrUrl: string,
  region: string,
): Promise<SqsDiagResult> {
  const client = new SQSClient({ region });
  const input = queueNameOrUrl.trim();
  const base: SqsDiagResult = {
    ok: false,
    region,
    queue_name: input,
  };

  try {
    let queueUrl = input;
    if (!input.startsWith("https://") && !input.startsWith("http://")) {
      const urlResp = await client.send(
        new GetQueueUrlCommand({ QueueName: input }),
      );
      if (!urlResp.QueueUrl) {
        return {
          ...base,
          error: { code: "NotFound", message: `Queue not found: ${input}` },
        };
      }
      queueUrl = urlResp.QueueUrl;
    }

    const nameFromUrl = queueUrl.split("/").pop() || input;
    base.queue_name = nameFromUrl;
    base.queue_url = queueUrl;

    const attrsResp = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["All"],
      }),
    );
    const attrs = (attrsResp.Attributes ?? {}) as Record<string, string>;

    let redrive: SqsDiagResult["redrive_policy"] = null;
    if (attrs.RedrivePolicy) {
      try {
        const parsed = JSON.parse(attrs.RedrivePolicy) as {
          deadLetterTargetArn?: string;
          maxReceiveCount?: number | string;
        };
        redrive = {
          deadLetterTargetArn: parsed.deadLetterTargetArn,
          maxReceiveCount:
            parsed.maxReceiveCount != null
              ? Number(parsed.maxReceiveCount)
              : undefined,
        };
      } catch {
        redrive = null;
      }
    }

    let deadLetterSources: string[] = [];
    let isDlq = false;
    try {
      const sources = await client.send(
        new ListDeadLetterSourceQueuesCommand({ QueueUrl: queueUrl }),
      );
      deadLetterSources = sources.queueUrls ?? [];
      isDlq = deadLetterSources.length > 0;
    } catch {
      // Not every queue supports this call the same way; ignore.
    }

    return {
      ok: true,
      region,
      queue_name: nameFromUrl,
      queue_url: queueUrl,
      approximate_messages: parseIntAttr(attrs, "ApproximateNumberOfMessages"),
      approximate_messages_not_visible: parseIntAttr(
        attrs,
        "ApproximateNumberOfMessagesNotVisible",
      ),
      approximate_messages_delayed: parseIntAttr(
        attrs,
        "ApproximateNumberOfMessagesDelayed",
      ),
      visibility_timeout_seconds: parseIntAttr(attrs, "VisibilityTimeout"),
      message_retention_seconds: parseIntAttr(attrs, "MessageRetentionPeriod"),
      receive_wait_time_seconds: parseIntAttr(attrs, "ReceiveMessageWaitTimeSeconds"),
      delay_seconds: parseIntAttr(attrs, "DelaySeconds"),
      created_timestamp: parseEpoch(attrs, "CreatedTimestamp"),
      last_modified_timestamp: parseEpoch(attrs, "LastModifiedTimestamp"),
      redrive_policy: redrive,
      is_dead_letter_queue: isDlq,
      dead_letter_source_queues: deadLetterSources.map(
        (u) => u.split("/").pop() || u,
      ),
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: { code: e.name || "SqsError", message: e.message || String(err) },
    };
  }
}
