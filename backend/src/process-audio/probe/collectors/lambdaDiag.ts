import {
  GetFunctionConcurrencyCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListTagsCommand,
} from "@aws-sdk/client-lambda";

export interface LambdaDiagResult {
  resource: string;
  region: string;
  ok: boolean;
  function_arn?: string;
  runtime?: string;
  handler?: string;
  timeout?: number;
  memory_mb?: number;
  last_modified?: string;
  role?: string;
  state?: string;
  state_reason?: string;
  last_update_status?: string;
  last_update_status_reason?: string;
  architectures?: string[];
  package_type?: string;
  ephemeral_storage_mb?: number;
  vpc_configured?: boolean;
  layers_count?: number;
  environment_variable_names?: string[];
  dead_letter_config?: unknown;
  tracing_mode?: string;
  reserved_concurrent_executions?: number;
  tags?: Record<string, string>;
  error?: { code: string; message: string };
  concurrency_error?: { code: string; message: string };
  tags_error?: { code: string; message: string };
}

function clientError(err: unknown): { code: string; message: string } {
  const e = err as { name?: string; message?: string; Code?: string };
  return {
    code: e.name || e.Code || "ClientError",
    message: e.message || String(err),
  };
}

export async function collectLambda(
  functionName: string,
  region: string,
): Promise<LambdaDiagResult> {
  const client = new LambdaClient({ region });
  const result: LambdaDiagResult = {
    resource: functionName,
    region,
    ok: false,
  };

  try {
    const cfg = await client.send(
      new GetFunctionConfigurationCommand({ FunctionName: functionName }),
    );
    const envVars = cfg.Environment?.Variables ?? {};
    Object.assign(result, {
      ok: true,
      function_arn: cfg.FunctionArn,
      runtime: cfg.Runtime,
      handler: cfg.Handler,
      timeout: cfg.Timeout,
      memory_mb: cfg.MemorySize,
      last_modified: cfg.LastModified,
      role: cfg.Role,
      state: cfg.State,
      state_reason: cfg.StateReason,
      last_update_status: cfg.LastUpdateStatus,
      last_update_status_reason: cfg.LastUpdateStatusReason,
      architectures: cfg.Architectures,
      package_type: cfg.PackageType,
      ephemeral_storage_mb: cfg.EphemeralStorage?.Size,
      vpc_configured: Boolean(cfg.VpcConfig?.VpcId),
      layers_count: (cfg.Layers ?? []).length,
      environment_variable_names: Object.keys(envVars).sort(),
      dead_letter_config: cfg.DeadLetterConfig,
      tracing_mode: cfg.TracingConfig?.Mode,
    });
  } catch (err) {
    result.error = clientError(err);
    return result;
  }

  try {
    const concurrency = await client.send(
      new GetFunctionConcurrencyCommand({ FunctionName: functionName }),
    );
    result.reserved_concurrent_executions =
      concurrency.ReservedConcurrentExecutions;
  } catch (err) {
    result.concurrency_error = clientError(err);
  }

  if (result.function_arn) {
    try {
      const tags = await client.send(
        new ListTagsCommand({ Resource: result.function_arn }),
      );
      result.tags = tags.Tags ?? {};
    } catch (err) {
      result.tags_error = clientError(err);
    }
  }

  return result;
}
