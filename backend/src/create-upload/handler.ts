import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

const s3 = new S3Client({});
const bucket = process.env.AUDIO_BUCKET;

const ALLOWED_CONTENT_TYPES = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
]);

type CreateUploadBody = {
  contentType?: string;
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function normalizeContentType(raw: string): string {
  return raw.trim().toLowerCase();
}

function extensionFor(contentType: string): string {
  if (contentType.startsWith("audio/webm")) return "webm";
  if (contentType.startsWith("audio/ogg")) return "ogg";
  if (contentType === "audio/mp4") return "m4a";
  if (contentType === "audio/mpeg") return "mp3";
  if (contentType === "audio/wav" || contentType === "audio/x-wav") return "wav";
  return "bin";
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (!bucket) {
    console.error("AUDIO_BUCKET is not configured");
    return json(500, { error: "Server misconfigured" });
  }

  let body: CreateUploadBody = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body) as CreateUploadBody;
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
  }

  const contentType = normalizeContentType(body.contentType ?? "audio/webm");
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return json(400, {
      error: "Unsupported contentType",
      allowed: [...ALLOWED_CONTENT_TYPES],
    });
  }

  // Strip codec suffixes for the S3 object Content-Type header
  const objectContentType = contentType.split(";")[0]!;
  const objectKey = `uploads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extensionFor(contentType)}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ContentType: objectContentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

  return json(200, {
    uploadUrl,
    objectKey,
    contentType: objectContentType,
    expiresInSeconds: 60,
  });
};
