import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  listResources,
  RESOURCE_TYPES,
} from "../process-audio/probe/listResources";

const DEFAULT_REGION = process.env.INVESTIGATION_REGION || "us-east-1";

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const params = event.queryStringParameters ?? {};
  const type = (params.type || "").trim();
  const region = (params.region || "").trim() || DEFAULT_REGION;

  if (!type) {
    return json(200, {
      ok: true,
      types: RESOURCE_TYPES,
      investigate_supported: ["lambda"],
      region,
    });
  }

  const result = await listResources(type, region);
  return json(result.ok ? 200 : 400, result);
};
