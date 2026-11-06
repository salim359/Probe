import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const sm = new SecretsManagerClient({});

type Cache = {
  openaiApiKey?: string;
  elevenLabsApiKey?: string;
};

const cache: Cache = {};

async function readSecretJson(secretId: string): Promise<Record<string, string>> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) {
    throw new Error(`Secret "${secretId}" has no SecretString`);
  }

  try {
    return JSON.parse(res.SecretString) as Record<string, string>;
  } catch {
    // Plain-string secrets are supported as a fallback
    return { value: res.SecretString };
  }
}

function pickKey(
  json: Record<string, string>,
  preferredKey: string,
  fallbacks: string[],
): string | undefined {
  const candidates = [preferredKey, ...fallbacks, "value"];
  for (const key of candidates) {
    const v = json[key]?.trim();
    if (v) return v;
  }
  // If the secret JSON has exactly one string field, use it
  const values = Object.values(json).map((v) => v?.trim()).filter(Boolean);
  return values.length === 1 ? values[0] : undefined;
}

export async function getOpenAIApiKey(): Promise<string> {
  if (cache.openaiApiKey) return cache.openaiApiKey;

  const secretId = process.env.OPENAI_SECRET_NAME ?? "cloud-companion/openai2";
  const jsonKey =
    process.env.OPENAI_SECRET_JSON_KEY ?? "cloud-companion/openai2";
  const json = await readSecretJson(secretId);
  const key = pickKey(json, jsonKey, [
    "cloud-companion/openai",
    "apiKey",
    "OPENAI_API_KEY",
    "openai",
  ]);

  if (!key) {
    throw new Error(
      `Could not find OpenAI API key in secret "${secretId}" (expected JSON key "${jsonKey}")`,
    );
  }

  cache.openaiApiKey = key;
  return key;
}

export async function getElevenLabsApiKey(): Promise<string> {
  if (cache.elevenLabsApiKey) return cache.elevenLabsApiKey;

  const secretId =
    process.env.ELEVENLABS_SECRET_NAME ?? "cloud-companion/elevenlabs2";
  const jsonKey =
    process.env.ELEVENLABS_SECRET_JSON_KEY ?? "cloud-companion/elevenlabs2";
  const json = await readSecretJson(secretId);
  const key = pickKey(json, jsonKey, [
    "cloud-companion/elevenlabs",
    "apiKey",
    "ELEVENLABS_API_KEY",
    "elevenlabs",
  ]);

  if (!key) {
    throw new Error(
      `Could not find ElevenLabs API key in secret "${secretId}" (expected JSON key "${jsonKey}")`,
    );
  }

  cache.elevenLabsApiKey = key;
  return key;
}
