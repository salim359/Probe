const STORAGE_CFG = "probe.config";
const STORAGE_AUTH = "probe.auth";

const SUGGESTIONS_BY_TYPE = {
  lambda: [
    { label: "Why is it failing?", q: "Why is this Lambda failing?" },
    { label: "Timeouts?", q: "Are there timeouts or duration spikes?" },
    { label: "Throttling?", q: "Is this function being throttled?" },
  ],
  s3: [
    { label: "Access denied?", q: "Why am I getting AccessDenied on this bucket?" },
    { label: "Missing objects?", q: "Why can’t clients find objects in this bucket?" },
    { label: "CORS issues?", q: "Could CORS or bucket policy be blocking requests?" },
  ],
  ec2: [
    { label: "Unreachable?", q: "Why can’t I reach this instance?" },
    { label: "High CPU?", q: "What should I check for high CPU or memory?" },
    { label: "Status checks?", q: "Why might status checks be failing?" },
  ],
  dynamodb: [
    { label: "Throttling?", q: "Is this table being throttled?" },
    { label: "Hot keys?", q: "Could hot partitions explain the errors?" },
    { label: "Access errors?", q: "Why are we seeing DynamoDB access or conditional errors?" },
  ],
  sqs: [
    { label: "Not consuming?", q: "Why aren’t messages being consumed?" },
    { label: "DLQ filling?", q: "Why is the dead-letter queue growing?" },
    { label: "Visibility?", q: "Could visibility timeout be causing redeliveries?" },
  ],
  sns: [
    { label: "No deliveries?", q: "Why aren’t subscriptions receiving messages?" },
    { label: "Failed endpoints?", q: "How do I find failed SNS deliveries?" },
    { label: "Filter policy?", q: "Could filter policies be dropping messages?" },
  ],
  apigateway: [
    { label: "5xx errors?", q: "Why is this API returning 5xx errors?" },
    { label: "Auth failures?", q: "Why are callers getting 401/403?" },
    { label: "Latency?", q: "What should I check for high API latency?" },
  ],
  loggroup: [
    { label: "Recent errors?", q: "What recent errors appear in this log group?" },
    { label: "Spike in volume?", q: "Is log volume spiking unexpectedly?" },
    { label: "Missing logs?", q: "Why might expected log lines be missing?" },
  ],
};

const PIPELINE_BY_TYPE = {
  lambda: ["Lambda config", "CloudWatch Logs", "Metrics", "Analysis"],
  s3: ["Bucket identity", "Common failure modes", "IAM / policy checks", "Next steps"],
  ec2: ["Instance identity", "Reachability checks", "Status / metrics", "Next steps"],
  dynamodb: ["Table identity", "Capacity / throttling", "Access patterns", "Next steps"],
  sqs: ["Queue identity", "Consumer health", "DLQ / redrive", "Next steps"],
  sns: ["Topic identity", "Subscriptions", "Delivery failures", "Next steps"],
  apigateway: ["API identity", "Integration path", "Auth / errors", "Next steps"],
  loggroup: ["Log group", "Recent patterns", "Related resources", "Next steps"],
};

const GUIDANCE_BY_TYPE = {
  s3: [
    "Confirm the bucket region and that the caller is using the correct endpoint.",
    "Inspect bucket policy, Block Public Access, and the caller’s IAM permissions (s3:GetObject / ListBucket).",
    "For browser uploads/downloads, verify CORS allowed origins, methods, and headers.",
    "Check S3 server access logs or CloudTrail for AccessDenied and NoSuchKey.",
  ],
  ec2: [
    "Verify instance state is running and status checks are ok in the console.",
    "Confirm security group + NACL allow the expected ports from the client CIDR.",
    "If SSM/SSH fails, check IAM instance profile and route tables / public IP.",
    "Review CloudWatch CPUUtilization, StatusCheckFailed, and system logs.",
  ],
  dynamodb: [
    "Compare consumed vs provisioned capacity (or on-demand throttling metrics).",
    "Look for hot keys / uneven partition access in CloudWatch Contributor Insights.",
    "Confirm IAM allows dynamodb:GetItem/Query/PutItem on this table ARN.",
    "Inspect ConditionalCheckFailed and ValidationException rates in app logs.",
  ],
  sqs: [
    "Check ApproximateNumberOfMessages and whether consumers are running.",
    "Inspect DLQ depth and redrive policy if messages expire or fail processing.",
    "Validate visibility timeout vs processing time to avoid duplicate receives.",
    "Confirm queue policy / IAM allows the producer and consumer roles.",
  ],
  sns: [
    "List subscriptions and confirm they are Confirmed.",
    "Check CloudWatch NumberOfNotificationsFailed for the topic.",
    "For HTTPS/Lambda endpoints, verify endpoint health and permissions.",
    "Review filter policies — they silently drop non-matching messages.",
  ],
  apigateway: [
    "Check stage access logs / execution logs for 4xx vs 5xx split.",
    "Verify integration (Lambda/HTTP) permissions and timeouts.",
    "Confirm authorizer configuration and token/IAM requirements.",
    "Compare latency metrics with backend duration to isolate the hop.",
  ],
  loggroup: [
    "Widen or narrow the lookback window and search for ERROR / Exception.",
    "Confirm the workload is still writing to this log group name.",
    "If linked to Lambda, switch resource type to Lambda for full RCA.",
    "Use Logs Insights for counts by error pattern over time.",
  ],
};

function currentResourceType() {
  return $("resource-type")?.value || "lambda";
}

function suggestionsForType(type) {
  return SUGGESTIONS_BY_TYPE[type] || SUGGESTIONS_BY_TYPE.lambda;
}

function pipelineForType(type) {
  return PIPELINE_BY_TYPE[type] || PIPELINE_BY_TYPE.lambda;
}

function deepInvestigateSupported(type) {
  return type === "lambda";
}

const $ = (id) => document.getElementById(id);

const loginView = $("login-view");
const chatView = $("chat-view");
const alarmsView = $("alarms-view");
const transcript = $("transcript");
const settingsDialog = $("settings-dialog");

let pipelineTimer = null;

function loadConfig() {
  const fromFile =
    typeof window.TROUBLESHOOT_CONFIG === "object" && window.TROUBLESHOOT_CONFIG
      ? window.TROUBLESHOOT_CONFIG
      : {};
  let fromStore = {};
  try {
    fromStore = JSON.parse(localStorage.getItem(STORAGE_CFG) || "{}");
  } catch {
    fromStore = {};
  }
  return {
    apiUrl: fromStore.apiUrl || fromFile.apiUrl || "",
    userPoolId: fromStore.userPoolId || fromFile.userPoolId || "",
    userPoolClientId:
      fromStore.userPoolClientId || fromFile.userPoolClientId || "",
    region: fromStore.region || fromFile.region || "us-east-1",
  };
}

function saveConfig(cfg) {
  localStorage.setItem(STORAGE_CFG, JSON.stringify(cfg));
}

function loadAuth() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_AUTH) || "null");
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  if (!auth) {
    sessionStorage.removeItem(STORAGE_AUTH);
    return;
  }
  sessionStorage.setItem(STORAGE_AUTH, JSON.stringify(auth));
}

function configReady(cfg) {
  return Boolean(
    cfg.apiUrl &&
      cfg.userPoolId &&
      cfg.userPoolClientId &&
      !cfg.apiUrl.includes("YOUR_API") &&
      !cfg.userPoolId.includes("XXXX"),
  );
}

function updateConfigStatus() {
  const cfg = loadConfig();
  const ready = configReady(cfg);
  const el = $("config-status");
  if (el) {
    el.dataset.ready = ready ? "true" : "false";
    el.querySelector(".status-text").textContent = ready
      ? "Connection ready"
      : "Connection not configured";
  }
  const pill = $("conn-pill");
  if (pill) {
    pill.textContent = ready ? "connected" : "setup needed";
    pill.classList.toggle("ready", ready);
  }
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove("is-visible");
    setTimeout(() => {
      toast.hidden = true;
    }, 220);
  }, 2200);
}

async function cognitoInitiateAuth({ region, clientId, username, password }) {
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.message || data.__type || `Cognito sign-in failed (${res.status})`,
    );
  }
  if (data.ChallengeName) {
    throw new Error(
      `Auth challenge required: ${data.ChallengeName}. Set a permanent password in Cognito first.`,
    );
  }
  const result = data.AuthenticationResult;
  if (!result?.IdToken) throw new Error("No IdToken returned from Cognito.");
  return {
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    expiresAt: Date.now() + (result.ExpiresIn || 3600) * 1000,
    username,
  };
}

async function cognitoRefresh({ region, clientId, refreshToken, username }) {
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: clientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.__type || "Token refresh failed");
  }
  const result = data.AuthenticationResult;
  return {
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken,
    expiresAt: Date.now() + (result.ExpiresIn || 3600) * 1000,
    username,
  };
}

async function ensureToken(cfg) {
  let auth = loadAuth();
  if (!auth?.idToken) throw new Error("Not signed in");
  if (auth.expiresAt && Date.now() < auth.expiresAt - 60_000) {
    return auth.idToken;
  }
  if (!auth.refreshToken) {
    saveAuth(null);
    throw new Error("Session expired — sign in again.");
  }
  auth = await cognitoRefresh({
    region: cfg.region,
    clientId: cfg.userPoolClientId,
    refreshToken: auth.refreshToken,
    username: auth.username,
  });
  saveAuth(auth);
  return auth.idToken;
}

async function apiFetch(cfg, url, options = {}) {
  const token = await ensureToken(cfg);
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (res.status === 401) {
    saveAuth(null);
    throw new Error("Unauthorized — sign in again.");
  }
  if (!res.ok) {
    throw new Error(
      body?.error?.message || body?.message || `Request failed (${res.status})`,
    );
  }
  return body;
}

function resourcesApiUrl(cfg) {
  const base = cfg.apiUrl.replace(/\/investigate\/?$/i, "");
  return `${base.replace(/\/$/, "")}/resources`;
}

function historyApiUrl(cfg) {
  const base = cfg.apiUrl.replace(/\/investigate\/?$/i, "");
  return `${base.replace(/\/$/, "")}/history`;
}

function alarmsApiUrl(cfg) {
  const base = cfg.apiUrl.replace(/\/investigate\/?$/i, "");
  return `${base.replace(/\/$/, "")}/alarms`;
}

async function investigate(cfg, payload) {
  return apiFetch(cfg, cfg.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function fetchHistory(cfg, limit = 50) {
  const url = `${historyApiUrl(cfg)}?limit=${encodeURIComponent(String(limit))}`;
  return apiFetch(cfg, url, { method: "GET" });
}

async function saveHistoryTurn(cfg, payload) {
  return apiFetch(cfg, historyApiUrl(cfg), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function clearHistory(cfg) {
  return apiFetch(cfg, historyApiUrl(cfg), { method: "DELETE" });
}

/** @type {Array<{id:string,name:string,meta?:string}>} */
let cachedResources = [];
let resourcesLoadSeq = 0;

function setResourceStatus(text, isError = false) {
  const el = $("resource-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-error", Boolean(isError));
}

function syncSelectedResource() {
  const select = $("resource-select");
  const nameInput = $("function-name");
  if (!select || !nameInput) return;
  if (select.value) nameInput.value = select.value;
}

function selectedResourceMeta() {
  const id = ($("function-name")?.value || "").trim();
  const fromCache = cachedResources.find((r) => r.id === id || r.name === id);
  return {
    id,
    name: fromCache?.name || id,
    meta: fromCache?.meta || "",
    arn: fromCache?.arn || "",
  };
}

let lastSuggestionType = null;

function updateUiForResourceType({ announceSuggestions = false } = {}) {
  const type = currentResourceType();
  const hint = $("investigate-hint");
  const question = $("question");
  const sendLabel = $("send-btn")?.querySelector(".btn-label");

  if (hint) {
    hint.innerHTML = deepInvestigateSupported(type)
      ? "<strong>Lambda</strong> — Probe will collect config, logs, metrics, and CloudFormation context."
      : `<strong>${escapeHtml(type)}</strong> — guided troubleshooting for this resource. Switch to Lambda for full CloudWatch RCA.`;
  }
  if (question) {
    const samples = {
      lambda: "Why is this Lambda failing?",
      s3: "Why are requests to this bucket failing?",
      ec2: "Why can’t I reach this instance?",
      dynamodb: "Why is this table throttling or erroring?",
      sqs: "Why aren’t messages flowing on this queue?",
      sns: "Why aren’t subscribers getting messages?",
      apigateway: "Why is this API returning errors?",
      loggroup: "What errors show up in this log group?",
    };
    question.placeholder = samples[type] || "What’s going wrong with this resource?";
  }
  if (sendLabel) {
    sendLabel.textContent = deepInvestigateSupported(type) ? "Investigate" : "Guide me";
  }

  const empty = transcript.querySelector(".empty-state");
  if (empty) {
    renderEmpty();
    lastSuggestionType = type;
    return;
  }

  if (announceSuggestions && lastSuggestionType !== type) {
    showSuggestionsInChat(type);
    lastSuggestionType = type;
  }
}

function populateResourceSelect(resources, selectedId = "") {
  const select = $("resource-select");
  if (!select) return;
  const filter = ($("resource-filter")?.value || "").trim().toLowerCase();
  const filtered = filter
    ? resources.filter(
        (r) =>
          r.name.toLowerCase().includes(filter) ||
          r.id.toLowerCase().includes(filter) ||
          String(r.meta || "")
            .toLowerCase()
            .includes(filter),
      )
    : resources;

  select.innerHTML = "";
  if (!filtered.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = resources.length
      ? "No matches for filter"
      : "No resources found";
    select.appendChild(opt);
    syncSelectedResource();
    return;
  }

  for (const r of filtered) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.meta ? `${r.name}  ·  ${r.meta}` : r.name;
    opt.title = r.arn || r.id;
    if (selectedId && selectedId === r.id) opt.selected = true;
    select.appendChild(opt);
  }
  if (!selectedId || !filtered.some((r) => r.id === selectedId)) {
    select.selectedIndex = 0;
  }
  syncSelectedResource();
}

async function loadAccountResources() {
  const cfg = loadConfig();
  const type = currentResourceType();
  const region = $("region")?.value || "us-east-1";
  updateUiForResourceType();

  if (!configReady(cfg) || !loadAuth()?.idToken) {
    setResourceStatus("Sign in and configure the API to load resources.", true);
    return;
  }

  const seq = ++resourcesLoadSeq;
  const prevId = $("resource-select")?.value || "";
  setResourceStatus(`Loading ${type} in ${region}…`);
  $("refresh-resources").disabled = true;

  try {
    const url = new URL(resourcesApiUrl(cfg));
    url.searchParams.set("type", type);
    url.searchParams.set("region", region);
    const data = await apiFetch(cfg, url.toString(), { method: "GET" });
    if (seq !== resourcesLoadSeq) return;

    cachedResources = data.resources || [];
    populateResourceSelect(cachedResources, prevId);
    const trunc = data.truncated ? " (truncated)" : "";
    setResourceStatus(
      `${cachedResources.length} ${type} resource(s)${trunc} in ${region}`,
    );
  } catch (ex) {
    if (seq !== resourcesLoadSeq) return;
    cachedResources = [];
    populateResourceSelect([]);
    setResourceStatus(
      ex instanceof Error ? ex.message : String(ex),
      true,
    );
  } finally {
    if (seq === resourcesLoadSeq) {
      $("refresh-resources").disabled = false;
    }
  }
}

function showView(name) {
  loginView.hidden = name !== "login";
  chatView.hidden = name !== "chat";
  if (alarmsView) alarmsView.hidden = name !== "alarms";
}

function fillSettingsForm(cfg) {
  $("cfg-api-url").value = cfg.apiUrl || "";
  $("cfg-pool-id").value = cfg.userPoolId || "";
  $("cfg-client-id").value = cfg.userPoolClientId || "";
  $("cfg-region").value = cfg.region || "us-east-1";
}

function openSettings() {
  fillSettingsForm(loadConfig());
  $("settings-error").hidden = true;
  settingsDialog.showModal();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(d = new Date()) {
  if (!(d instanceof Date)) d = new Date(d);
  if (Number.isNaN(d.getTime())) d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

function bindSuggestButtons(root = transcript) {
  root.querySelectorAll(".suggest").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("question").value = btn.dataset.q;
      autoGrow($("question"));
      $("question").focus();
      setSidebarOpen(false);
    });
  });
}

function suggestionsMarkup(type) {
  return suggestionsForType(type)
    .map(
      (s) =>
        `<button type="button" class="suggest" data-q="${escapeHtml(s.q)}">${escapeHtml(s.label)}</button>`,
    )
    .join("");
}

/** Insert / refresh the 3 starter questions in the chat when switching resource type. */
function showSuggestionsInChat(type) {
  if (!transcript || transcript.querySelector(".empty-state")) return;

  const existing = transcript.querySelector(".msg-suggestions");
  if (existing) existing.remove();

  const label = deepInvestigateSupported(type)
    ? "Switched to Lambda — try one of these:"
    : `Switched to ${type} — try one of these:`;

  const el = document.createElement("div");
  el.className = "msg msg-assistant msg-suggestions";
  el.innerHTML = `
    <div class="msg-meta"><span>Probe</span><span>${formatTime()}</span></div>
    <div class="finding suggest-card">
      <p class="summary" style="margin-bottom:0.85rem;font-size:1rem">${escapeHtml(label)}</p>
      <div class="suggest-row" style="justify-content:flex-start;margin-top:0">
        ${suggestionsMarkup(type)}
      </div>
    </div>
  `;
  transcript.appendChild(el);
  bindSuggestButtons(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
}

function renderEmpty() {
  const type = currentResourceType();
  const blurb = deepInvestigateSupported(type)
    ? "Select a Lambda (or paste its name), then ask what’s failing — Probe pulls CloudWatch evidence."
    : `Select a <strong>${escapeHtml(type)}</strong> resource and ask a question for guided next steps.`;

  transcript.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="26" height="26" fill="none">
          <path d="M4 20c4-9 9-13 12-13s8 4 12 13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          <circle cx="16" cy="24" r="2" fill="currentColor"/>
        </svg>
      </div>
      <strong>What should we probe?</strong>
      <p>${blurb}</p>
      <div class="suggest-row">
        ${suggestionsMarkup(type)}
      </div>
    </div>
  `;
  bindSuggestButtons();
}

function appendUserMessage(text, { at, scroll = true } = {}) {
  const empty = transcript.querySelector(".empty-state");
  if (empty) empty.remove();
  transcript.querySelector(".msg-suggestions")?.remove();

  const el = document.createElement("div");
  el.className = "msg msg-user";
  el.innerHTML = `
    <div class="msg-meta"><span>You</span><span>${formatTime(at)}</span></div>
    <div class="bubble">${escapeHtml(text)}</div>
  `;
  transcript.appendChild(el);
  if (scroll) el.scrollIntoView({ behavior: "smooth", block: "end" });
}

function stopPipeline() {
  if (pipelineTimer) {
    clearInterval(pipelineTimer);
    pipelineTimer = null;
  }
}

function appendTyping(type = currentResourceType()) {
  stopPipeline();
  const pipeline = pipelineForType(type);
  const title = deepInvestigateSupported(type)
    ? "Collecting evidence…"
    : "Building guidance…";
  const el = document.createElement("div");
  el.className = "msg msg-assistant";
  el.id = "typing-indicator";
  el.innerHTML = `
    <div class="finding">
      <div class="pipeline">
        <div class="pipeline-title">${escapeHtml(title)}</div>
        ${pipeline
          .map(
            (label, i) => `
          <div class="pipeline-step" data-step="${i}">
            <span class="step-dot"></span>
            <span>${escapeHtml(label)}</span>
          </div>`,
          )
          .join("")}
      </div>
    </div>
  `;
  transcript.appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });

  let step = 0;
  const steps = el.querySelectorAll(".pipeline-step");
  const tick = () => {
    steps.forEach((node, i) => {
      node.classList.toggle("is-done", i < step);
      node.classList.toggle("is-active", i === step);
    });
    step = Math.min(step + 1, pipeline.length - 1);
  };
  tick();
  pipelineTimer = setInterval(tick, 700);
  return el;
}

function guidanceStepsFor(type) {
  return (
    GUIDANCE_BY_TYPE[type] || [
      "Confirm the resource exists in the selected region.",
      "Check IAM permissions for the caller role.",
      "Review CloudWatch metrics and recent alarms for this service.",
      "Switch to Lambda if the failure is in a function behind this resource.",
    ]
  );
}

function renderResourceGuidance({
  type,
  resource,
  region,
  question,
  steps: stepsIn,
  at,
  scroll = true,
}) {
  stopPipeline();
  const typing = $("typing-indicator");
  if (typing) typing.remove();

  const steps = stepsIn?.length ? stepsIn : guidanceStepsFor(type);
  const res = resource || {};

  const el = document.createElement("div");
  el.className = "msg msg-assistant";
  el.innerHTML = `
    <div class="msg-meta"><span>Probe</span><span>${formatTime(at)}</span></div>
    <div class="finding">
      <div class="finding-header">
        <span class="pill">${escapeHtml(type)}</span>
        ${res.name ? `<span class="pill mono-name">${escapeHtml(res.name)}</span>` : ""}
        <span class="pill">${escapeHtml(region || "")}</span>
        <span class="pill warn">guided</span>
      </div>
      <p class="finding-title">Guidance</p>
      <p class="summary">${escapeHtml(
        question || `How to troubleshoot this ${type} resource`,
      )}</p>
      ${
        res.meta || res.arn
          ? `<div class="lambda-facts">
              ${res.meta ? `<span class="fact">${escapeHtml(res.meta)}</span>` : ""}
              ${res.arn ? `<span class="fact">${escapeHtml(res.arn)}</span>` : ""}
            </div>`
          : ""
      }
      <p class="section-title">Recommended checks</p>
      <ul class="step-list">
        ${steps.map((s, i) => `<li data-n="${i + 1}">${escapeHtml(s)}</li>`).join("")}
      </ul>
      <p class="hint" style="padding-left:0.35rem;margin:0">
        Deep CloudWatch investigation is available for <strong>Lambda</strong>.
        Change resource type to Lambda when the failure is in a function.
      </p>
    </div>
  `;
  transcript.appendChild(el);
  if (scroll) el.scrollIntoView({ behavior: "smooth", block: "end" });
  return { kind: "guided", type, resource: res, region, question, steps };
}

function confidenceBar(level) {
  const l = String(level || "low").toLowerCase();
  const cls = l === "high" ? "high" : l === "medium" ? "medium" : "low";
  return `
    <div class="conf-bar" title="Confidence: ${escapeHtml(l)}">
      <div class="conf-track"><div class="conf-fill ${cls}"></div></div>
      <span class="pill ${l === "high" ? "danger" : l === "medium" ? "warn" : ""}">${escapeHtml(l)}</span>
    </div>
  `;
}

function renderFindings(result, { at, scroll = true } = {}) {
  stopPipeline();
  const typing = $("typing-indicator");
  if (typing) typing.remove();

  const el = document.createElement("div");
  el.className = "msg msg-assistant";

  if (!result.ok && result.error && !result.findings) {
    el.innerHTML = `
      <div class="msg-meta"><span>Probe</span><span>${formatTime(at)}</span></div>
      <div class="finding is-error">
        <div class="finding-header">
          <span class="pill danger">error</span>
          ${result.error.code ? `<span class="pill">${escapeHtml(result.error.code)}</span>` : ""}
        </div>
        <p class="summary">${escapeHtml(result.error.message || "Investigation failed.")}</p>
      </div>
    `;
    transcript.appendChild(el);
    if (scroll) el.scrollIntoView({ behavior: "smooth", block: "end" });
    return;
  }

  const findings = result.findings || {};
  const resource = result.resource || {};
  const evidence = result.evidence || {};
  const causes = findings.likely_causes || [];
  const steps = findings.recommended_next_steps || [];
  const support = findings.supporting_evidence || [];
  const questions = findings.open_questions || [];
  const logs = evidence.logs || {};
  const metrics = evidence.metrics?.metrics || evidence.metrics || {};
  const lambda = evidence.lambda || {};

  const causesHtml = causes.length
    ? `<p class="section-title">Likely causes</p>
       <ul class="cause-list">
         ${causes
           .map((c) => {
             if (typeof c === "string") {
               return `<li><p class="cause">${escapeHtml(c)}</p></li>`;
             }
             const ev = (c.evidence || [])
               .map((e) => `<li>${escapeHtml(e)}</li>`)
               .join("");
             return `<li>
               <div class="cause-top">
                 <p class="cause">${escapeHtml(c.cause || "")}</p>
                 ${c.confidence ? confidenceBar(c.confidence) : ""}
               </div>
               ${ev ? `<ul class="evidence-list">${ev}</ul>` : ""}
             </li>`;
           })
           .join("")}
       </ul>`
    : "";

  const stepsHtml = steps.length
    ? `<p class="section-title">Next steps</p>
       <ul class="step-list">
         ${steps
           .map(
             (s, i) =>
               `<li data-n="${i + 1}">${escapeHtml(s)}</li>`,
           )
           .join("")}
       </ul>`
    : "";

  const supportHtml = support.length
    ? `<p class="section-title">Supporting evidence</p>
       <ul class="evidence-list">
         ${support.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}
       </ul>`
    : "";

  const openHtml = questions.length
    ? `<p class="section-title">Open questions</p>
       <ul class="step-list">
         ${questions
           .map((q, i) => `<li data-n="${i + 1}">${escapeHtml(q)}</li>`)
           .join("")}
       </ul>`
    : "";

  const hotMetrics = new Set(["Errors", "Throttles", "DeadLetterErrors"]);
  const metricEntries = Object.entries(metrics).filter(
    ([, v]) => v && typeof v === "object",
  );
  const metricsHtml = metricEntries.length
    ? `<div class="metrics-grid">
         ${metricEntries
           .map(([name, v]) => {
             const val =
               v.sum_or_avg_total ?? v.Sum ?? v.Average ?? v.value ?? "—";
             const hot =
               hotMetrics.has(name) && Number(val) > 0 ? "is-hot" : "";
             const label = String(name).replace(/([a-z])([A-Z])/g, "$1 $2");
             return `<div class="metric ${hot}">
               <div class="label">${escapeHtml(label)}</div>
               <div class="value">${escapeHtml(String(val))}</div>
             </div>`;
           })
           .join("")}
       </div>`
    : "";

  const samples = logs.sample_messages || [];
  const samplesHtml = samples.length
    ? `<p class="section-title">Sample log lines</p>
       <ul class="sample-logs">
         ${samples.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}
       </ul>`
    : "";

  const facts = [
    lambda.runtime,
    lambda.timeout != null ? `${lambda.timeout}s timeout` : null,
    lambda.memory_mb != null ? `${lambda.memory_mb} MB` : null,
    lambda.state,
  ].filter(Boolean);

  const factsHtml = facts.length
    ? `<div class="lambda-facts">${facts
        .map((f) => `<span class="fact">${escapeHtml(f)}</span>`)
        .join("")}</div>`
    : "";

  const evidenceId = `ev-${Date.now()}`;

  el.innerHTML = `
    <div class="msg-meta"><span>Probe</span><span>${formatTime(at)}</span></div>
    <div class="finding ${result.ok ? "" : "is-error"}">
      <div class="finding-header">
        <span class="pill ${result.ok ? "" : "danger"}">${result.ok ? "ok" : "partial"}</span>
        <span class="pill">${escapeHtml(resource.type || result.investigation_type || "lambda")}</span>
        ${resource.name ? `<span class="pill mono-name">${escapeHtml(resource.name)}</span>` : ""}
        ${resource.region ? `<span class="pill">${escapeHtml(resource.region)}</span>` : ""}
        ${findings.mode ? `<span class="pill warn">${escapeHtml(findings.mode)}</span>` : ""}
        ${findings.model ? `<span class="pill">${escapeHtml(findings.model)}</span>` : ""}
      </div>
      <p class="finding-title">Findings</p>
      <p class="summary">${escapeHtml(findings.summary || result.error?.message || "No summary.")}</p>
      ${factsHtml}
      ${causesHtml}
      ${stepsHtml}
      ${supportHtml}
      ${openHtml}
      <details class="evidence-block">
        <summary>Evidence details</summary>
        <div class="evidence-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-copy="${evidenceId}">Copy JSON</button>
        </div>
        ${metricsHtml}
        ${
          logs.error_like_count != null
            ? `<p class="msg-meta">Error-like events: ${escapeHtml(String(logs.error_like_count))} · lookback ${escapeHtml(String(logs.lookback_minutes ?? "—"))}m</p>`
            : ""
        }
        ${samplesHtml}
        <pre class="raw-json" id="${evidenceId}">${escapeHtml(JSON.stringify(evidence, null, 2))}</pre>
      </details>
    </div>
  `;

  el.querySelector("[data-copy]")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(evidence, null, 2),
      );
      showToast("Evidence copied");
    } catch {
      showToast("Could not copy");
    }
  });

  transcript.appendChild(el);
  if (scroll) el.scrollIntoView({ behavior: "smooth", block: "end" });
}

function formatTurnUserText(turn) {
  const q = turn.question || "";
  const type = turn.resourceType || "resource";
  const name = turn.resourceName || "";
  const region = turn.region || "";
  const lookback =
    turn.lookbackMinutes != null ? ` · ${turn.lookbackMinutes}m` : "";
  if (!name && !region) return q;
  const target = [type, name].filter(Boolean).join(": ");
  const where = region ? ` · ${region}` : "";
  return `${q}\n\n→ ${target}${where}${lookback}`;
}

function replayHistoryTurn(turn) {
  const at = turn.createdAt;
  appendUserMessage(formatTurnUserText(turn), { at, scroll: false });
  const result = turn.result || {};
  if (result.kind === "guided") {
    renderResourceGuidance({
      type: result.type || turn.resourceType,
      resource: result.resource || {
        name: turn.resourceName,
        id: turn.resourceName,
      },
      region: result.region || turn.region,
      question: result.question || turn.question,
      steps: result.steps,
      at,
      scroll: false,
    });
    return;
  }
  renderFindings(result, { at, scroll: false });
}

async function restoreHistory(cfg) {
  if (!configReady(cfg) || !loadAuth()) return false;
  const data = await fetchHistory(cfg, 50);
  const turns = data.turns || [];
  if (!turns.length) return false;
  transcript.innerHTML = "";
  for (const turn of turns) {
    replayHistoryTurn(turn);
  }
  const last = transcript.lastElementChild;
  if (last) last.scrollIntoView({ behavior: "auto", block: "end" });
  return true;
}

function appendError(message) {
  stopPipeline();
  const typing = $("typing-indicator");
  if (typing) typing.remove();
  const el = document.createElement("div");
  el.className = "msg msg-assistant";
  el.innerHTML = `
    <div class="msg-meta"><span>Probe</span><span>${formatTime()}</span></div>
    <div class="finding is-error">
      <div class="finding-header"><span class="pill danger">error</span></div>
      <p class="summary">${escapeHtml(message)}</p>
    </div>
  `;
  transcript.appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
}

function greetingFor(username) {
  if (!username) return "Welcome back";
  const local = String(username).split("@")[0] || username;
  const name = local
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const hour = new Date().getHours();
  const hello =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${hello}, ${name}`;
}

async function bootChat() {
  const auth = loadAuth();
  const cfg = loadConfig();
  $("caller-label").textContent = greetingFor(auth?.username);
  if (cfg.region && $("region").querySelector(`option[value="${cfg.region}"]`)) {
    $("region").value = cfg.region;
  }
  updateConfigStatus();
  updateUiForResourceType();
  showView("chat");
  transcript.innerHTML = "";
  try {
    const restored = await restoreHistory(cfg);
    if (!restored) renderEmpty();
  } catch (ex) {
    console.warn("history restore failed", ex);
    renderEmpty();
  }
  loadAccountResources();
}

function bootAlarms() {
  const cfg = loadConfig();
  const regionSelect = $("alarms-region");
  const chatRegion = $("region")?.value;
  if (regionSelect && chatRegion && regionSelect.querySelector(`option[value="${chatRegion}"]`)) {
    regionSelect.value = chatRegion;
  } else if (regionSelect && cfg.region && regionSelect.querySelector(`option[value="${cfg.region}"]`)) {
    regionSelect.value = cfg.region;
  }
  showView("alarms");
  loadAlarms();
}

function setAlarmsStatus(text, isError = false) {
  const el = $("alarms-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-error", Boolean(isError));
}

function updateAlarmsSummary({ count = "—", region, filter } = {}) {
  const countEl = $("alarms-stat-count");
  const regionEl = $("alarms-stat-region");
  const filterEl = $("alarms-stat-filter");
  if (countEl) countEl.textContent = String(count);
  if (regionEl && region) regionEl.textContent = region;
  if (filterEl && filter) filterEl.textContent = filter;
}

function formatAlarmTime(iso) {
  if (!iso) return "Unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderAlarmsLoading() {
  const root = $("alarms-list");
  if (!root) return;
  root.innerHTML = Array.from({ length: 4 }, () => `<div class="alarm-skeleton" aria-hidden="true"></div>`).join("");
}

function selectAlarmTarget(alarm) {
  const lambdaName = alarm.related_lambda;
  const typeSelect = $("resource-type");
  if (typeSelect) {
    typeSelect.value = "lambda";
    updateUiForResourceType();
  }

  const alarmsRegion = $("alarms-region")?.value;
  if (alarmsRegion && $("region")?.querySelector(`option[value="${alarmsRegion}"]`)) {
    $("region").value = alarmsRegion;
  }

  if (lambdaName) {
    const nameInput = $("function-name");
    if (nameInput) nameInput.value = lambdaName;
  }

  const q = $("question");
  if (q) {
    q.value = `Why is alarm "${alarm.alarm_name}" in ${alarm.state}? ${alarm.state_reason}`;
    autoGrow(q);
  }

  showView("chat");
  loadAccountResources().then(() => {
    if (lambdaName) {
      const select = $("resource-select");
      if (select) {
        const match = [...select.options].find((o) => o.value === lambdaName);
        if (match) select.value = lambdaName;
      }
      syncSelectedResource();
    }
  });

  showToast(
    lambdaName
      ? `Investigating ${lambdaName}`
      : "Opened investigate with this alarm context",
  );
  q?.focus();
}

function renderAlarmsList(alarms) {
  const root = $("alarms-list");
  if (!root) return;
  const state = $("alarms-state")?.value || "ALARM";
  if (!alarms.length) {
    root.innerHTML = `
      <div class="alarms-empty">
        <strong>All quiet</strong>
        <span>No alarms${
          state === "ALL" ? "" : ` in ${escapeHtml(state)}`
        } for this region right now.</span>
      </div>`;
    return;
  }

  root.innerHTML = alarms
    .map((a, i) => {
      const stateCls =
        a.state === "OK"
          ? "is-ok"
          : a.state === "INSUFFICIENT_DATA"
            ? "is-insufficient"
            : "";
      const chips = [];
      if (a.namespace) chips.push(a.namespace);
      if (a.metric_name) chips.push(a.metric_name);
      if (a.threshold != null && a.comparison_operator) {
        chips.push(`${a.comparison_operator} ${a.threshold}`);
      }
      const chipsHtml = chips.length
        ? `<div class="alarm-chips">${chips
            .map((c) => `<span class="alarm-chip">${escapeHtml(c)}</span>`)
            .join("")}${
            a.related_lambda
              ? `<span class="alarm-chip is-lambda">Lambda · ${escapeHtml(a.related_lambda)}</span>`
              : ""
          }</div>`
        : a.related_lambda
          ? `<div class="alarm-chips"><span class="alarm-chip is-lambda">Lambda · ${escapeHtml(a.related_lambda)}</span></div>`
          : "";
      const cta = a.related_lambda
        ? `Investigate →`
        : "Open in Investigate →";
      return `
        <button type="button" class="alarm-card ${stateCls}" role="listitem" style="--i:${i}" data-alarm="${escapeHtml(a.alarm_name)}">
          <div class="alarm-card-top">
            <span class="alarm-name">${escapeHtml(a.alarm_name)}</span>
            <span class="alarm-state ${stateCls}">${escapeHtml(a.state || "ALARM")}</span>
          </div>
          <div class="alarm-reason-block">
            <p class="alarm-reason-label">Why it fired</p>
            <p class="alarm-reason">${escapeHtml(a.state_reason || "No reason provided.")}</p>
          </div>
          ${chipsHtml}
          <div class="alarm-footer">
            <p class="alarm-updated">${escapeHtml(formatAlarmTime(a.state_updated_at))}</p>
            <p class="alarm-action">${escapeHtml(cta)}</p>
          </div>
        </button>`;
    })
    .join("");

  root.querySelectorAll(".alarm-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-alarm");
      const alarm = alarms.find((a) => a.alarm_name === name);
      if (alarm) selectAlarmTarget(alarm);
    });
  });
}

let alarmsLoadSeq = 0;

async function loadAlarms() {
  const cfg = loadConfig();
  const region = $("alarms-region")?.value || $("region")?.value || "us-east-1";
  const state = $("alarms-state")?.value || "ALARM";
  const list = $("alarms-list");
  const refreshBtn = $("refresh-alarms");

  updateAlarmsSummary({ region, filter: state });

  if (!configReady(cfg) || !loadAuth()?.idToken) {
    if (list) {
      list.innerHTML = `
        <div class="alarms-empty">
          <strong>Sign in required</strong>
          <span>Authenticate to load CloudWatch alarms for this account.</span>
        </div>`;
    }
    updateAlarmsSummary({ count: "—", region, filter: state });
    setAlarmsStatus("");
    return;
  }

  const seq = ++alarmsLoadSeq;
  setAlarmsStatus(`Loading ${state === "ALL" ? "" : state + " "}alarms in ${region}…`);
  updateAlarmsSummary({ count: "…", region, filter: state });
  renderAlarmsLoading();
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const url = new URL(alarmsApiUrl(cfg));
    url.searchParams.set("region", region);
    url.searchParams.set("state", state);
    const data = await apiFetch(cfg, url.toString(), { method: "GET" });
    if (seq !== alarmsLoadSeq) return;
    const alarms = data.alarms || [];
    renderAlarmsList(alarms);
    updateAlarmsSummary({ count: alarms.length, region, filter: state });
    const trunc = data.truncated ? " (truncated)" : "";
    const label = state === "ALL" ? "alarm(s)" : `${state} alarm(s)`;
    setAlarmsStatus(
      alarms.length
        ? `${alarms.length} ${label}${trunc}`
        : `No ${state === "ALL" ? "" : state + " "}alarms in ${region}`,
    );
  } catch (ex) {
    if (seq !== alarmsLoadSeq) return;
    if (list) {
      list.innerHTML = `
        <div class="alarms-empty">
          <strong>Couldn’t load alarms</strong>
          <span>${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</span>
        </div>`;
    }
    updateAlarmsSummary({ count: "—", region, filter: state });
    setAlarmsStatus(ex instanceof Error ? ex.message : String(ex), true);
  } finally {
    if (seq === alarmsLoadSeq && refreshBtn) refreshBtn.disabled = false;
  }
}

function bootLogin() {
  updateConfigStatus();
  showView("login");
}

/* ——— Events ——— */

$("open-settings").addEventListener("click", openSettings);
$("open-settings-login").addEventListener("click", openSettings);
$("open-settings-alarms")?.addEventListener("click", openSettings);
$("nav-alarms")?.addEventListener("click", () => bootAlarms());
$("nav-investigate")?.addEventListener("click", () => {
  showView("chat");
});
$("logout-btn-alarms")?.addEventListener("click", () => {
  saveAuth(null);
  stopPipeline();
  transcript.innerHTML = "";
  bootLogin();
});
$("settings-cancel").addEventListener("click", () => settingsDialog.close());

$("toggle-password")?.addEventListener("click", () => {
  const input = $("login-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggle-password").setAttribute(
    "aria-label",
    show ? "Hide password" : "Show password",
  );
});

function setSidebarOpen(open) {
  const workspace = document.querySelector(".workspace");
  const sidebar = $("scope-sidebar");
  const backdrop = $("sidebar-backdrop");
  const trigger = $("open-sidebar");
  if (!workspace || !sidebar) return;

  workspace.classList.toggle("sidebar-open", open);
  sidebar.setAttribute("aria-hidden", String(!open));
  trigger?.setAttribute("aria-expanded", String(open));
  trigger?.setAttribute("title", open ? "Close scope" : "Open scope");

  if (backdrop) {
    backdrop.hidden = !open;
  }
}

$("open-sidebar")?.addEventListener("click", () => {
  const open = document.querySelector(".workspace")?.classList.contains("sidebar-open");
  setSidebarOpen(!open);
});
$("close-sidebar")?.addEventListener("click", () => setSidebarOpen(false));
$("sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".workspace.sidebar-open")) {
    setSidebarOpen(false);
  }
});

$("lookback-chips").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  $("lookback-chips")
    .querySelectorAll(".chip")
    .forEach((c) => c.classList.remove("is-active"));
  btn.classList.add("is-active");
  $("lookback").value = btn.dataset.mins;
});

$("clear-chat").addEventListener("click", async () => {
  stopPipeline();
  transcript.innerHTML = "";
  renderEmpty();
  const cfg = loadConfig();
  if (!configReady(cfg) || !loadAuth()) return;
  try {
    await clearHistory(cfg);
    showToast("Chat history cleared");
  } catch (ex) {
    console.warn("history clear failed", ex);
    showToast("Could not clear saved history");
  }
});

$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const cfg = {
    apiUrl: $("cfg-api-url").value.trim().replace(/\/$/, ""),
    userPoolId: $("cfg-pool-id").value.trim(),
    userPoolClientId: $("cfg-client-id").value.trim(),
    region: $("cfg-region").value.trim() || "us-east-1",
  };
  if (!cfg.apiUrl || !cfg.userPoolId || !cfg.userPoolClientId) {
    const err = $("settings-error");
    err.textContent = "All fields are required.";
    err.hidden = false;
    return;
  }
  if (!/investigate\/?$/i.test(cfg.apiUrl)) {
    cfg.apiUrl = `${cfg.apiUrl.replace(/\/$/, "")}/investigate`;
  }
  saveConfig(cfg);
  updateConfigStatus();
  settingsDialog.close();
  showToast("Connection saved");
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cfg = loadConfig();
  const err = $("login-error");
  err.hidden = true;

  if (!configReady(cfg)) {
    err.textContent = "Configure API URL and Cognito IDs first.";
    err.hidden = false;
    openSettings();
    return;
  }

  const submit = $("login-submit");
  submit.disabled = true;
  submit.querySelector?.(".btn-label");
  const original = submit.textContent;
  submit.textContent = "Signing in…";
  try {
    const auth = await cognitoInitiateAuth({
      region: cfg.region,
      clientId: cfg.userPoolClientId,
      username: $("login-email").value.trim(),
      password: $("login-password").value,
    });
    saveAuth(auth);
    $("login-password").value = "";
    bootChat();
  } catch (ex) {
    err.textContent = ex instanceof Error ? ex.message : String(ex);
    err.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = original;
  }
});

$("logout-btn").addEventListener("click", () => {
  saveAuth(null);
  stopPipeline();
  transcript.innerHTML = "";
  bootLogin();
});

$("resource-type")?.addEventListener("change", () => {
  $("resource-filter").value = "";
  $("function-name").value = "";
  updateUiForResourceType({ announceSuggestions: true });
  loadAccountResources();
});
$("region")?.addEventListener("change", () => loadAccountResources());
$("refresh-resources")?.addEventListener("click", () => loadAccountResources());
$("refresh-alarms")?.addEventListener("click", () => loadAlarms());
$("alarms-region")?.addEventListener("change", () => loadAlarms());
$("alarms-state")?.addEventListener("change", () => loadAlarms());
$("resource-filter")?.addEventListener("input", () => {
  populateResourceSelect(cachedResources, $("resource-select")?.value || "");
});
$("resource-select")?.addEventListener("change", syncSelectedResource);

$("compose-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cfg = loadConfig();
  const question = $("question").value.trim();
  if (!question) return;

  if (!configReady(cfg)) {
    appendError("Configure the API connection in Settings first.");
    openSettings();
    return;
  }

  const resourceType = currentResourceType();
  const resource = selectedResourceMeta();
  const region = $("region").value.trim() || "us-east-1";
  const lookback = Number($("lookback").value) || 60;

  if (!resource.id && deepInvestigateSupported(resourceType)) {
    appendError(
      "Select a Lambda from the list, or paste the function name in “Selected / paste name”.",
    );
    return;
  }

  if (!resource.id && !deepInvestigateSupported(resourceType)) {
    appendError(
      `Select a ${resourceType} resource from the list (or paste its name), then ask again.`,
    );
    return;
  }

  const display = `${question}\n\n→ ${resourceType}: ${resource.name} · ${region} · ${lookback}m`;

  appendUserMessage(display);
  $("question").value = "";
  autoGrow($("question"));
  const sendBtn = $("send-btn");
  sendBtn.disabled = true;
  appendTyping(resourceType);

  try {
    if (!deepInvestigateSupported(resourceType)) {
      await new Promise((r) => setTimeout(r, 650));
      const guided = renderResourceGuidance({
        type: resourceType,
        resource,
        region,
        question,
      });
      try {
        await saveHistoryTurn(cfg, {
          question,
          resource_type: resourceType,
          resource_name: resource.name || resource.id,
          region,
          lookback_minutes: lookback,
          result: guided,
        });
      } catch (histEx) {
        console.warn("history save failed", histEx);
      }
      return;
    }

    const result = await investigate(cfg, {
      function_name: resource.id,
      region,
      question,
      lookback_minutes: lookback,
      resource_type: resourceType,
    });
    renderFindings(result);
  } catch (ex) {
    const msg = ex instanceof Error ? ex.message : String(ex);
    appendError(msg);
    if (/sign in|unauthorized|expired/i.test(msg)) {
      saveAuth(null);
      setTimeout(bootLogin, 800);
    }
  } finally {
    sendBtn.disabled = false;
    $("question").focus();
  }
});

$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("compose-form").requestSubmit();
  }
});

$("question").addEventListener("input", () => autoGrow($("question")));

/* ——— Init ——— */

(function init() {
  const cfg = loadConfig();
  fillSettingsForm(cfg);
  updateConfigStatus();
  const auth = loadAuth();
  if (auth?.idToken && configReady(cfg)) {
    bootChat();
  } else {
    bootLogin();
  }
})();
