import {
  APIGatewayClient,
  GetRestApiCommand,
  GetStagesCommand,
  GetResourcesCommand,
  GetMethodCommand,
} from "@aws-sdk/client-api-gateway";
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

export interface ApiGatewayDiagResult {
  ok: boolean;
  region: string;
  api_id: string;
  name?: string | null;
  description?: string | null;
  created_date?: string | null;
  endpoint_types?: string[];
  stages?: Array<{
    name: string;
    deployment_id?: string | null;
    tracing_enabled?: boolean;
    caching_enabled?: boolean;
    web_acl_arn?: string | null;
  }>;
  resource_count?: number;
  methods_sample?: Array<{
    path: string;
    method: string;
    integration_type?: string | null;
    authorization_type?: string | null;
    api_key_required?: boolean;
  }>;
  metrics_1h?: {
    count_sum?: number | null;
    latency_avg_ms?: number | null;
    "4xx_sum"?: number | null;
    "5xx_sum"?: number | null;
  };
  error?: { code: string; message: string };
}

export async function collectApiGateway(
  apiIdOrName: string,
  region: string,
): Promise<ApiGatewayDiagResult> {
  const client = new APIGatewayClient({ region });
  const input = apiIdOrName.trim();
  const base: ApiGatewayDiagResult = {
    ok: false,
    region,
    api_id: input,
  };

  try {
    // Prefer treating input as API id; if GetRestApi fails, caller should pass id from list.
    const api = await client.send(new GetRestApiCommand({ restApiId: input }));
    const apiId = api.id || input;

    const stagesResp = await client.send(
      new GetStagesCommand({ restApiId: apiId }),
    );
    const stages = (stagesResp.item ?? []).map((s) => ({
      name: s.stageName || "",
      deployment_id: s.deploymentId ?? null,
      tracing_enabled: Boolean(s.tracingEnabled),
      caching_enabled: Boolean(s.cacheClusterEnabled),
      web_acl_arn: s.webAclArn ?? null,
    }));

    const resourcesResp = await client.send(
      new GetResourcesCommand({ restApiId: apiId, limit: 50, embed: ["methods"] }),
    );
    const resources = resourcesResp.items ?? [];
    const methods_sample: ApiGatewayDiagResult["methods_sample"] = [];

    for (const res of resources) {
      const methods = Object.keys(res.resourceMethods ?? {}).filter(
        (m) => m !== "OPTIONS",
      );
      for (const method of methods.slice(0, 3)) {
        if (methods_sample.length >= 12) break;
        try {
          const m = await client.send(
            new GetMethodCommand({
              restApiId: apiId,
              resourceId: res.id!,
              httpMethod: method,
            }),
          );
          methods_sample.push({
            path: res.path || "/",
            method,
            integration_type: m.methodIntegration?.type ?? null,
            authorization_type: m.authorizationType ?? null,
            api_key_required: Boolean(m.apiKeyRequired),
          });
        } catch {
          methods_sample.push({
            path: res.path || "/",
            method,
          });
        }
      }
      if (methods_sample.length >= 12) break;
    }

    const stageName = stages[0]?.name;
    const metrics_1h = stageName
      ? await fetchApiMetrics(apiId, stageName, region)
      : undefined;

    return {
      ok: true,
      region,
      api_id: apiId,
      name: api.name ?? null,
      description: api.description ?? null,
      created_date: api.createdDate?.toISOString() ?? null,
      endpoint_types: api.endpointConfiguration?.types ?? [],
      stages,
      resource_count: resources.length,
      methods_sample,
      metrics_1h,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: {
        code: e.name || "ApiGatewayError",
        message: e.message || String(err),
      },
    };
  }
}

async function fetchApiMetrics(
  apiId: string,
  stage: string,
  region: string,
) {
  try {
    const cw = new CloudWatchClient({ region });
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const dim = [
      { Name: "ApiName", Value: apiId },
      { Name: "Stage", Value: stage },
    ];
    // ApiGateway metrics often use ApiName = name, not id. Try both via ApiName dim with stage.
    const resp = await cw.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: [
          {
            Id: "c",
            MetricStat: {
              Metric: {
                Namespace: "AWS/ApiGateway",
                MetricName: "Count",
                Dimensions: [
                  { Name: "ApiId", Value: apiId },
                  { Name: "Stage", Value: stage },
                ],
              },
              Period: 3600,
              Stat: "Sum",
            },
          },
          {
            Id: "lat",
            MetricStat: {
              Metric: {
                Namespace: "AWS/ApiGateway",
                MetricName: "Latency",
                Dimensions: [
                  { Name: "ApiId", Value: apiId },
                  { Name: "Stage", Value: stage },
                ],
              },
              Period: 300,
              Stat: "Average",
            },
          },
          {
            Id: "e4",
            MetricStat: {
              Metric: {
                Namespace: "AWS/ApiGateway",
                MetricName: "4XXError",
                Dimensions: [
                  { Name: "ApiId", Value: apiId },
                  { Name: "Stage", Value: stage },
                ],
              },
              Period: 3600,
              Stat: "Sum",
            },
          },
          {
            Id: "e5",
            MetricStat: {
              Metric: {
                Namespace: "AWS/ApiGateway",
                MetricName: "5XXError",
                Dimensions: [
                  { Name: "ApiId", Value: apiId },
                  { Name: "Stage", Value: stage },
                ],
              },
              Period: 3600,
              Stat: "Sum",
            },
          },
        ],
      }),
    );
    void dim;
    const byId = Object.fromEntries(
      (resp.MetricDataResults ?? []).map((r) => [r.Id || "", r]),
    );
    const sum = (id: string) => {
      const vals = byId[id]?.Values ?? [];
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0);
    };
    const avg = (id: string) => {
      const vals = byId[id]?.Values ?? [];
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    return {
      count_sum: sum("c"),
      latency_avg_ms: avg("lat"),
      "4xx_sum": sum("e4"),
      "5xx_sum": sum("e5"),
    };
  } catch {
    return undefined;
  }
}
