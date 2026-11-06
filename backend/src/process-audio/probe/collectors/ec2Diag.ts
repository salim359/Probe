import {
  DescribeInstanceStatusCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

export interface Ec2DiagResult {
  ok: boolean;
  region: string;
  instance_id: string;
  name?: string | null;
  state?: string | null;
  instance_type?: string | null;
  availability_zone?: string | null;
  private_ip?: string | null;
  public_ip?: string | null;
  vpc_id?: string | null;
  subnet_id?: string | null;
  platform?: string | null;
  launch_time?: string | null;
  security_groups?: Array<{ id: string; name: string }>;
  status_checks?: {
    instance_status?: string | null;
    system_status?: string | null;
    events?: Array<{ code?: string; description?: string; not_before?: string }>;
  };
  metrics_1h?: {
    cpu_avg?: number | null;
    status_check_failed?: number | null;
    network_in_sum?: number | null;
    network_out_sum?: number | null;
  };
  error?: { code: string; message: string };
}

export async function collectEc2(
  instanceIdOrName: string,
  region: string,
): Promise<Ec2DiagResult> {
  const client = new EC2Client({ region });
  const input = instanceIdOrName.trim();
  const base: Ec2DiagResult = {
    ok: false,
    region,
    instance_id: input,
  };

  try {
    let instanceId = input;
    if (!/^i-/.test(input)) {
      const byName = await client.send(
        new DescribeInstancesCommand({
          Filters: [{ Name: "tag:Name", Values: [input] }],
        }),
      );
      const found = byName.Reservations?.[0]?.Instances?.[0]?.InstanceId;
      if (!found) {
        return {
          ...base,
          error: {
            code: "NotFound",
            message: `No instance found for id/name "${input}"`,
          },
        };
      }
      instanceId = found;
    }

    const desc = await client.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const inst = desc.Reservations?.[0]?.Instances?.[0];
    if (!inst) {
      return {
        ...base,
        error: { code: "NotFound", message: `Instance ${instanceId} not found` },
      };
    }

    const name =
      (inst.Tags ?? []).find((t) => t.Key === "Name")?.Value || null;
    const sgIds = (inst.SecurityGroups ?? [])
      .map((g) => g.GroupId)
      .filter(Boolean) as string[];

    let securityGroups: Ec2DiagResult["security_groups"] = (
      inst.SecurityGroups ?? []
    ).map((g) => ({ id: g.GroupId || "", name: g.GroupName || "" }));

    if (sgIds.length) {
      try {
        const sgs = await client.send(
          new DescribeSecurityGroupsCommand({ GroupIds: sgIds }),
        );
        securityGroups = (sgs.SecurityGroups ?? []).map((g) => ({
          id: g.GroupId || "",
          name: g.GroupName || "",
        }));
      } catch {
        /* keep basic SG list */
      }
    }

    let status_checks: Ec2DiagResult["status_checks"] = undefined;
    try {
      const st = await client.send(
        new DescribeInstanceStatusCommand({
          InstanceIds: [instanceId],
          IncludeAllInstances: true,
        }),
      );
      const s = st.InstanceStatuses?.[0];
      status_checks = {
        instance_status: s?.InstanceStatus?.Status ?? null,
        system_status: s?.SystemStatus?.Status ?? null,
        events: (s?.Events ?? []).map((e) => ({
          code: e.Code,
          description: e.Description,
          not_before: e.NotBefore?.toISOString(),
        })),
      };
    } catch {
      status_checks = undefined;
    }

    const metrics_1h = await fetchEc2Metrics(instanceId, region);

    return {
      ok: true,
      region,
      instance_id: instanceId,
      name,
      state: inst.State?.Name ?? null,
      instance_type: inst.InstanceType ?? null,
      availability_zone: inst.Placement?.AvailabilityZone ?? null,
      private_ip: inst.PrivateIpAddress ?? null,
      public_ip: inst.PublicIpAddress ?? null,
      vpc_id: inst.VpcId ?? null,
      subnet_id: inst.SubnetId ?? null,
      platform: inst.PlatformDetails || inst.Platform || null,
      launch_time: inst.LaunchTime?.toISOString() ?? null,
      security_groups: securityGroups,
      status_checks,
      metrics_1h,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: { code: e.name || "Ec2Error", message: e.message || String(err) },
    };
  }
}

async function fetchEc2Metrics(instanceId: string, region: string) {
  try {
    const cw = new CloudWatchClient({ region });
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const dim = [{ Name: "InstanceId", Value: instanceId }];
    const resp = await cw.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: [
          {
            Id: "cpu",
            MetricStat: {
              Metric: {
                Namespace: "AWS/EC2",
                MetricName: "CPUUtilization",
                Dimensions: dim,
              },
              Period: 300,
              Stat: "Average",
            },
          },
          {
            Id: "scf",
            MetricStat: {
              Metric: {
                Namespace: "AWS/EC2",
                MetricName: "StatusCheckFailed",
                Dimensions: dim,
              },
              Period: 300,
              Stat: "Maximum",
            },
          },
          {
            Id: "netin",
            MetricStat: {
              Metric: {
                Namespace: "AWS/EC2",
                MetricName: "NetworkIn",
                Dimensions: dim,
              },
              Period: 3600,
              Stat: "Sum",
            },
          },
          {
            Id: "netout",
            MetricStat: {
              Metric: {
                Namespace: "AWS/EC2",
                MetricName: "NetworkOut",
                Dimensions: dim,
              },
              Period: 3600,
              Stat: "Sum",
            },
          },
        ],
      }),
    );

    const byId = Object.fromEntries(
      (resp.MetricDataResults ?? []).map((r) => [r.Id || "", r]),
    );
    const avg = (id: string) => {
      const vals = byId[id]?.Values ?? [];
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const max = (id: string) => {
      const vals = byId[id]?.Values ?? [];
      if (!vals.length) return null;
      return Math.max(...vals);
    };
    const sum = (id: string) => {
      const vals = byId[id]?.Values ?? [];
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0);
    };

    return {
      cpu_avg: avg("cpu"),
      status_check_failed: max("scf"),
      network_in_sum: sum("netin"),
      network_out_sum: sum("netout"),
    };
  } catch {
    return undefined;
  }
}
