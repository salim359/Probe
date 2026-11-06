import {
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

export interface S3DiagResult {
  ok: boolean;
  bucket: string;
  region?: string | null;
  versioning_status?: string | null;
  approximate_object_count?: number;
  approximate_total_size_bytes?: number;
  sample_objects?: Array<{
    key: string;
    size: number;
    last_modified: string | null;
    storage_class?: string;
  }>;
  truncated?: boolean;
  note?: string;
  error?: { code: string; message: string };
}

export async function collectS3(
  bucketName: string,
  fallbackRegion: string,
): Promise<S3DiagResult> {
  const bucket = bucketName.trim();
  const base: S3DiagResult = { ok: false, bucket };

  try {
    // Resolve bucket region first
    const locator = new S3Client({ region: fallbackRegion });
    let region = fallbackRegion;
    try {
      const loc = await locator.send(
        new GetBucketLocationCommand({ Bucket: bucket }),
      );
      // Legacy: empty / null means us-east-1
      region = loc.LocationConstraint || "us-east-1";
      if (region === "EU") region = "eu-west-1";
    } catch {
      region = fallbackRegion;
    }

    const client = new S3Client({ region });
    await client.send(new HeadBucketCommand({ Bucket: bucket }));

    let versioning: string | null = null;
    try {
      const ver = await client.send(
        new GetBucketVersioningCommand({ Bucket: bucket }),
      );
      versioning = ver.Status || "Disabled";
    } catch {
      versioning = null;
    }

    // Count via ListObjectsV2 pages (capped to keep Lambda under timeout)
    let objectCount = 0;
    let totalBytes = 0;
    let truncated = false;
    const sample: S3DiagResult["sample_objects"] = [];
    let token: string | undefined;
    const MAX_PAGES = 20; // 20 * 1000 = up to 20k objects counted
    let pages = 0;

    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      for (const obj of page.Contents ?? []) {
        objectCount += 1;
        totalBytes += obj.Size ?? 0;
        if (sample.length < 8 && obj.Key) {
          sample.push({
            key: obj.Key,
            size: obj.Size ?? 0,
            last_modified: obj.LastModified?.toISOString() ?? null,
            storage_class: obj.StorageClass,
          });
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      pages += 1;
      if (token && pages >= MAX_PAGES) {
        truncated = true;
        break;
      }
    } while (token);

    return {
      ok: true,
      bucket,
      region,
      versioning_status: versioning,
      approximate_object_count: objectCount,
      approximate_total_size_bytes: totalBytes,
      sample_objects: sample,
      truncated,
      note: truncated
        ? `Counted first ~${objectCount} objects (cap ${MAX_PAGES} pages). Total may be higher.`
        : undefined,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ...base,
      error: { code: e.name || "S3Error", message: e.message || String(err) },
    };
  }
}
