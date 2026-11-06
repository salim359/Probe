import {
  BudgetsClient,
  DescribeBudgetCommand,
  DescribeBudgetsCommand,
} from "@aws-sdk/client-budgets";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

// AWS Budgets control-plane API is only available in us-east-1.
const BUDGETS_REGION = "us-east-1";

export interface BudgetSummary {
  name: string;
  budget_type?: string;
  time_unit?: string;
  limit_amount?: string | null;
  limit_unit?: string | null;
  actual_spend?: string | null;
  forecasted_spend?: string | null;
  actual_unit?: string | null;
  forecasted_unit?: string | null;
  cost_filters?: Record<string, string[]>;
}

export interface BudgetsListResult {
  ok: boolean;
  account_id?: string;
  region: string;
  budgets: BudgetSummary[];
  count: number;
  error?: { code: string; message: string };
}

export interface BudgetDiagResult {
  ok: boolean;
  account_id?: string;
  region: string;
  budget_name: string;
  budget_type?: string | null;
  time_unit?: string | null;
  time_period?: { start?: string | null; end?: string | null };
  limit_amount?: string | null;
  limit_unit?: string | null;
  actual_spend?: string | null;
  forecasted_spend?: string | null;
  actual_unit?: string | null;
  forecasted_unit?: string | null;
  percent_of_budget_actual?: number | null;
  percent_of_budget_forecasted?: number | null;
  cost_filters?: Record<string, string[]>;
  summary?: string;
  error?: { code: string; message: string };
}

async function accountId(): Promise<string> {
  const sts = new STSClient({});
  const id = await sts.send(new GetCallerIdentityCommand({}));
  if (!id.Account) throw new Error("Could not resolve AWS account id");
  return id.Account;
}

function toSummary(b: {
  BudgetName?: string;
  BudgetType?: string;
  TimeUnit?: string;
  BudgetLimit?: { Amount?: string; Unit?: string };
  CalculatedSpend?: {
    ActualSpend?: { Amount?: string; Unit?: string };
    ForecastedSpend?: { Amount?: string; Unit?: string };
  };
  CostFilters?: Record<string, string[]>;
}): BudgetSummary {
  return {
    name: b.BudgetName || "unknown",
    budget_type: b.BudgetType,
    time_unit: b.TimeUnit,
    limit_amount: b.BudgetLimit?.Amount ?? null,
    limit_unit: b.BudgetLimit?.Unit ?? null,
    actual_spend: b.CalculatedSpend?.ActualSpend?.Amount ?? null,
    forecasted_spend: b.CalculatedSpend?.ForecastedSpend?.Amount ?? null,
    actual_unit: b.CalculatedSpend?.ActualSpend?.Unit ?? null,
    forecasted_unit: b.CalculatedSpend?.ForecastedSpend?.Unit ?? null,
    cost_filters: b.CostFilters,
  };
}

function pct(actual: string | null | undefined, limit: string | null | undefined) {
  const a = Number(actual);
  const l = Number(limit);
  if (!Number.isFinite(a) || !Number.isFinite(l) || l === 0) return null;
  return Math.round((a / l) * 1000) / 10;
}

export async function listBudgets(): Promise<BudgetsListResult> {
  try {
    const acct = await accountId();
    const client = new BudgetsClient({ region: BUDGETS_REGION });
    const budgets: BudgetSummary[] = [];
    let nextToken: string | undefined;

    do {
      const resp = await client.send(
        new DescribeBudgetsCommand({
          AccountId: acct,
          MaxResults: 50,
          NextToken: nextToken,
        }),
      );
      for (const b of resp.Budgets ?? []) {
        budgets.push(toSummary(b));
      }
      nextToken = resp.NextToken;
    } while (nextToken && budgets.length < 100);

    return {
      ok: true,
      account_id: acct,
      region: BUDGETS_REGION,
      budgets,
      count: budgets.length,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ok: false,
      region: BUDGETS_REGION,
      budgets: [],
      count: 0,
      error: {
        code: e.name || "BudgetsListError",
        message: e.message || String(err),
      },
    };
  }
}

export async function collectBudget(
  budgetName: string,
): Promise<BudgetDiagResult> {
  const name = budgetName.trim();
  const base: BudgetDiagResult = {
    ok: false,
    region: BUDGETS_REGION,
    budget_name: name,
  };

  try {
    const acct = await accountId();
    const client = new BudgetsClient({ region: BUDGETS_REGION });
    const resp = await client.send(
      new DescribeBudgetCommand({
        AccountId: acct,
        BudgetName: name,
      }),
    );
    const b = resp.Budget;
    if (!b) {
      return {
        ...base,
        account_id: acct,
        error: { code: "NotFound", message: `Budget not found: ${name}` },
      };
    }

    const limit = b.BudgetLimit?.Amount ?? null;
    const actual = b.CalculatedSpend?.ActualSpend?.Amount ?? null;
    const forecast = b.CalculatedSpend?.ForecastedSpend?.Amount ?? null;
    const unit = b.BudgetLimit?.Unit || "USD";

    const actualPct = pct(actual, limit);
    const forecastPct = pct(forecast, limit);

    const summary = [
      `Budget "${name}" limit is ${limit ?? "n/a"} ${unit} per ${b.TimeUnit || "period"}.`,
      actual != null
        ? `Actual spend so far: ${actual} ${b.CalculatedSpend?.ActualSpend?.Unit || unit}${actualPct != null ? ` (${actualPct}% of budget)` : ""}.`
        : "Actual spend is not available yet.",
      forecast != null
        ? `Forecasted spend for this period: ${forecast} ${b.CalculatedSpend?.ForecastedSpend?.Unit || unit}${forecastPct != null ? ` (${forecastPct}% of budget)` : ""}.`
        : "Forecasted spend is not available yet.",
    ].join(" ");

    return {
      ok: true,
      account_id: acct,
      region: BUDGETS_REGION,
      budget_name: name,
      budget_type: b.BudgetType ?? null,
      time_unit: b.TimeUnit ?? null,
      time_period: {
        start: b.TimePeriod?.Start?.toISOString?.() ?? null,
        end: b.TimePeriod?.End?.toISOString?.() ?? null,
      },
      limit_amount: limit,
      limit_unit: b.BudgetLimit?.Unit ?? null,
      actual_spend: actual,
      forecasted_spend: forecast,
      actual_unit: b.CalculatedSpend?.ActualSpend?.Unit ?? null,
      forecasted_unit: b.CalculatedSpend?.ForecastedSpend?.Unit ?? null,
      percent_of_budget_actual: actualPct,
      percent_of_budget_forecasted: forecastPct,
      cost_filters: b.CostFilters,
      summary,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: {
        code: e.name || "BudgetError",
        message: e.message || String(err),
      },
    };
  }
}
