import postgres from "postgres";

type JsonMap = Record<string, unknown>;

const PORT = process.env.PORT || "3100";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PUBLIC_ORIGIN = (process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL || BASE_URL).replace(/\/+$/, "");

function resolveDbUrl(): string {
  const raw = (process.env.DATABASE_URL || "").trim();
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
    Origin: PUBLIC_ORIGIN,
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

async function main(): Promise<void> {
  const adminEmail = (process.env.PAPERCLIP_ADMIN_EMAIL || "").trim();
  const adminPassword = (process.env.PAPERCLIP_ADMIN_PASSWORD || "").trim();
  if (!adminEmail || !adminPassword || adminEmail.startsWith("${") || adminPassword.startsWith("${")) {
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

  const sql = postgres(resolveDbUrl(), { max: 1 });
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
  } finally {
    await sql.end();
  }

  const companiesRes = await apiRequest("/api/companies", cookies);
  if (!companiesRes.ok || !Array.isArray(companiesRes.data)) {
    throw new Error(`Failed to list companies (HTTP ${companiesRes.status}): ${companiesRes.text}`);
  }

  let company = companiesRes.data[0] as JsonMap | undefined;
  if (!company) {
    const rawProjectName = (process.env.PROJECT_NAME || "").trim();
    const companyName = rawProjectName && !rawProjectName.startsWith("${") ? rawProjectName : "Baiosfera";
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
    if (typeof agent.name === "string") {
      existingByName.set(agent.name.toLowerCase(), agent);
    }
  }

  const hermesApiKey =
    (process.env.HERMES_GATEWAY_KEY || process.env.BIFROST_MASTER_VK || "vk-hermes-agent").trim() || "vk-hermes-agent";

  const ensureAgent = async (spec: JsonMap): Promise<JsonMap> => {
    const key = String(spec.name).toLowerCase();
    const existing = existingByName.get(key);
    if (existing) return existing;
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

  const hermes = await ensureAgent({
    name: "Hermes",
    role: "ceo",
    title: "Autonomous Orchestrator & NATS/Telegram CEO",
    capabilities: "Sovereign multi-channel orchestrator, Telegram & NATS gateway, CrewAI router, Linear bridge",
    adapterType: "hermes_gateway",
    adapterConfig: {
      apiBaseUrl: "http://hermes:8000",
      apiKey: hermesApiKey,
      dangerouslyAllowInsecureRemoteHttp: true,
      paperclipApiUrl: "http://paperclip:3100",
      sessionKeyStrategy: "issue",
      timeoutSec: 300,
    },
  });

  const hermesId = String(hermes.id);

  await ensureAgent({
    name: "AGY",
    role: "cto",
    title: "Antigravity Platform Architect (ZCP)",
    reportsTo: hermesId,
    capabilities: "ZCP control-plane architect, Zerops MCP infrastructure orchestrator, F0-F5 epistemic governance",
    adapterType: "http",
    adapterConfig: {
      url: "http://zcp:8080/healthz",
      method: "POST",
      timeoutSec: 60,
    },
  });

  await ensureAgent({
    name: "PiDev",
    role: "engineer",
    title: "Autonomous Code Builder (Gentle-Pi)",
    reportsTo: hermesId,
    capabilities: "Headless and interactive Gentle-Pi coding agent, Astro 5 / TypeScript builder, test runner",
    adapterType: "http",
    adapterConfig: {
      url: "http://pidev:3000/execute",
      method: "POST",
      timeoutSec: 300,
    },
  });

  await ensureAgent({
    name: "CrewAI",
    role: "researcher",
    title: "Multi-Agent Swarm Engine",
    reportsTo: hermesId,
    capabilities: "Polymorphic CrewAI swarm runner via Hermes gateway & sovereign skill registry",
    adapterType: "hermes_gateway",
    adapterConfig: {
      apiBaseUrl: "http://hermes:8000",
      apiKey: hermesApiKey,
      dangerouslyAllowInsecureRemoteHttp: true,
      paperclipApiUrl: "http://paperclip:3100",
      headers: { "X-Crew-Name": "research" },
      sessionKeyStrategy: "issue",
      timeoutSec: 600,
    },
  });

  console.log(
    `• [bootstrap-org] Paperclip ready: company="${String(company.name)}" agents=${Array.from(existingByName.keys()).join(",")}`,
  );
}

main().catch((err) => {
  console.error("• [bootstrap-org] Bootstrap warning:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
