import * as core from "@actions/core";

type Operation =
  | "hit"
  | "create"
  | "get"
  | "info"
  | "set"
  | "update"
  | "reset"
  | "delete";

type HttpMethod = "GET" | "POST";

const BASE_URL = "https://abacus.jasoncameron.dev";
const MAX_ATTEMPTS = 5;

// Abacus format: ^[A-Za-z0-9_-.]{3,64}$ :contentReference[oaicite:1]{index=1}
const NAME_RE = /^[A-Za-z0-9_.-]{3,64}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function requireNonEmpty(name: string, value: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required input: ${name}`);
  }
}

function validateName(kind: "namespace" | "key", value: string): void {
  // Abacus docs state both must match the regex above. :contentReference[oaicite:2]{index=2}
  if (!NAME_RE.test(value)) {
    throw new Error(
      `Invalid ${kind}: must match ^[A-Za-z0-9_-.]{3,64}$ (got "${value}")`
    );
  }
}

function parseInteger(name: string, raw: string): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`Invalid ${name}: expected integer, got "${raw}"`);
  }
  return v;
}

function isAdminOp(op: Operation): boolean {
  return op === "set" || op === "update" || op === "reset" || op === "delete";
}

function methodFor(op: Operation): HttpMethod {
  // Abacus: hit/create/get/info are GET; set/update/reset/delete are POST. :contentReference[oaicite:3]{index=3} :contentReference[oaicite:4]{index=4}
  return isAdminOp(op) ? "POST" : "GET";
}

function buildUrl(op: Operation, namespace: string, key: string, initializer?: number, value?: number): string {
  const base = normalizeBaseUrl(BASE_URL);

  // Abacus uses /op/:namespace/*key for most endpoints. :contentReference[oaicite:5]{index=5}
  // Encode to keep keys stable and avoid path surprises.
  const path = `/${op}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
  const url = new URL(base + path);

  if (op === "create" && initializer !== undefined) {
    url.searchParams.set("initializer", String(initializer));
  }
  if ((op === "set" || op === "update") && value !== undefined) {
    url.searchParams.set("value", String(value));
  }

  return url.toString();
}

async function requestWithRetries(url: string, method: HttpMethod, headers: Record<string, string>): Promise<Response> {
  let attempt = 0;
  let backoffMs = 500;

  while (true) {
    attempt += 1;

    try {
      const res = await fetch(url, { method, headers });

      // 429: respect Retry-After (ms). :contentReference[oaicite:6]{index=6}
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const ra = res.headers.get("Retry-After");
        const waitMs = ra ? Math.max(0, parseInteger("Retry-After", ra)) : backoffMs;
        // Drain body to free resources before retry.
        try { await res.text(); } catch { /* ignore */ }
        await sleep(waitMs);
        backoffMs = Math.min(backoffMs * 2, 8000);
        continue;
      }

      // Retry transient 5xx (small number of times).
      if (res.status >= 500 && res.status <= 599 && attempt < MAX_ATTEMPTS) {
        try { await res.text(); } catch { /* ignore */ }
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 8000);
        continue;
      }

      return res;
    } catch (err) {
      // Network/timeout/etc. Retry a bit.
      if (attempt >= MAX_ATTEMPTS) {
        throw err;
      }
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 8000);
    }
  }
}

async function readJsonSafely(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Some endpoints might return non-JSON in edge cases; treat as error payload.
    return { error: text };
  }
}

function setOutputIfPresent(name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  // Actions outputs are strings; keep deterministic.
  core.setOutput(name, String(value));
}

async function run(): Promise<void> {
  const operationRaw = core.getInput("operation") || "hit";
  const operation = operationRaw as Operation;

  const namespace = core.getInput("namespace");
  const key = core.getInput("key");

  requireNonEmpty("namespace", namespace);
  requireNonEmpty("key", key);
  validateName("namespace", namespace);
  validateName("key", key);

  const initializerRaw = core.getInput("initializer") || "0";
  const valueRaw = core.getInput("value");
  const adminKey = core.getInput("admin_key");

  if (isAdminOp(operation)) {
    requireNonEmpty("admin_key", adminKey);
    core.setSecret(adminKey);
  }

  if ((operation === "set" || operation === "update") && (!valueRaw || valueRaw.trim() === "")) {
    throw new Error(`Missing required input: value (required for operation=${operation})`);
  }

  const initializer = operation === "create" ? parseInteger("initializer", initializerRaw) : undefined;
  const value = (operation === "set" || operation === "update") ? parseInteger("value", valueRaw) : undefined;

  const url = buildUrl(operation, namespace, key, initializer, value);
  const method = methodFor(operation);

  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  if (isAdminOp(operation)) {
    // Abacus: Authorization: Bearer YOUR_ADMIN_KEY :contentReference[oaicite:7]{index=7}
    headers["Authorization"] = `Bearer ${adminKey}`;
  }

  const res = await requestWithRetries(url, method, headers);
  const payload = await readJsonSafely(res);

  if (!res.ok) {
    const errMsg =
      typeof payload?.error === "string"
        ? payload.error
        : `Request failed with status ${res.status}`;
    throw new Error(`${errMsg} (operation=${operation})`);
  }

  // Common / operation-specific outputs
  setOutputIfPresent("value", payload.value);

  if (operation === "create") {
    setOutputIfPresent("namespace", payload.namespace);
    setOutputIfPresent("key", payload.key);
    setOutputIfPresent("admin_key", payload.admin_key);
    if (typeof payload?.admin_key === "string") {
      core.setSecret(payload.admin_key);
    }
  }

  if (operation === "info") {
    setOutputIfPresent("exists", payload.exists);
    setOutputIfPresent("expires_in", payload.expires_in);
    setOutputIfPresent("expires_str", payload.expires_str);
    setOutputIfPresent("full_key", payload.full_key);
    setOutputIfPresent("is_genuine", payload.is_genuine);
  }

  if (operation === "delete") {
    setOutputIfPresent("status", payload.status);
    setOutputIfPresent("message", payload.message);
  }
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(msg);
});
