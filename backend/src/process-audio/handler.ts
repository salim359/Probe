import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { synthesizeSpeech } from "./elevenlabs";
import {
  generateReply,
  transcribeAudio,
  type ChatTurn,
  type InvestigationScope,
} from "./openai";

const s3 = new S3Client({});
const bucket = process.env.AUDIO_BUCKET;

type ProcessAudioBody = {
  objectKey?: string;
  history?: ChatTurn[];
  scope?: InvestigationScope | null;
  /** When true, skip STT/chat and return a spoken greeting. */
  greet?: boolean;
};

function greetingText(scope?: InvestigationScope | null): string {
  if (scope?.name && scope.type) {
    return `Hi, I'm Probe. You're focused on the ${scope.type} ${scope.name}. What's going on?`;
  }
  return "Hi, I'm Probe, your AWS troubleshooting assistant. What should we look at?";
}

async function putReplyAudio(speech: Uint8Array): Promise<{
  replyObjectKey: string;
  replyAudioUrl: string;
}> {
  const replyObjectKey = `replies/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.mp3`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: replyObjectKey,
      Body: speech,
      ContentType: "audio/mpeg",
    }),
  );
  const replyAudioUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: replyObjectKey }),
    { expiresIn: 300 },
  );
  return { replyObjectKey, replyAudioUrl };
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isSafeObjectKey(key: string): boolean {
  return (
    key.startsWith("uploads/") &&
    !key.includes("..") &&
    key.length < 512 &&
    /^uploads\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[0-9a-f-]{36}\.[a-z0-9]+$/i.test(key)
  );
}

function filenameFromKey(objectKey: string): string {
  const base = objectKey.split("/").pop() ?? "audio.webm";
  return base.includes(".") ? base : `${base}.webm`;
}

async function readObjectBytes(objectKey: string): Promise<{
  bytes: Uint8Array;
  contentType: string | null;
  contentLength: number | null;
}> {
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
  );

  const obj = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
  );
  if (!obj.Body) {
    throw new Error("S3 object has no body");
  }

  const bytes = await obj.Body.transformToByteArray();
  return {
    bytes,
    contentType: head.ContentType ?? obj.ContentType ?? null,
    contentLength: head.ContentLength ?? bytes.byteLength,
  };
}

function isNotFound(err: unknown): boolean {
  const meta =
    err && typeof err === "object" && "$metadata" in err
      ? (err as { $metadata?: { httpStatusCode?: number }; name?: string })
      : undefined;
  const status = meta?.$metadata?.httpStatusCode;
  const name = meta?.name ?? "";
  return status === 404 || name === "NotFound" || name === "NoSuchKey";
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (!bucket) {
    console.error("AUDIO_BUCKET is not configured");
    return json(500, { error: "Server misconfigured" });
  }

  if (!event.body) {
    return json(400, { error: "Missing JSON body" });
  }

  let body: ProcessAudioBody;
  try {
    body = JSON.parse(event.body) as ProcessAudioBody;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (body.greet === true) {
    try {
      const replyText = greetingText(body.scope ?? null);
      const speech = await synthesizeSpeech(replyText);
      const { replyObjectKey, replyAudioUrl } = await putReplyAudio(speech);
      return json(200, {
        status: "ok",
        objectKey: null,
        contentType: null,
        contentLength: null,
        transcript: "",
        replyText,
        replyObjectKey,
        replyAudioUrl,
        replyAudioExpiresInSeconds: 300,
      });
    } catch (err: unknown) {
      console.error("greeting failed", err);
      const message = err instanceof Error ? err.message : "Greeting failed";
      return json(500, { error: message });
    }
  }

  const objectKey = body.objectKey?.trim();
  if (!objectKey || !isSafeObjectKey(objectKey)) {
    return json(400, { error: "Invalid objectKey" });
  }

  try {
    const { bytes, contentType, contentLength } = await readObjectBytes(objectKey);

    const transcript = await transcribeAudio(bytes, filenameFromKey(objectKey));
    const replyText = await generateReply(
      transcript,
      body.history,
      body.scope ?? null,
    );
    const speech = await synthesizeSpeech(replyText);
    const { replyObjectKey, replyAudioUrl } = await putReplyAudio(speech);

    return json(200, {
      status: "ok",
      objectKey,
      contentType,
      contentLength,
      transcript,
      replyText,
      replyObjectKey,
      replyAudioUrl,
      replyAudioExpiresInSeconds: 300,
    });
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return json(404, { error: "Object not found", objectKey });
    }
    console.error("process-audio failed", err);
    const message = err instanceof Error ? err.message : "Processing failed";
    return json(500, { error: message });
  }
};
