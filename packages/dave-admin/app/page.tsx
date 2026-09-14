"use client";

import { useCallback, useEffect, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend, ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid } from "recharts";

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
    <>
      <BalanceCard userId={userId} api={api} />
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
      <ActivityHeatmap userId={userId} api={api} />
      <div className="row" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <PairGroupPie userId={userId} api={api} />
        </div>
        <div style={{ flex: "2 1 480px" }}>
          <OutcomeRangeChart userId={userId} api={api} />
        </div>
      </div>
    </>
  );
}

// --- J6: real-time balance card, large, top of dashboard ---
function BalanceCard({ api }: { userId: string; api: ReturnType<typeof useApi> }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api("/api/analytics").then((r) => !cancelled && setData(r.balance));
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api]);

  if (!data) return <div className="card placeholder">Loading balance...</div>;

  return (
    <div className="card balance-card">
      {data.value !== null ? (
        <>
          <div className="balance-value">
            ${data.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="balance-sub">
            Equity ${data.equity?.toLocaleString(undefined, { minimumFractionDigits: 2 })} &middot; updated {new Date(data.updatedAt).toLocaleTimeString()}
          </div>
        </>
      ) : (
        <>
          <div className="balance-value dim">--</div>
          <div className="balance-sub">{data.note}</div>
        </>
      )}
    </div>
  );
}

// --- J7: GitHub-contribution-style activity heatmap, real daily P&L, last ~6 months ---
function ActivityHeatmap({ api }: { userId: string; api: ReturnType<typeof useApi> }) {
  const [days, setDays] = useState<{ day: string; pnl: number }[] | null>(null);

  useEffect(() => {
    api("/api/analytics").then((r) => setDays(r.heatmap));
  }, [api]);

  if (!days) return <div className="card placeholder">Loading activity...</div>;

  const byDay = new Map(days.map((d) => [d.day, d.pnl]));
  const today = new Date();
  const WEEKS = 26;
  const cells: { date: Date; pnl: number | undefined }[] = [];
  const start = new Date(today);
  start.setDate(start.getDate() - WEEKS * 7);
  start.setDate(start.getDate() - start.getDay()); // align to a Sunday
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    cells.push({ date: d, pnl: byDay.get(key) });
  }
  const maxAbs = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  const colorFor = (pnl: number | undefined) => {
    if (pnl === undefined) return "rgba(255,255,255,0.05)";
    const intensity = Math.min(1, Math.abs(pnl) / maxAbs);
    return pnl >= 0 ? `rgba(74, 222, 128, ${0.15 + intensity * 0.7})` : `rgba(248, 113, 113, ${0.15 + intensity * 0.7})`;
  };
  const weeks: typeof cells[] = [];
  for (let w = 0; w < WEEKS; w++) weeks.push(cells.slice(w * 7, w * 7 + 7));

  return (
    <div className="card">
      <h2>Activity Heatmap</h2>
      <div className="heatmap-scroll">
        <div className="heatmap-grid">
          {weeks.map((week, wi) => (
            <div className="heatmap-col" key={wi}>
              {week.map((cell, di) => (
                <div
                  key={di}
                  className="heatmap-cell"
                  title={`${cell.date.toISOString().slice(0, 10)}: ${cell.pnl !== undefined ? `$${cell.pnl.toFixed(2)}` : "no closed trades"}`}
                  style={{ background: colorFor(cell.pnl) }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="stat-note">{days.length === 0 ? "No closed trades yet -- squares fill in as real trades close." : `${days.length} real day(s) with closed trades, last ${WEEKS} weeks.`}</div>
    </div>
  );
}

// --- J8: real trade distribution by pair group ---
const PIE_COLORS = ["#6ea8fe", "#9b8cff", "#4ade80", "#f87171", "#fbbf24", "#38bdf8", "#f472b6"];
function PairGroupPie({ api }: { userId: string; api: ReturnType<typeof useApi> }) {
  const [groups, setGroups] = useState<{ label: string; count: number }[] | null>(null);

  useEffect(() => {
    api("/api/analytics").then((r) => setGroups(r.pairGroups));
  }, [api]);

  if (!groups) return <div className="card placeholder">Loading distribution...</div>;

  return (
    <div className="card" style={{ height: 320 }}>
      <h2>Trades by Pair Group</h2>
      {groups.length === 0 ? (
        <div className="placeholder">No journaled trades yet.</div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={groups} dataKey="count" nameKey="label" cx="50%" cy="50%" outerRadius={80} label={(d: any) => d.label}>
              {groups.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ background: "#131a2b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// --- J9: range/band chart -- spread of real trade outcomes per day, distinct from the heatmap's summed daily total ---
function OutcomeRangeChart({ api }: { userId: string; api: ReturnType<typeof useApi> }) {
  const [range, setRange] = useState<{ day: string; min: number; max: number; avg: number }[] | null>(null);

  useEffect(() => {
    api("/api/analytics").then((r) => setRange(r.range));
  }, [api]);

  if (!range) return <div className="card placeholder">Loading outcome range...</div>;

  const data = range.map((r) => ({ ...r, band: [r.min, r.max] }));

  return (
    <div className="card" style={{ height: 320 }}>
      <h2>Trade Outcome Range</h2>
      {range.length === 0 ? (
        <div className="placeholder">No closed trades yet -- the spread of daily outcomes will show up here.</div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
            <XAxis dataKey="day" stroke="#8a93a8" fontSize={11} />
            <YAxis stroke="#8a93a8" fontSize={11} />
            <Tooltip contentStyle={{ background: "#131a2b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
            <Area dataKey="band" stroke="none" fill="rgba(110,168,254,0.25)" />
            <Line dataKey="avg" stroke="#9b8cff" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <div className="stat-note">Shaded band = min-to-max outcome that day; line = average. Distinct from the heatmap's summed daily total.</div>
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
  const [primary, setPrimary] = useState("openai");

  const reload = useCallback(() => {
    api("/api/model-config").then((c) => {
      setConfig(c);
      setPrimary(c.primary);
    });
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async () => {
    const fallback = ["deepseek", "claude"].filter((p) => p !== primary);
    await api("/api/model-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ primary, fallback }) });
    reload();
  };

  return (
    <div className="card">
      <h2>AI Model Picker</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <span>Primary:</span>
        <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
          <option value="openai">OpenAI</option>
          <option value="deepseek">DeepSeek</option>
          <option value="claude">Claude</option>
        </select>
        <button className="btn secondary" onClick={save}>
          Save
        </button>
      </div>
      {config && <div className="stat-note">fallback order: {config.fallback.join(" then ")}</div>}
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

// --- Credentials: paste real Telegram/provider keys here ---
function CredentialsPanel({ userId }: { userId: string }) {
  const api = useApi(userId);

  return (
    <>
      <TelegramOtpCard userId={userId} api={api} />
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

function ProviderKeysCard({ api, title, apiPath, providerListPath }: { userId: string; api: ReturnType<typeof useApi>; title: string; apiPath: string; providerListPath: string }) {
  const [keys, setKeys] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [form, setForm] = useState({ provider: "gemini", label: "", apiKey: "", extraConfigJson: "" });
  const [extraConfigError, setExtraConfigError] = useState("");
  const [bulk, setBulk] = useState({ provider: "gemini", labelPrefix: "", rawKeys: "" });
  const [bulkResults, setBulkResults] = useState<any[] | null>(null);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [modelsByKey, setModelsByKey] = useState<Record<string, any>>({});

  const reload = useCallback(() => {
    api(apiPath).then((r) => setKeys(r.keys ?? []));
  }, [api, apiPath]);

  useEffect(() => {
    reload();
    api(providerListPath).then((r) => setProviders(r.builtIn ?? []));
  }, [reload, api, providerListPath]);

  const add = async () => {
    // Real fix: some providers need more than apiKey -- Cloudflare (accountId), Bedrock
    // (region + secretAccessKey), Azure (accountId = resource name, model = deployment name).
    // There was previously NO way to enter any of these through this form at all, making those
    // providers unusable outside a raw API call. This optional JSON field merges into config.
    let extraConfig: Record<string, unknown> = {};
    if (form.extraConfigJson.trim()) {
      try {
        extraConfig = JSON.parse(form.extraConfigJson);
      } catch {
        setExtraConfigError("Advanced config must be valid JSON, e.g. {\"accountId\": \"...\"}");
        return;
      }
    }
    setExtraConfigError("");
    await api(apiPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: form.provider, label: form.label, config: { apiKey: form.apiKey, ...extraConfig } }) });
    setForm({ ...form, label: "", apiKey: "", extraConfigJson: "" });
    reload();
  };

  const bulkAdd = async () => {
    const res = await api(apiPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bulkAdd: true, provider: bulk.provider, labelPrefix: bulk.labelPrefix || bulk.provider, rawKeys: bulk.rawKeys }),
    });
    setBulkResults(res.results ?? []);
    setBulk({ ...bulk, rawKeys: "" });
    reload();
  };

  const checkHealth = async (k: any) => {
    setBusyKeyId(k.id);
    await api(apiPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkHealth: true, provider: k.provider, checkKeyId: k.id }) });
    setBusyKeyId(null);
    reload();
  };

  const setPrimary = async (k: any) => {
    await api(apiPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setPrimary: true, keyIdToMakePrimary: k.id }) });
    reload();
  };

  const remove = async (k: any) => {
    await api(`${apiPath}?keyId=${encodeURIComponent(k.id)}`, { method: "DELETE" });
    reload();
  };

  const fetchModels = async (k: any) => {
    setBusyKeyId(k.id);
    const res = await api(apiPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fetchModels: true, provider: k.provider, fetchModelsKeyId: k.id }) });
    setBusyKeyId(null);
    setModelsByKey({ ...modelsByKey, [k.id]: res });
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
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          type="text"
          placeholder={'Advanced config JSON (Cloudflare/Azure: {"accountId":"..."}; Bedrock: {"region":"...","secretAccessKey":"..."}; Azure also needs {"model":"<deployment name>"})'}
          value={form.extraConfigJson}
          onChange={(e) => setForm({ ...form, extraConfigJson: e.target.value })}
          style={{ width: 620 }}
        />
      </div>
      {extraConfigError && <div style={{ color: "var(--danger, #c0392b)", marginBottom: 10 }}>{extraConfigError}</div>}

      <details style={{ marginBottom: 10 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-dim)" }}>Bulk-add (paste up to 10 keys, one per line)</summary>
        <div className="row" style={{ marginTop: 8, alignItems: "flex-start" }}>
          <select value={bulk.provider} onChange={(e) => setBulk({ ...bulk, provider: e.target.value })} style={{ width: 180 }}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          <input type="text" placeholder="Label prefix" value={bulk.labelPrefix} onChange={(e) => setBulk({ ...bulk, labelPrefix: e.target.value })} style={{ width: 140 }} />
          <textarea
            placeholder={"One API key per line\n(up to 10)"}
            value={bulk.rawKeys}
            onChange={(e) => setBulk({ ...bulk, rawKeys: e.target.value })}
            style={{ width: 280, height: 80 }}
          />
          <button className="btn" onClick={bulkAdd}>
            Bulk-add
          </button>
        </div>
        {bulkResults && (
          <div style={{ marginTop: 8 }}>
            {bulkResults.map((r, i) => (
              <div key={i} className={`badge ${r.ok ? "ok" : "warn"}`} style={{ marginRight: 6, marginBottom: 4, display: "inline-block" }}>
                {r.ok ? `OK: ${r.key?.label}` : `FAILED: ${r.error}`}
              </div>
            ))}
          </div>
        )}
      </details>

      {keys.length === 0 && <div className="placeholder">No keys stored yet.</div>}
      {keys.map((k: any) => (
        <div className="group-card" key={k.id}>
          <strong>{k.label}</strong> <span style={{ color: "var(--text-dim)" }}>({k.provider ?? ""})</span>
          {k.isPrimary && (
            <span className="badge ok" style={{ marginLeft: 8 }}>
              main
            </span>
          )}
          <span className={`badge ${k.healthy ? "ok" : "warn"}`} style={{ marginLeft: 8 }}>
            {k.healthy ? "healthy" : "unchecked/unhealthy"}
          </span>
          {k.lastError && <span style={{ marginLeft: 8, color: "var(--warn)", fontSize: 12 }}>{k.lastError}</span>}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn" disabled={busyKeyId === k.id} onClick={() => checkHealth(k)}>
              Check health
            </button>
            {!k.isPrimary && (
              <button className="btn" onClick={() => setPrimary(k)}>
                Set as main
              </button>
            )}
            <button className="btn" disabled={busyKeyId === k.id} onClick={() => fetchModels(k)}>
              Fetch models
            </button>
            <button className="btn" onClick={() => remove(k)}>
              Remove
            </button>
          </div>
          {modelsByKey[k.id] && (
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-dim)" }}>
              {modelsByKey[k.id].manualEntryRequired
                ? "This provider requires manual model-ID entry (no auto-fetch)."
                : modelsByKey[k.id].error
                  ? `Fetch failed: ${modelsByKey[k.id].error}`
                  : `Models: ${modelsByKey[k.id].models?.join(", ") || "(none returned)"}`}
            </div>
          )}
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

// --- Settings: real EA + sandbox status checks (14.1; item 5: DAVEMA retirement -- the EA
// connection is the real market-data dependency now, not the retired external DAVEMA API) ---
function SettingsPanel() {
  const [ea, setEa] = useState<any>(null);
  const [sandbox, setSandbox] = useState<any>(null);

  useEffect(() => {
    fetch("/api/status/ea")
      .then((r) => r.json())
      .then(setEa);
    fetch("/api/status/sandbox")
      .then((r) => r.json())
      .then(setSandbox);
  }, []);

  return (
    <div className="card">
      <h2>System Status</h2>
      <div className="row" style={{ gap: 24 }}>
        <div>
          MT5/EA bridge:{" "}
          <span className={`badge ${ea ? (ea.connected ? "ok" : "bad") : "warn"}`}>
            {ea ? (ea.connected ? "connected" : ea.lastSeenAt === null ? "never connected" : "disconnected") : "checking"}
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
