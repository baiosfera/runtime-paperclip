import postgres from "postgres";

type JsonMap = Record<string, unknown>;

const PORT = process.env.PORT || "3100";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PUBLIC_ORIGIN = (process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL || BASE_URL).replace(/\/+$/, "");

function cleanEnv(val: string | undefined): string {
  const s = (val || "").trim();
  return !s || s.startsWith("${") ? "" : s;
}

function resolveDbUrl(): string {
  const raw = cleanEnv(process.env.DATABASE_URL);
  if (!raw) throw new Error("DATABASE_URL is not configured");
  return raw.endsWith("/db") ? `${raw.slice(0, -3)}/paperclip` : raw;
}

function mergeCookies(existing: Map<string, string>, headers: Headers): string {
  const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const pair = raw.split(";")[0]?.trim();
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      existing.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
    }
  }
  return Array.from(existing.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function apiRequest(
  path: string,
  cookies: Map<string, string>,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const cookieHeader = Array.from(cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const headers: Record<string, string> = {
    Origin: path.startsWith("/api/auth/") ? PUBLIC_ORIGIN : BASE_URL,
    Accept: "application/json",
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method || "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  mergeCookies(cookies, res.headers);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function resolveHermesApiBaseUrl(): Promise<{ url: string; tls: boolean }> {
  const explicit = cleanEnv(process.env.HERMES_PUBLIC_URL).replace(/\/+$/, "");
  if (explicit.startsWith("https://")) {
    return { url: explicit, tls: true };
  }
  const selfSubdomain = cleanEnv(process.env.zeropsSubdomain) || cleanEnv(process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL);
  if (selfSubdomain.startsWith("https://")) {
    try {
      const parsed = new URL(selfSubdomain);
      const derivedHost = parsed.hostname.replace(/^paperclip-([^-]+)-\d+\./, "hermes-$1-8000.");
      if (derivedHost !== parsed.hostname) {
        const candidate = `https://${derivedHost}`;
        const probe = await fetch(`${candidate}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (probe.ok) {
          return { url: candidate, tls: true };
        }
      }
    } catch {
      // Fallback to internal private HTTP URL below
    }
  }
  const internal = (cleanEnv(process.env.HERMES_GATEWAY_URL) || "http://hermes:8000").replace(/\/+$/, "");
  return { url: internal, tls: internal.startsWith("https://") };
}

async function discoverBifrostModels(): Promise<string[]> {
  const bifrostBase = (cleanEnv(process.env.BIFROST_URL) || "http://bifrost:8080").replace(/\/+$/, "");
  const masterVk = cleanEnv(process.env.BIFROST_MASTER_VK);
  try {
    const res = await fetch(`${bifrostBase}/v1/models`, {
      headers: masterVk ? { Authorization: `Bearer ${masterVk}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return Array.isArray(body.data)
      ? body.data.map((m) => String(m.id || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

async function discoverHermesCrews(hermesInternalUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${hermesInternalUrl}/crews`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { registered?: unknown; crews?: unknown };
    if (Array.isArray(body.registered) && body.registered.length > 0) {
      return body.registered.map((c) => String(c).trim()).filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}

async function discoverPidevHealth(): Promise<{ reachable: boolean; workspaceDir: string; executeAuthEnabled: boolean }> {
  const pidevBase = (cleanEnv(process.env.PIDEV_URL) || "http://pidev:3000").replace(/\/+$/, "");
  try {
    const res = await fetch(`${pidevBase}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { reachable: false, workspaceDir: "", executeAuthEnabled: false };
    const body = (await res.json()) as { workspace_dir?: string; execute_auth_enabled?: boolean };
    return {
      reachable: true,
      workspaceDir: String(body.workspace_dir || ""),
      executeAuthEnabled: Boolean(body.execute_auth_enabled),
    };
  } catch {
    return { reachable: false, workspaceDir: "", executeAuthEnabled: false };
  }
}

async function waitForHealth(maxSeconds = 60): Promise<void> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Paperclip server did not respond healthy on ${BASE_URL}/api/health within ${maxSeconds}s`);
}

function isLegacyDummyAgent(agent: JsonMap): boolean {
  const name = String(agent.name || "").toLowerCase();
  const cfg = (agent.adapterConfig || {}) as JsonMap;
  const url = String(cfg.url || "");
  if (name === "agy" && url.includes("/zcp-login")) return true;
  if (name === "crewai" && String(((cfg.headers || {}) as JsonMap)["X-Crew-Name"] || "") === "research") return true;
  return false;
}

async function main(): Promise<void> {
  const adminEmail = cleanEnv(process.env.PAPERCLIP_ADMIN_EMAIL);
  const adminPassword = cleanEnv(process.env.PAPERCLIP_ADMIN_PASSWORD);
  if (!adminEmail || !adminPassword) {
    console.log("• [bootstrap-org] PAPERCLIP_ADMIN_EMAIL/PASSWORD unset; skipping auto-bootstrap.");
    return;
  }

  await waitForHealth(60);

  const cookies = new Map<string, string>();
  let authRes = await apiRequest("/api/auth/sign-in/email", cookies, {
    method: "POST",
    body: { email: adminEmail, password: adminPassword },
  });

  if (!authRes.ok) {
    authRes = await apiRequest("/api/auth/sign-up/email", cookies, {
      method: "POST",
      body: { name: "Admin", email: adminEmail, password: adminPassword },
    });
    if (!authRes.ok) {
      throw new Error(`Admin sign-up/sign-in failed (HTTP ${authRes.status}): ${authRes.text}`);
    }
    if (cookies.size === 0) {
      authRes = await apiRequest("/api/auth/sign-in/email", cookies, {
        method: "POST",
        body: { email: adminEmail, password: adminPassword },
      });
    }
  }

  const sessionRes = await apiRequest("/api/auth/get-session", cookies);
  const sessionObj = (sessionRes.data || {}) as JsonMap;
  let userId = ((sessionObj.user as JsonMap | undefined)?.id as string | undefined) || "";

  const dbUrl = resolveDbUrl();
  let lastDbErr: unknown = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const sql = postgres(dbUrl, { max: 1, connect_timeout: 10 });
    try {
      if (!userId) {
        const rows = await sql`SELECT id FROM "user" WHERE lower(email) = lower(${adminEmail}) LIMIT 1`;
        userId = (rows[0]?.id as string | undefined) || "";
      }
      if (!userId) {
        throw new Error("Unable to resolve Paperclip admin user ID after authentication");
      }

      await sql`
        INSERT INTO instance_user_roles (user_id, role)
        VALUES (${userId}, 'instance_admin')
        ON CONFLICT (user_id, role) DO NOTHING
      `;

      await sql`
        UPDATE invites
        SET revoked_at = NOW(), updated_at = NOW()
        WHERE invite_type = 'bootstrap_ceo' AND revoked_at IS NULL AND accepted_at IS NULL
      `;
      lastDbErr = null;
      break;
    } catch (err) {
      lastDbErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = msg.includes("connection slots") || msg.includes("ECONNREFUSED") || msg.includes("53300");
      if (!transient || attempt === 6) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, attempt * 2000));
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {});
    }
  }
  if (lastDbErr) throw lastDbErr;

  const companiesRes = await apiRequest("/api/companies", cookies);
  if (!companiesRes.ok || !Array.isArray(companiesRes.data)) {
    throw new Error(`Failed to list companies (HTTP ${companiesRes.status}): ${companiesRes.text}`);
  }

  let company = companiesRes.data[0] as JsonMap | undefined;
  if (!company) {
    const companyName = cleanEnv(process.env.PROJECT_NAME) || "Default Organization";
    const createCompany = await apiRequest("/api/companies", cookies, {
      method: "POST",
      body: {
        name: companyName,
        description: "Autonomous Sovereign AI Organization Mesh",
        budgetMonthlyCents: 0,
      },
    });
    if (!createCompany.ok || !createCompany.data) {
      throw new Error(`Failed to create company (HTTP ${createCompany.status}): ${createCompany.text}`);
    }
    company = createCompany.data as JsonMap;
  }

  const companyId = String(company.id);
  const agentsRes = await apiRequest(`/api/companies/${companyId}/agents`, cookies);
  if (!agentsRes.ok || !Array.isArray(agentsRes.data)) {
    throw new Error(`Failed to list company agents (HTTP ${agentsRes.status}): ${agentsRes.text}`);
  }

  const existingByName = new Map<string, JsonMap>();
  for (const agent of agentsRes.data as JsonMap[]) {
    if (isLegacyDummyAgent(agent)) {
      await apiRequest(`/api/agents/${String(agent.id)}/terminate`, cookies, {
        method: "POST",
        body: {},
      });
      const delRes = await apiRequest(`/api/agents/${String(agent.id)}`, cookies, {
        method: "DELETE",
      });
      if (delRes.ok) {
        console.log(`• [bootstrap-org] Removed legacy dummy agent: ${String(agent.name)}`);
        continue;
      }
      console.warn(`• [bootstrap-org] Failed removing legacy dummy agent ${String(agent.name)} (HTTP ${delRes.status}): ${delRes.text}`);
    }
    if (typeof agent.name === "string") {
      existingByName.set(agent.name.toLowerCase(), agent);
    }
  }

  const [bifrostModels, hermesTarget, pidevHealth] = await Promise.all([
    discoverBifrostModels(),
    resolveHermesApiBaseUrl(),
    discoverPidevHealth(),
  ]);
  const hermesInternal = (cleanEnv(process.env.HERMES_GATEWAY_URL) || "http://hermes:8000").replace(/\/+$/, "");
  const hermesCrews = await discoverHermesCrews(hermesInternal);

  const hermesApiKey =
    cleanEnv(process.env.HERMES_GATEWAY_KEY) || cleanEnv(process.env.BIFROST_MASTER_VK) || "vk-hermes-agent";
  const pidevToken = cleanEnv(process.env.PIDEV_EXECUTE_TOKEN) || cleanEnv(process.env.PIDEV_API_KEY);

  const ensureAgent = async (spec: JsonMap): Promise<JsonMap> => {
    const key = String(spec.name).toLowerCase();
    const existing = existingByName.get(key);
    if (existing) {
      const existingCfg = (existing.adapterConfig || {}) as JsonMap;
      const desiredCfg = (spec.adapterConfig || {}) as JsonMap;
      const needsCfgSync =
        (desiredCfg.runner !== undefined && existingCfg.runner !== desiredCfg.runner) ||
        (desiredCfg.url !== undefined && existingCfg.url !== desiredCfg.url) ||
        (desiredCfg.headers !== undefined &&
          JSON.stringify(existingCfg.headers || {}) !== JSON.stringify(desiredCfg.headers));
      if (needsCfgSync) {
        const patched = await apiRequest(`/api/agents/${String(existing.id)}`, cookies, {
          method: "PATCH",
          body: {
            adapterConfig: { ...existingCfg, ...desiredCfg },
            ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
          },
        });
        if (patched.ok && patched.data) {
          const updatedObj = patched.data as JsonMap;
          existingByName.set(key, updatedObj);
          return updatedObj;
        }
      }
      return existing;
    }
    const created = await apiRequest(`/api/companies/${companyId}/agents`, cookies, {
      method: "POST",
      body: spec,
    });
    if (!created.ok || !created.data) {
      throw new Error(`Failed creating agent ${spec.name} (HTTP ${created.status}): ${created.text}`);
    }
    const createdObj = created.data as JsonMap;
    existingByName.set(key, createdObj);
    return createdObj;
  };

  const modelsSummary = bifrostModels.length > 0 ? `Bifrost models: ${bifrostModels.slice(0, 6).join(", ")}` : "Bifrost dynamic router";

  const hermes = await ensureAgent({
    name: "Hermes",
    role: "ceo",
    title: "Autonomous Orchestrator & NATS/Telegram Gateway",
    capabilities: `Multi-channel orchestrator, Telegram & NATS gateway, CrewAI router, Linear bridge (${modelsSummary})`,
    adapterType: "hermes_gateway",
    adapterConfig: {
      apiBaseUrl: hermesTarget.url,
      apiKey: hermesApiKey,
      ...(hermesTarget.tls ? {} : { dangerouslyAllowInsecureRemoteHttp: true }),
      paperclipApiUrl: "http://paperclip:3100",
      sessionKeyStrategy: "issue",
      timeoutSec: 300,
    },
  });

  const hermesId = String(hermes.id);

  if (pidevHealth.reachable || pidevToken) {
    await ensureAgent({
      name: "PiDev",
      role: "engineer",
      title: "Autonomous Code Builder (Gentle-Pi)",
      reportsTo: hermesId,
      capabilities: `Gentle-Pi coding agent (${pidevHealth.workspaceDir || "/mnt/localstorage/pidev/workspaces"})`,
      adapterType: "http",
      adapterConfig: {
        url: `${(cleanEnv(process.env.PIDEV_URL) || "http://pidev:3000").replace(/\/+$/, "")}/execute`,
        method: "POST",
        runner: "legacy",
        ...(pidevToken ? { headers: { Authorization: `Bearer ${pidevToken}` } } : {}),
        timeoutSec: 300,
      },
    });
  }

  for (const crewName of hermesCrews) {
    const displayName = `Crew-${crewName}`;
    await ensureAgent({
      name: displayName,
      role: "researcher",
      title: `CrewAI Swarm (${crewName})`,
      reportsTo: hermesId,
      status: "paused",
      capabilities: `Dynamic CrewAI swarm '${crewName}' via Hermes gateway`,
      adapterType: "hermes_gateway",
      adapterConfig: {
        apiBaseUrl: hermesTarget.url,
        apiKey: hermesApiKey,
        ...(hermesTarget.tls ? {} : { dangerouslyAllowInsecureRemoteHttp: true }),
        paperclipApiUrl: "http://paperclip:3100",
        headers: { "X-Crew-Name": crewName },
        sessionKeyStrategy: "issue",
        timeoutSec: 600,
      },
    });
  }

  console.log(
    `• [bootstrap-org] Paperclip ready: company="${String(company.name)}" bifrost_models=${bifrostModels.length} hermes_crews=${hermesCrews.length} agents=${Array.from(existingByName.keys()).join(",")}`,
  );
}

main().catch((err) => {
  console.error("• [bootstrap-org] Bootstrap warning:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
