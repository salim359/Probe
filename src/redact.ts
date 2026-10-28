/** Sanitize evidence before it leaves AWS (OpenAI / responses). */

const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/gi,
    replacement: "[REDACTED_AWS_ACCESS_KEY]",
  },
  {
    pattern:
      /(aws_secret_access_key|secret_access_key|secretAccessKey)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{20,})['"]?/gi,
    replacement: "$1=[REDACTED_AWS_SECRET]",
  },
  {
    pattern: /(authorization|x-amz-security-token|x-api-key)\s*[:=]\s*\S+/gi,
    replacement: "$1: [REDACTED]",
  },
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: "$1 [REDACTED_TOKEN]",
  },
  {
    pattern:
      /(api[_-]?key|openai[_-]?api[_-]?key|token|password|passwd|secret)\s*[=:]\s*['"]?([^\s'"]{8,})['"]?/gi,
    replacement: "$1=[REDACTED]",
  },
  {
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
];

export function redactText(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;
  for (const { pattern, replacement } of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactValue<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v)) as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out as T;
  }
  return value;
}
