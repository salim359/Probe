import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const TTL_DAYS = 90;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface ChatTurnInput {
  userId: string;
  question: string;
  resourceType?: string | null;
  resourceName?: string | null;
  region?: string | null;
  lookbackMinutes?: number | null;
  result: unknown;
}

export interface ChatTurnRecord {
  userId: string;
  sk: string;
  createdAt: string;
  question: string;
  resourceType: string;
  resourceName: string;
  region: string;
  lookbackMinutes: number | null;
  result: unknown;
  expires_at: number;
}

export function historyTableName(): string | null {
  const name = (process.env.CHAT_HISTORY_TABLE || "").trim();
  return name || null;
}

export function makeTurnSk(createdAt = new Date()): string {
  return `TURN#${createdAt.toISOString()}#${randomUUID()}`;
}

export function expiresAtEpoch(from = new Date()): number {
  return Math.floor(from.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60;
}

export async function putTurn(input: ChatTurnInput): Promise<ChatTurnRecord | null> {
  const table = historyTableName();
  if (!table) return null;
  if (!input.userId) {
    throw new Error("userId is required to save chat history");
  }

  const createdAt = new Date();
  const item: ChatTurnRecord = {
    userId: input.userId,
    sk: makeTurnSk(createdAt),
    createdAt: createdAt.toISOString(),
    question: input.question || "",
    resourceType: (input.resourceType || "lambda").trim() || "lambda",
    resourceName: (input.resourceName || "").trim(),
    region: (input.region || process.env.INVESTIGATION_REGION || "us-east-1").trim(),
    lookbackMinutes:
      input.lookbackMinutes == null ? null : Number(input.lookbackMinutes),
    result: input.result ?? {},
    expires_at: expiresAtEpoch(createdAt),
  };

  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: item,
    }),
  );
  return item;
}

export async function listTurns(
  userId: string,
  limit = DEFAULT_LIST_LIMIT,
): Promise<ChatTurnRecord[]> {
  const table = historyTableName();
  if (!table || !userId) return [];

  const capped = Math.min(
    Math.max(1, Number(limit) || DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );

  const out = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
      ScanIndexForward: false,
      Limit: capped,
    }),
  );

  const items = (out.Items || []) as ChatTurnRecord[];
  // Return chronological (oldest → newest) for UI replay
  return items.slice().reverse();
}

export async function clearTurns(userId: string): Promise<number> {
  const table = historyTableName();
  if (!table || !userId) return 0;

  let deleted = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ProjectionExpression: "userId, sk",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    const keys = (page.Items || []) as Array<{ userId: string; sk: string }>;
    for (let i = 0; i < keys.length; i += 25) {
      const chunk = keys.slice(i, i + 25);
      if (!chunk.length) continue;
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [table]: chunk.map((k) => ({
              DeleteRequest: { Key: { userId: k.userId, sk: k.sk } },
            })),
          },
        }),
      );
      deleted += chunk.length;
    }

    exclusiveStartKey = page.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey);

  return deleted;
}
