import { getApiEndpoint } from "./config";

export type CreateUploadResponse = {
  uploadUrl: string;
  objectKey: string;
  contentType: string;
  expiresInSeconds: number;
};

export type ProcessAudioResponse = {
  status: string;
  objectKey: string | null;
  contentType: string | null;
  contentLength: number | null;
  transcript: string;
  replyText: string;
  replyObjectKey: string;
  replyAudioUrl: string;
  replyAudioExpiresInSeconds: number;
};

function apiBase(): string {
  const base = getApiEndpoint();
  if (!base) {
    throw new Error(
      "API URL is not set. Paste your ApiEndpoint on the home page (from sam deploy).",
    );
  }
  return base;
}

async function readError(res: Response): Promise<{ error: string }> {
  try {
    return (await res.json()) as { error: string };
  } catch {
    return { error: res.statusText || "Request failed" };
  }
}

/** Ask the backend for a short-lived S3 PUT URL. */
export async function createUpload(
  contentType: string,
): Promise<CreateUploadResponse> {
  const res = await fetch(`${apiBase()}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contentType }),
  });

  if (!res.ok) {
    const err = await readError(res);
    throw new Error(err.error || `createUpload failed (${res.status})`);
  }

  return (await res.json()) as CreateUploadResponse;
}

/** PUT the recording bytes straight to S3 via the presigned URL. */
export async function uploadToS3(
  uploadUrl: string,
  blob: Blob,
  contentType: string,
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: blob,
  });

  if (!res.ok) {
    throw new Error(`S3 upload failed (${res.status})`);
  }
}

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

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

export type ListedResource = {
  id: string;
  name: string;
  arn?: string;
  region?: string;
  meta?: string;
};

export type ListResourcesResponse = {
  ok: boolean;
  type: string;
  region: string;
  count: number;
  truncated: boolean;
  resources: ListedResource[];
  investigate_supported: boolean;
  error?: { code: string; message: string };
};

export type InvestigationScope = {
  type: ResourceType;
  name: string;
  id: string;
  region: string;
  arn?: string;
};

export async function fetchResources(
  type: ResourceType,
  region?: string,
): Promise<ListResourcesResponse> {
  const qs = new URLSearchParams({ type });
  if (region) qs.set("region", region);
  const res = await fetch(`${apiBase()}/resources?${qs.toString()}`);
  if (!res.ok) {
    const err = await readError(res);
    throw new Error(err.error || `list resources failed (${res.status})`);
  }
  return (await res.json()) as ListResourcesResponse;
}

/** Transcribe → reason → synthesize; returns reply text + signed audio URL. */
export async function processAudio(
  objectKey: string,
  history: ChatTurn[] = [],
  scope: InvestigationScope | null = null,
): Promise<ProcessAudioResponse> {
  const res = await fetch(`${apiBase()}/process`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objectKey, history, scope }),
  });

  if (!res.ok) {
    const err = await readError(res);
    throw new Error(err.error || `processAudio failed (${res.status})`);
  }

  return (await res.json()) as ProcessAudioResponse;
}

/** Spoken greeting via ElevenLabs (no mic upload). */
export async function fetchGreeting(
  scope: InvestigationScope | null = null,
): Promise<ProcessAudioResponse> {
  const res = await fetch(`${apiBase()}/process`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ greet: true, scope }),
  });

  if (!res.ok) {
    const err = await readError(res);
    throw new Error(err.error || `greeting failed (${res.status})`);
  }

  return (await res.json()) as ProcessAudioResponse;
}

/** Full flow: presign → S3 PUT → process (Whisper + chat + ElevenLabs). */
export async function submitRecording(
  blob: Blob,
  contentType: string,
  history: ChatTurn[] = [],
  scope: InvestigationScope | null = null,
) {
  const { uploadUrl, objectKey, contentType: signedType } =
    await createUpload(contentType);
  await uploadToS3(uploadUrl, blob, signedType);
  return processAudio(objectKey, history, scope);
}
