import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";
import { listAlarms } from "./alarms";
import { clearTurns, listTurns, putTurn } from "./history";
import { listResources, RESOURCE_TYPES } from "./listResources";
import { investigate } from "./orchestrator";

const log = console;

interface LexSlotValue {
  value?: { interpretedValue?: string; originalValue?: string };
}

interface LexEvent {
  sessionId?: string;
  inputTranscript?: string;
  invocationSource?: string;
  bot?: { id?: string; name?: string };
  sessionState?: {
    intent?: {
      name?: string;
      state?: string;
      slots?: Record<string, LexSlotValue | null>;
    };
  };
}

type DirectEvent = {
  function_name?: string;
  region?: string;
  question?: string;
  lookback_minutes?: number;
  max_log_events?: number;
  include_cloudformation?: boolean;
  resource_type?: string;
};

type HistoryPostBody = {
  question?: string;
  resource_type?: string;
  resource_name?: string;
  region?: string;
  lookback_minutes?: number;
  result?: unknown;
};

export const handler: Handler = async (event: unknown) => {
  const e = event as Record<string, unknown>;

  if (isLexEvent(e)) {
    return handleLex(e as LexEvent);
  }
  if (isApiEvent(e)) {
    return handleApi(e as unknown as APIGatewayProxyEvent);
  }
  if ("function_name" in e || "question" in e) {
    return investigateFromPayload(e as DirectEvent);
  }

  return {
    ok: false,
    error: {
      code: "UnsupportedEvent",
      message:
        "Expected Lex V2, API Gateway, or direct investigate payload.",
    },
  };
};

function isLexEvent(event: Record<string, unknown>): boolean {
  return (
    "sessionState" in event &&
    ("invocationSource" in event || "bot" in event)
  );
}

function isApiEvent(event: Record<string, unknown>): boolean {
  if (!("requestContext" in event)) return false;
  const rc = event.requestContext as Record<string, unknown>;
  return "http" in rc || event.httpMethod != null;
}

function apiPath(event: APIGatewayProxyEvent): string {
  const raw =
    event.path ||
    event.resource ||
    (event.requestContext as { resourcePath?: string })?.resourcePath ||
    "";
  return raw.replace(/\/+$/, "") || "/";
}

async function investigateFromPayload(payload: DirectEvent) {
  return investigate({
    functionName: payload.function_name,
    region: payload.region,
    question: payload.question,
    lookbackMinutes: payload.lookback_minutes,
    maxLogEvents: payload.max_log_events,
    includeCloudFormation: payload.include_cloudformation ?? true,
  });
}

async function handleApi(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const claims =
    (event.requestContext.authorizer?.claims as
      | Record<string, string>
      | undefined) ?? {};
  const caller =
    claims.email || claims["cognito:username"] || claims.sub || "unknown";
  const userId = claims.sub || caller;
  const method = (event.httpMethod || "GET").toUpperCase();
  const path = apiPath(event);

  log.info(JSON.stringify({ msg: "api_authorized", caller, method, path }));

  if (method === "GET" && path.endsWith("/resources")) {
    return handleListResources(event, caller);
  }

  if (method === "GET" && path.endsWith("/alarms")) {
    return handleListAlarms(event, caller);
  }

  if (method === "POST" && path.endsWith("/investigate")) {
    return handleInvestigate(event, caller, userId);
  }

  if (path.endsWith("/history")) {
    if (method === "GET") return handleListHistory(event, userId, caller);
    if (method === "POST") return handlePutHistory(event, userId, caller);
    if (method === "DELETE") return handleClearHistory(userId, caller);
  }

  return apiResponse(404, {
    ok: false,
    error: {
      code: "NotFound",
      message: `No route for ${method} ${path}`,
    },
  });
}

async function handleListResources(
  event: APIGatewayProxyEvent,
  caller: string,
): Promise<APIGatewayProxyResult> {
  const params = event.queryStringParameters || {};
  const type = (params.type || "").trim();
  const region =
    (params.region || "").trim() ||
    process.env.INVESTIGATION_REGION ||
    "us-east-1";

  if (!type) {
    return apiResponse(200, {
      ok: true,
      types: RESOURCE_TYPES,
      investigate_supported: ["lambda"],
      caller,
    });
  }

  const result = await listResources(type, region);
  return apiResponse(result.ok ? 200 : 400, { ...result, caller });
}

async function handleListAlarms(
  event: APIGatewayProxyEvent,
  caller: string,
): Promise<APIGatewayProxyResult> {
  const params = event.queryStringParameters || {};
  const region =
    (params.region || "").trim() ||
    process.env.INVESTIGATION_REGION ||
    "us-east-1";
  const state = (params.state || "ALARM").trim();

  const result = await listAlarms(region, { state });
  return apiResponse(result.ok ? 200 : 400, { ...result, caller });
}

async function handleInvestigate(
  event: APIGatewayProxyEvent,
  caller: string,
  userId: string,
): Promise<APIGatewayProxyResult> {
  let payload: DirectEvent;
  try {
    payload = parseJsonBody<DirectEvent>(event);
  } catch (err) {
    return apiResponse(400, {
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }

  if (!payload || typeof payload !== "object") {
    return apiResponse(400, {
      ok: false,
      error: { message: "JSON object required" },
    });
  }

  const result = await investigateFromPayload(payload);

  try {
    await putTurn({
      userId,
      question: payload.question || "",
      resourceType: payload.resource_type || "lambda",
      resourceName: payload.function_name || null,
      region: payload.region || null,
      lookbackMinutes: payload.lookback_minutes ?? null,
      result,
    });
  } catch (err) {
    log.warn(
      JSON.stringify({
        msg: "chat_history_save_failed",
        caller,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return apiResponse(200, { ...result, caller });
}

async function handleListHistory(
  event: APIGatewayProxyEvent,
  userId: string,
  caller: string,
): Promise<APIGatewayProxyResult> {
  const params = event.queryStringParameters || {};
  const limit = Number(params.limit || "50");
  try {
    const turns = await listTurns(userId, limit);
    return apiResponse(200, {
      ok: true,
      caller,
      count: turns.length,
      turns,
    });
  } catch (err) {
    return apiResponse(500, {
      ok: false,
      error: {
        code: "HistoryListFailed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function handlePutHistory(
  event: APIGatewayProxyEvent,
  userId: string,
  caller: string,
): Promise<APIGatewayProxyResult> {
  let payload: HistoryPostBody;
  try {
    payload = parseJsonBody<HistoryPostBody>(event);
  } catch (err) {
    return apiResponse(400, {
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }

  if (!payload || typeof payload !== "object" || payload.result == null) {
    return apiResponse(400, {
      ok: false,
      error: { message: "JSON object with result is required" },
    });
  }

  try {
    const turn = await putTurn({
      userId,
      question: payload.question || "",
      resourceType: payload.resource_type || "guided",
      resourceName: payload.resource_name || null,
      region: payload.region || null,
      lookbackMinutes: payload.lookback_minutes ?? null,
      result: payload.result,
    });
    return apiResponse(200, { ok: true, caller, turn });
  } catch (err) {
    return apiResponse(500, {
      ok: false,
      error: {
        code: "HistorySaveFailed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function handleClearHistory(
  userId: string,
  caller: string,
): Promise<APIGatewayProxyResult> {
  try {
    const deleted = await clearTurns(userId);
    return apiResponse(200, { ok: true, caller, deleted });
  } catch (err) {
    return apiResponse(500, {
      ok: false,
      error: {
        code: "HistoryClearFailed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

function parseJsonBody<T>(event: APIGatewayProxyEvent): T {
  let body = event.body || "{}";
  if (event.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  const parsed = JSON.parse(body) as T;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("JSON object required");
  }
  return parsed;
}

function apiResponse(
  status: number,
  body: unknown,
): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

async function handleLex(event: LexEvent) {
  const invocation = event.invocationSource;
  const intent = event.sessionState?.intent ?? {};
  const slots = intent.slots ?? {};

  if (invocation === "DialogCodeHook") {
    return {
      sessionState: {
        dialogAction: { type: "Delegate" },
        intent,
      },
      messages: [],
    };
  }

  const functionName = slotValue(slots.FunctionName);
  const region = slotValue(slots.Region);
  const inputTranscript = event.inputTranscript || "";

  if (intent.name === "FallbackIntent" || !functionName) {
    const result = await investigate({
      question: inputTranscript,
      region: region || null,
    });
    if (
      !(result as { resource?: { name?: string } }).resource?.name &&
      !functionName
    ) {
      return lexClose(
        intent,
        "Failed",
        'I can investigate Lambda errors using CloudWatch evidence. Tell me the function name, for example: "Investigate Lambda my-function".',
      );
    }
    return lexClose(
      intent,
      result.ok ? "Fulfilled" : "Failed",
      formatLexMessage(result),
    );
  }

  const result = await investigate({
    functionName,
    region,
    question: inputTranscript || `Why is Lambda ${functionName} failing?`,
  });
  return lexClose(
    intent,
    result.ok ? "Fulfilled" : "Failed",
    formatLexMessage(result),
  );
}

function slotValue(slot: LexSlotValue | null | undefined): string | null {
  if (!slot?.value) return null;
  const interpreted =
    slot.value.interpretedValue || slot.value.originalValue;
  return interpreted ? String(interpreted).trim() : null;
}

function lexClose(
  intent: Record<string, unknown>,
  state: string,
  message: string,
) {
  return {
    sessionState: {
      dialogAction: { type: "Close" },
      intent: { ...intent, state },
    },
    messages: [
      {
        contentType: "PlainText",
        content: message.slice(0, 1000),
      },
    ],
  };
}

function formatLexMessage(result: {
  findings?: {
    summary?: string;
    likely_causes?: Array<{ cause?: string; confidence?: string } | string>;
    recommended_next_steps?: string[];
  };
  resource?: { name?: string; region?: string };
  error?: { message?: string };
  ok?: boolean;
}): string {
  const findings = result.findings || {};
  const summary = findings.summary || "No summary available.";
  const causes = findings.likely_causes || [];
  const steps = findings.recommended_next_steps || [];
  const parts: string[] = [];

  if (result.resource?.name) {
    parts.push(
      `Investigated ${result.resource.name} in ${result.resource.region}.`,
    );
  }
  parts.push(summary);

  if (causes.length) {
    const top = causes[0];
    if (typeof top === "string") {
      parts.push(`Top likely cause: ${top}`);
    } else {
      const conf = top.confidence ? ` (${top.confidence})` : "";
      parts.push(`Top likely cause${conf}: ${top.cause}`);
    }
  }
  if (steps.length) parts.push(`Next step: ${steps[0]}`);
  if (result.error?.message) parts.push(result.error.message);

  return parts.join(" ");
}
