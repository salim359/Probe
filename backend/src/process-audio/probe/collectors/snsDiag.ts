import {
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  SNSClient,
} from "@aws-sdk/client-sns";

export interface SnsDiagResult {
  ok: boolean;
  region: string;
  topic_name: string;
  topic_arn?: string;
  subscriptions_confirmed?: number;
  subscriptions_pending?: number;
  subscriptions_deleted?: number;
  display_name?: string | null;
  owner?: string | null;
  effective_delivery_policy?: unknown;
  subscriptions?: Array<{
    subscription_arn: string;
    protocol?: string;
    endpoint?: string;
    owner?: string;
    pending_confirmation?: boolean;
  }>;
  subscription_count_listed?: number;
  error?: { code: string; message: string };
}

function asInt(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function collectSns(
  topicNameOrArn: string,
  region: string,
  accountId?: string,
): Promise<SnsDiagResult> {
  const client = new SNSClient({ region });
  const input = topicNameOrArn.trim();
  const base: SnsDiagResult = {
    ok: false,
    region,
    topic_name: input,
  };

  try {
    let topicArn = input;
    if (!input.startsWith("arn:")) {
      if (!accountId) {
        return {
          ...base,
          error: {
            code: "MissingAccount",
            message: "Need topic ARN or account id to resolve topic name",
          },
        };
      }
      topicArn = `arn:aws:sns:${region}:${accountId}:${input}`;
    }

    const name = topicArn.split(":").pop() || input;
    base.topic_name = name;
    base.topic_arn = topicArn;

    const attrsResp = await client.send(
      new GetTopicAttributesCommand({ TopicArn: topicArn }),
    );
    const attrs = attrsResp.Attributes ?? {};

    const subscriptions: SnsDiagResult["subscriptions"] = [];
    let nextToken: string | undefined;
    do {
      const page = await client.send(
        new ListSubscriptionsByTopicCommand({
          TopicArn: topicArn,
          NextToken: nextToken,
        }),
      );
      for (const sub of page.Subscriptions ?? []) {
        const arn = sub.SubscriptionArn || "";
        const pending = !arn || arn === "PendingConfirmation";
        subscriptions.push({
          subscription_arn: arn || "PendingConfirmation",
          protocol: sub.Protocol,
          endpoint: sub.Endpoint,
          owner: sub.Owner,
          pending_confirmation: pending,
        });
      }
      nextToken = page.NextToken;
    } while (nextToken && subscriptions.length < 50);

    // Enrich a few confirmed subscriptions with filter/raw delivery attrs
    for (const sub of subscriptions.slice(0, 10)) {
      if (sub.pending_confirmation || !sub.subscription_arn.startsWith("arn:")) {
        continue;
      }
      try {
        const detail = await client.send(
          new GetSubscriptionAttributesCommand({
            SubscriptionArn: sub.subscription_arn,
          }),
        );
        const sa = detail.Attributes ?? {};
        if (sa.FilterPolicy) {
          (sub as { filter_policy?: string }).filter_policy = sa.FilterPolicy;
        }
        if (sa.RawMessageDelivery) {
          (sub as { raw_message_delivery?: string }).raw_message_delivery =
            sa.RawMessageDelivery;
        }
      } catch {
        /* ignore per-sub failures */
      }
    }

    let deliveryPolicy: unknown = null;
    if (attrs.EffectiveDeliveryPolicy) {
      try {
        deliveryPolicy = JSON.parse(attrs.EffectiveDeliveryPolicy);
      } catch {
        deliveryPolicy = attrs.EffectiveDeliveryPolicy;
      }
    }

    return {
      ok: true,
      region,
      topic_name: name,
      topic_arn: topicArn,
      subscriptions_confirmed: asInt(attrs.SubscriptionsConfirmed),
      subscriptions_pending: asInt(attrs.SubscriptionsPending),
      subscriptions_deleted: asInt(attrs.SubscriptionsDeleted),
      display_name: attrs.DisplayName || null,
      owner: attrs.Owner || null,
      effective_delivery_policy: deliveryPolicy,
      subscriptions,
      subscription_count_listed: subscriptions.length,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: { code: e.name || "SnsError", message: e.message || String(err) },
    };
  }
}
