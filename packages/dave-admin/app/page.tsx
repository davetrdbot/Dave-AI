"use client";

import { useCallback, useEffect, useState } from "react";

type Tab = "stats" | "groups" | "teams" | "models" | "selfimprove" | "db" | "mcp" | "credentials" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "stats", label: "Live Stats" },
  { id: "groups", label: "Pair Groups" },
  { id: "teams", label: "Agent Teams" },
  { id: "models", label: "AI Models" },
  { id: "selfimprove", label: "Self-Improvement" },
  { id: "db", label: "Database" },
  { id: "mcp", label: "MCP" },
  { id: "credentials", label: "Credentials" },
  { id: "settings", label: "Settings" },
];

function useApi(userId: string) {
  return useCallback(
    async (path: string, opts?: RequestInit) => {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`${path}${sep}userId=${encodeURIComponent(userId)}`, opts);
      return res.json();
    },
    [userId]
  );
}

export default function AdminPage() {
  const [userId, setUserId] = useState("default");
  const [tab, setTab] = useState<Tab>("stats");

  return (
    <>
      <header>
        <div className="brand">
          <span className="dot" />
          <div>
            <h1>Dave — Admin Panel</h1>
            <div className="sub">Monitoring and configuration only — trading actions happen via Telegram</div>
          </div>
        </div>
        <div className="row">
          <input type="text" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="userId" style={{ width: 120 }} />
        </div>
      </header>

      <nav>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === "stats" && <StatsPanel userId={userId} />}
        {tab === "groups" && <GroupsPanel userId={userId} />}
        {tab === "teams" && <TeamsPanel userId={userId} />}
        {tab === "models" && <ModelsPanel userId={userId} />}
        {tab === "selfimprove" && <SelfImprovementPanel userId={userId} />}
        {tab === "db" && <DatabasePanel userId={userId} />}
        {tab === "mcp" && <McpPanel userId={userId} />}
        {tab === "credentials" && <CredentialsPanel userId={userId} />}
        {tab === "settings" && <SettingsPanel />}
      </main>
    </>
  );
}

// --- Live Stats (14.1) ---
function StatsPanel({ userId }: { userId: string }) {
  const api = useApi(userId);
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    api("/api/stats").then(setStats);
  }, [api]);

  if (!stats) return <div className="card placeholder">Loading...</div>;

  const tiles: [string, string | number][] = [
    ["Uptime", `${stats.uptimeSeconds}s`],
    ["Pair groups", stats.pairGroupCount],
    ["Active workers", stats.activeWorkerCount],
    ["Comms messages", stats.commsMessageCount],
    ["Max open trades", stats.maxOpenTrades ?? "not set"],
    ["Max daily loss %", stats.maxDailyLossPct ?? "not set"],
  ];

  return (
    <div className="card">
      <h2>Live Stats</h2>
      <div className="stat-grid">
        {tiles.map(([label, value]) => (
          <div className="stat-tile" key={label}>
            <div className="value">{value}</div>
            <div className="label">{label}</div>
          </div>
        ))}
      </div>
      <div className="stat-note">{stats.note}</div>
    </div>
  );
}

// --- Pair Group Designer (14.1) -- real CRUD against dave-trading's own storage ---
function GroupsPanel({ userId }: { userId: string }) {
  const api = useApi(userId);
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState({ id: "", name: "", symbols: "" });

  const reload = useCallback(() => {
    api("/api/pair-groups").then(setData);
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!data) return <div className="card placeholder">Loading...</div>;

  const addGroup = async () => {
    const symbols = form.symbols
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!form.id || !form.name || symbols.length === 0) {
      alert("id, name, and at least one symbol are required");
      return;
    }
    await api("/api/pair-groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: form.id, name: form.name, symbols }) });
    setForm({ id: "", name: "", symbols: "" });
    reload();
  };

  const setActive = async (groupId: string) => {
    await api("/api/pair-groups/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId }) });
    reload();
  };
  const setFallback = async (groupId: string) => {
    await api("/api/pair-groups/fallback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId }) });
    reload();
  };
  const remove = async (groupId: string) => {
    await api(`/api/pair-groups/${groupId}`, { method: "DELETE" });
    reload();
  };

  return (
    <>
      <div className="card">
        <h2>Active and Fallback</h2>
        <div className="row">
          <span className={`badge ${data.activeGroup ? "ok" : "warn"}`}>Active: {data.activeGroup ? data.activeGroup.name : "none selected"}</span>
          <span className={`badge ${data.fallbackGroup ? "ok" : "warn"}`}>Fallback: {data.fallbackGroup ? data.fallbackGroup.name : "none selected"}</span>
          {data.pausedForExtremeConditions && <span className="badge bad">Paused (extreme conditions)</span>}
        </div>
      </div>
      <div className="card">
        <h2>Pair Group Designer</h2>
        <div className="row" style={{ marginBottom: 14 }}>
          <input type="text" placeholder="id (e.g. majors)" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} style={{ width: 130 }} />
          <input type="text" placeholder="Display name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: 150 }} />
          <input type="text" placeholder="Symbols, comma separated" value={form.symbols} onChange={(e) => setForm({ ...form, symbols: e.target.value })} style={{ width: 260 }} />
          <button className="btn" onClick={addGroup}>
            Add group
          </button>
        </div>
        {data.groups.length === 0 && <div className="placeholder">No pair groups yet — add one above.</div>}
        {data.groups.map((g: any) => (
          <div className="group-card" key={g.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{g.name}</strong> <span style={{ color: "var(--text-dim)" }}>({g.id})</span>
                <div className="symbols">
                  {g.symbols.map((s: string) => (
                    <span className="pill" key={s}>
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <div className="row">
                <button className="btn secondary" onClick={() => setActive(g.id)}>
                  Set active
                </button>
                <button className="btn secondary" onClick={() => setFallback(g.id)}>
                  Set fallback
                </button>
                <button className="btn danger" onClick={() => remove(g.id)}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// --- Agent Teams (14.1/13.3) ---
function TeamsPanel({ userId }: { userId: string }) {
  const api = useApi(userId);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api("/api/agent-teams").then(setData);
  }, [api]);

  if (!data) return <div className="card placeholder">Loading...</div>;

  const nameById: Record<string, string> = { dave: "Dave" };
  data.workers.forEach((w: any) => (nameById[w.id] = w.name));
  const displayName = (id: string) => nameById[id] ?? id;

  return (
    <>
      <div className="card">
        <h2>Workers</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Assignment</th>
                <th>Task</th>
              </tr>
            </thead>
            <tbody>
              {data.workers.length === 0 && (
                <tr>
                  <td colSpan={4} className="placeholder">
                    No active workers
                  </td>
                </tr>
              )}
              {data.workers.map((w: any) => (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td>{w.role}</td>
                  <td>{w.assignment}</td>
                  <td>{w.task}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2>Agent Teams — live feed</h2>
        {data.feed.length === 0 && <div className="placeholder">No messages yet</div>}
        {[...data.feed].reverse().map((m: any, i: number) => (
          <div className="feed-item" key={i}>
            <div>
              {displayName(m.from)} to {displayName(m.to)}: {m.content}
            </div>
            <div className="meta">{new Date(m.ts).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </>
  );
}

// --- AI Model Picker (14.1/5.2) ---
function ModelsPanel({ userId }: { userId: string }) {
  const api = useApi(userId);
  const [config, setConfig] = useState<any>(null);
  const [primary, setPrimary] = useState("airllm");
  const [railwayLoad, setRailwayLoad] = useState<boolean | null>(null);

  const reload = useCallback(() => {
    api("/api/model-config").then((c) => {
      setConfig(c);
      setPrimary(c.primary);
    });
    api("/api/railway-model-toggle").then((r) => setRailwayLoad(r.enabled));
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async () => {
    const fallback = ["airllm", "deepseek", "claude"].filter((p) => p !== primary);
    await api("/api/model-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ primary, fallback }) });
    reload();
  };

  const toggleRailwayLoad = async () => {
    const next = !railwayLoad;
    await api("/api/railway-model-toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: next }) });
    reload();
  };

  return (
    <div className="card">
      <h2>AI Model Picker</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <span>Primary:</span>
        <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
          <option value="airllm">AirLLM (self-hosted Qwen3-235B)</option>
          <option value="deepseek">DeepSeek</option>
          <option value="claude">Claude</option>
        </select>
        <button className="btn secondary" onClick={save}>
          Save
        </button>
      </div>
      {config && <div className="stat-note">fallback order: {config.fallback.join(" then ")}</div>}

      <div className="group-card" style={{ marginTop: 16 }}>
        <strong>Load Model on Railway</strong>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn secondary" onClick={toggleRailwayLoad} disabled={railwayLoad === null}>
            {railwayLoad ? "ON" : "OFF"}
          </button>
        </div>
        <div className="stat-note" style={{ marginTop: 8 }}>
          When ON, Dave attempts to run AirLLM directly on this Railway instance -- no separate GPU host
          needed to try it. This will be slow (CPU-only, no GPU on Railway) and is best-effort; the
          DeepSeek/Claude fallback providers remain the reliable path. When OFF (default), Dave expects
          AirLLM to run on an external host.
        </div>
      </div>
    </div>
  );
}

// --- Self-Improvement (Step 17) ---
function SelfImprovementPanel({ userId }: { userId: string }) {
  const api = useApi(userId);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api("/api/self-improvement").then(setData);
  }, [api]);

  if (!data) return <div className="card">Loading...</div>;

  return (
    <div className="card">
      <h2>Self-Improvement</h2>
      <div className="stat-note">{data.note}</div>
      <div className="stat-note">Pending patch proposals: {data.pendingPatches ?? 0}</div>
      {data.lineage?.length ? (
        data.lineage.map((v: any) => (
          <div className="group-card" key={v.id}>
            <strong>{v.targetFile}</strong>
            <div className="stat-note">{v.changelogEntry}</div>
            <div className="stat-note">evolved from: {v.evolvedFrom ?? "(lineage root)"}</div>
          </div>
        ))
      ) : (
        <div className="placeholder">No versions yet -- Dave hasn't applied a self-patch.</div>
      )}
    </div>
  );
}

// --- Database + Automation (Step 16) ---
function DatabasePanel({ userId }: { userId: string }) {
  const api = useApi(userId);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api("/api/database-automation").then(setData);
  }, [api]);

  if (!data) return <div className="card">Loading...</div>;

  return (
    <div className="card">
      <h2>Database and Automation</h2>
      <div className="stat-note">{data.note}</div>
      {data.tables?.length ? (
        data.tables.map((t: string) => (
          <div className="group-card" key={t}>
            <strong>{t}</strong>
            <div className="stat-note">{data.tableCounts?.[t] ?? 0} row(s)</div>
          </div>
        ))
      ) : (
        <div className="placeholder">No tables yet -- Dave creates them as it needs them.</div>
      )}
      <div className="stat-note">Active/waiting workflow runs: {data.activeWorkflowRuns ?? 0}</div>
    </div>
  );
}

// --- MCP Connections (11.3) ---
function McpPanel({ userId }: { userId: string }) {
  const api = useApi(userId);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api("/api/mcp-connections").then(setData);
  }, [api]);

  return (
    <div className="card">
      <h2>MCP Connections</h2>
      {data?.connections.map((c: any) => (
        <div className="group-card" key={c.name}>
          <strong>{c.name}</strong>
          <div className="stat-note">
            {c.kind} — {c.status}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Credentials: paste real Telegram/Green API/provider keys here ---
function CredentialsPanel({ userId }: { userId: string }) {
  const api = useApi(userId);

  return (
    <>
      <TelegramOtpCard userId={userId} api={api} />
      <GreenApiCard userId={userId} api={api} />
      <ProviderKeysCard userId={userId} api={api} title="AI Provider Keys" apiPath="/api/provider-keys" providerListPath="/api/providers" />
      <SimpleKeysCard userId={userId} api={api} title="E2B Keys" apiPath="/api/e2b-keys" />
      <SimpleKeysCard userId={userId} api={api} title="Firecrawl Keys" apiPath="/api/firecrawl-keys" />
    </>
  );
}

function TelegramOtpCard({ api }: { userId: string; api: ReturnType<typeof useApi> }) {
  const [status, setStatus] = useState<any>(null);
  const [form, setForm] = useState({ botToken: "", chatId: "" });
  const [otp, setOtp] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(() => {
    api("/api/telegram-otp").then(setStatus);
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  const start = async () => {
    setMessage(null);
    const res = await api("/api/telegram-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", botToken: form.botToken, chatId: form.chatId }) });
    if (res.error) {
      setMessage(res.error);
      return;
    }
    setOtp(res.otp);
    setMessage(`Paste this code into a message to @${res.botUsername} on Telegram, then click "Check status".`);
  };

  const check = async () => {
    setChecking(true);
    const res = await api("/api/telegram-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "check" }) });
    setChecking(false);
    if (res.confirmed) {
      setMessage("Paired! Your bot token and chat ID are now stored.");
      setOtp(null);
      reload();
    } else {
      setMessage(res.reason ?? "Not confirmed yet.");
    }
  };

  return (
    <div className="card">
      <h2>Telegram Pairing</h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`badge ${status?.paired ? "ok" : "warn"}`}>{status?.paired ? `Paired (chat ${status.chatId})` : "Not paired"}</span>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="text" placeholder="Bot token (from @BotFather)" value={form.botToken} onChange={(e) => setForm({ ...form, botToken: e.target.value })} style={{ width: 280 }} />
        <input type="text" placeholder="Chat ID" value={form.chatId} onChange={(e) => setForm({ ...form, chatId: e.target.value })} style={{ width: 140 }} />
        <button className="btn" onClick={start}>
          Start pairing
        </button>
      </div>
      {otp && (
        <div className="row" style={{ marginBottom: 10, alignItems: "center" }}>
          <span className="pill" style={{ fontSize: 20, letterSpacing: 2 }}>
            {otp}
          </span>
          <button className="btn secondary" onClick={check} disabled={checking}>
            {checking ? "Checking..." : "Check status"}
          </button>
        </div>
      )}
      {message && <div className="stat-note">{message}</div>}
    </div>
  );
}

function GreenApiCard({ api }: { userId: string; api: ReturnType<typeof useApi> }) {
  const [status, setStatus] = useState<any>(null);
  const [form, setForm] = useState({ idInstance: "", apiTokenInstance: "" });
  const [saved, setSaved] = useState(false);

  const reload = useCallback(() => {
    api("/api/greenapi-credentials").then(setStatus);
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async () => {
    await api("/api/greenapi-credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    setSaved(true);
    setForm({ idInstance: "", apiTokenInstance: "" });
    reload();
  };

  return (
    <div className="card">
      <h2>Green API (WhatsApp Calling)</h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`badge ${status?.configured ? "ok" : "warn"}`}>{status?.configured ? `Configured (${status.idInstance})` : "Not configured"}</span>
      </div>
      <div className="row">
        <input type="text" placeholder="idInstance" value={form.idInstance} onChange={(e) => setForm({ ...form, idInstance: e.target.value })} style={{ width: 160 }} />
        <input type="password" placeholder="apiTokenInstance" value={form.apiTokenInstance} onChange={(e) => setForm({ ...form, apiTokenInstance: e.target.value })} style={{ width: 280 }} />
        <button className="btn" onClick={save}>
          Save
        </button>
      </div>
      {saved && <div className="stat-note">Saved.</div>}
    </div>
  );
}

function ProviderKeysCard({ api, title, apiPath, providerListPath }: { userId: string; api: ReturnType<typeof useApi>; title: string; apiPath: string; providerListPath: string }) {
  const [keys, setKeys] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [form, setForm] = useState({ provider: "gemini", label: "", apiKey: "" });

  const reload = useCallback(() => {
    api(apiPath).then((r) => setKeys(r.keys ?? []));
  }, [api, apiPath]);

  useEffect(() => {
    reload();
    api(providerListPath).then((r) => setProviders(r.builtIn ?? []));
  }, [reload, api, providerListPath]);

  const add = async () => {
    await api(apiPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: form.provider, label: form.label, config: { apiKey: form.apiKey } }) });
    setForm({ ...form, label: "", apiKey: "" });
    reload();
  };

  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} style={{ width: 180 }}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <input type="text" placeholder="Label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={{ width: 140 }} />
        <input type="password" placeholder="API key" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} style={{ width: 280 }} />
        <button className="btn" onClick={add}>
          Add key
        </button>
      </div>
      {keys.length === 0 && <div className="placeholder">No keys stored yet.</div>}
      {keys.map((k: any) => (
        <div className="group-card" key={k.id}>
          <strong>{k.label}</strong> <span style={{ color: "var(--text-dim)" }}>({k.provider ?? ""})</span>
          <span className={`badge ${k.healthy ? "ok" : "warn"}`} style={{ marginLeft: 8 }}>
            {k.healthy ? "healthy" : "unchecked/unhealthy"}
          </span>
        </div>
      ))}
    </div>
  );
}

function SimpleKeysCard({ api, title, apiPath }: { userId: string; api: ReturnType<typeof useApi>; title: string; apiPath: string }) {
  const [keys, setKeys] = useState<any[]>([]);
  const [form, setForm] = useState({ label: "", apiKey: "" });

  const reload = useCallback(() => {
    api(apiPath).then((r) => setKeys(r.keys ?? []));
  }, [api, apiPath]);

  useEffect(() => {
    reload();
  }, [reload]);

  const add = async () => {
    await api(apiPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: form.label, apiKey: form.apiKey }) });
    setForm({ label: "", apiKey: "" });
    reload();
  };

  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="text" placeholder="Label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={{ width: 140 }} />
        <input type="password" placeholder="API key" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} style={{ width: 280 }} />
        <button className="btn" onClick={add}>
          Add key
        </button>
      </div>
      {keys.length === 0 && <div className="placeholder">No keys stored yet.</div>}
      {keys.map((k: any) => (
        <div className="group-card" key={k.id}>
          <strong>{k.label}</strong>
          <span className={`badge ${k.healthy ? "ok" : "warn"}`} style={{ marginLeft: 8 }}>
            {k.healthy ? "healthy" : "unchecked/unhealthy"}
          </span>
        </div>
      ))}
    </div>
  );
}

// --- Settings: real DAVEMA + sandbox status checks (14.1) ---
function SettingsPanel() {
  const [davema, setDavema] = useState<any>(null);
  const [sandbox, setSandbox] = useState<any>(null);

  useEffect(() => {
    fetch("/api/status/davema")
      .then((r) => r.json())
      .then(setDavema);
    fetch("/api/status/sandbox")
      .then((r) => r.json())
      .then(setSandbox);
  }, []);

  return (
    <div className="card">
      <h2>System Status</h2>
      <div className="row" style={{ gap: 24 }}>
        <div>
          DAVEMA:{" "}
          <span className={`badge ${davema ? (davema.reachable ? "ok" : "bad") : "warn"}`}>
            {davema ? (davema.reachable ? "reachable" : "unreachable") : "checking"}
          </span>
        </div>
        <div>
          Sandbox:{" "}
          <span className={`badge ${sandbox ? (sandbox.reachable ? "ok" : "warn") : "warn"}`}>
            {sandbox ? (sandbox.reachable ? "confined" : "degraded (unconfined)") : "checking"}
          </span>
        </div>
      </div>
      <div className="stat-note">Telegram, Green API, and AI provider credentials are set on the Credentials tab. This panel only reports connection health.</div>
    </div>
  );
}
