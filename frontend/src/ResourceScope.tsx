import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchResources,
  RESOURCE_TYPES,
  type ListedResource,
  type ResourceType,
} from "./api";

export type SelectedScope = {
  type: ResourceType;
  resource: ListedResource;
  region: string;
};

type Props = {
  selected: SelectedScope | null;
  onSelect: (scope: SelectedScope | null) => void;
  disabled?: boolean;
};

const TYPE_LABELS: Record<ResourceType, string> = {
  lambda: "Lambda",
  s3: "S3",
  ec2: "EC2",
  dynamodb: "DynamoDB",
  sqs: "SQS",
  sns: "SNS",
  apigateway: "API Gateway",
  loggroup: "Log groups",
  alarm: "Alarms",
  budget: "Budgets",
};

export default function ResourceScope({
  selected,
  onSelect,
  disabled = false,
}: Props) {
  const [type, setType] = useState<ResourceType>("lambda");
  const [filter, setFilter] = useState("");
  const [resources, setResources] = useState<ListedResource[]>([]);
  const [region, setRegion] = useState("us-east-1");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const load = useCallback(async (nextType: ResourceType) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchResources(nextType);
      setResources(result.resources);
      setRegion(result.region);
      setTruncated(result.truncated);
    } catch (err) {
      setResources([]);
      setError(err instanceof Error ? err.message : "Failed to list resources");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(type);
  }, [type, load]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return resources;
    return resources.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.meta || "").toLowerCase().includes(q),
    );
  }, [resources, filter]);

  function selectResource(resource: ListedResource) {
    onSelect({ type, resource, region });
  }

  function clearSelection() {
    onSelect(null);
  }

  return (
    <div className="scope">
      <div className="scope-head">
        <h2>Scope</h2>
        <button
          type="button"
          className="text-btn"
          onClick={() => void load(type)}
          disabled={disabled || loading}
        >
          Refresh
        </button>
      </div>

      {selected ? (
        <div className="scope-selected">
          <p className="scope-selected-label">Checking</p>
          <p className="scope-selected-name">{selected.resource.name}</p>
          <p className="scope-selected-meta">
            {TYPE_LABELS[selected.type]} · {selected.region}
            {selected.resource.meta ? ` · ${selected.resource.meta}` : ""}
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={clearSelection}
            disabled={disabled}
          >
            Clear target
          </button>
        </div>
      ) : (
        <p className="scope-empty-hint">
          Pick a resource to focus Probe. Voice questions will use this target.
        </p>
      )}

      <label className="scope-field">
        <span>Type</span>
        <select
          value={type}
          disabled={disabled || loading}
          onChange={(e) => {
            setType(e.target.value as ResourceType);
            setFilter("");
          }}
        >
          {RESOURCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      <label className="scope-field">
        <span>Filter</span>
        <input
          type="search"
          value={filter}
          placeholder="Filter by name…"
          disabled={disabled || loading}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>

      <div className="scope-list" role="listbox" aria-label="Resources">
        {loading ? <p className="scope-status">Loading…</p> : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {!loading && !error && filtered.length === 0 ? (
          <p className="scope-status">No resources found.</p>
        ) : null}
        {!loading &&
          filtered.map((resource) => {
            const isActive =
              selected?.resource.id === resource.id &&
              selected.type === type;
            return (
              <button
                key={resource.id}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`scope-item ${isActive ? "scope-item-active" : ""}`}
                disabled={disabled}
                onClick={() => selectResource(resource)}
              >
                <span className="scope-item-name">{resource.name}</span>
                {resource.meta ? (
                  <span className="scope-item-meta">{resource.meta}</span>
                ) : null}
              </button>
            );
          })}
      </div>

      <p className="scope-foot">
        {loading
          ? "…"
          : `${filtered.length}${truncated ? "+" : ""} in ${region}`}
        {" · deep inspect supported"}
      </p>
    </div>
  );
}
