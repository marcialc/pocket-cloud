import { useCallback, useEffect, useMemo, useState } from "react";
import { ADMIN_STATS_DAYS, type AdminPlayer, type AdminStatsResponse, type DailyStats } from "../../shared/admin";
import { PLATFORMS, type PlatformId } from "../../shared/platforms";
import { formatWhen } from "../components/format";
import { ColumnChart, HBarChart } from "./charts";

type Days = (typeof ADMIN_STATS_DAYS)[number];

type Load =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "not_admin"; playerId: string }
  | { status: "error"; message: string }
  | { status: "ready"; data: AdminStatsResponse };

const ACCESS_EXPIRED = "Your Cloudflare Access session may have expired, or the network is down. Reload the page to sign in again.";

const number = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function platformName(id: string): string {
  // Game Boy and Game Boy Color saves are both known by header title, so they count together.
  if (id === "gb") return "Game Boy / Color";
  return PLATFORMS[id as PlatformId]?.name ?? id;
}

/** A save name without its platform prefix ("gba:BPRE" → "BPRE"). */
function gameName(gameId: string, platform: string): string {
  return platform !== "gb" && gameId.startsWith(`${platform}:`) ? gameId.slice(platform.length + 1) : gameId;
}

function plural(n: number, noun: string): string {
  return `${number.format(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function sum(daily: DailyStats[], key: keyof Omit<DailyStats, "day">): number {
  return daily.reduce((total, d) => total + d[key], 0);
}

export function AdminApp() {
  const [days, setDays] = useState<Days>(30);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async (range: Days) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/admin/stats?days=${range}`, { credentials: "same-origin" });
      if (res.status === 401) return setLoad({ status: "signed_out" });
      const body = (await res.json()) as AdminStatsResponse | { error: string; playerId?: string };
      if ("error" in body) {
        if (body.error === "not_admin" && body.playerId) return setLoad({ status: "not_admin", playerId: body.playerId });
        if (body.error === "sign_in_required") return setLoad({ status: "signed_out" });
        if (body.error === "access_required") return setLoad({ status: "error", message: ACCESS_EXPIRED });
        return setLoad({ status: "error", message: body.error });
      }
      setLoad({ status: "ready", data: body });
    } catch {
      // An expired Access session redirects the request to the Access login, which fetch can't follow.
      setLoad({ status: "error", message: ACCESS_EXPIRED });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchStats(days);
  }, [days, fetchStats]);

  return (
    <div className="admin">
      <header className="admin-header">
        <div>
          <h1>Pocket Cloud admin</h1>
          {load.status === "ready" && (
            <p className="muted">
              Updated {formatWhen(load.data.generatedAt)}
              {load.data.trackingSince !== null && <> · tracking since {new Date(load.data.trackingSince).toLocaleDateString()}</>}
            </p>
          )}
        </div>
        {load.status === "ready" && (
          <div className="admin-filters">
            <div className="segmented" role="radiogroup" aria-label="Date range">
              {ADMIN_STATS_DAYS.map((d) => (
                <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
                  {d} days
                </button>
              ))}
            </div>
            <button type="button" className="ghost" onClick={() => void fetchStats(days)} disabled={refreshing}>
              Refresh
            </button>
          </div>
        )}
      </header>

      {load.status === "loading" && <p className="muted">Loading…</p>}
      {load.status === "signed_out" && (
        <section className="card notice">
          <h2>Sign in first</h2>
          <p>
            The admin page uses your Pocket Cloud email sign-in. <a href="/">Open the app</a>, sign in, then come back to <code>/admin</code>.
          </p>
        </section>
      )}
      {load.status === "not_admin" && (
        <section className="card notice">
          <h2>Not an admin</h2>
          <p>This account's player id is:</p>
          <p>
            <code className="select-all">{load.playerId}</code>
          </p>
          <p>
            To make it an admin, add it to the <code>ADMIN_PLAYER_IDS</code> Worker secret (comma separated):
          </p>
          <pre>pnpm wrangler secret put ADMIN_PLAYER_IDS</pre>
        </section>
      )}
      {load.status === "error" && (
        <section className="card notice">
          <h2>Couldn't load the stats</h2>
          <p className="muted">{load.message}</p>
        </section>
      )}
      {load.status === "ready" && <Dashboard data={load.data} days={days} stale={refreshing} />}
    </div>
  );
}

function Dashboard({ data, days, stale }: { data: AdminStatsResponse; days: Days; stale: boolean }) {
  const { totals, daily } = data;
  return (
    <main className={stale ? "dashboard stale" : "dashboard"}>
      <section className="tiles" aria-label="Overview">
        <Tile label="Players" value={totals.players} sub={`${plural(totals.accounts, "account")} · ${number.format(totals.anonymous)} anonymous`} />
        <Tile label="Active today" value={totals.active1d} />
        <Tile label="Active, 7 days" value={totals.active7d} />
        <Tile label="Active, 30 days" value={totals.active30d} />
        <Tile label={`Sign-ups, ${days} days`} value={sum(daily, "signUps")} />
        <Tile label={`Saves synced, ${days} days`} value={sum(daily, "savesSynced")} />
      </section>

      <h2 className="section-title">Activity</h2>
      <section className="grid charts">
        <DailyCard title="Active players" daily={daily} field="activePlayers" total={false} />
        <DailyCard title="Sign-ups" daily={daily} field="signUps" />
        <DailyCard title="Sign-ins" daily={daily} field="signIns" />
        <DailyCard title="Saves synced" daily={daily} field="savesSynced" />
        <DailyCard title="ROM uploads" daily={daily} field="romUploads" />
        <DailyCard title="Link sessions started" daily={daily} field="linkPlugs" />
      </section>
      <details className="card table-view">
        <summary>Daily numbers as a table</summary>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Active</th>
                <th className="num">Sign-ups</th>
                <th className="num">Sign-ins</th>
                <th className="num">Saves</th>
                <th className="num">ROMs</th>
                <th className="num">Links</th>
              </tr>
            </thead>
            <tbody>
              {[...daily].reverse().map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td className="num">{number.format(d.activePlayers)}</td>
                  <td className="num">{number.format(d.signUps)}</td>
                  <td className="num">{number.format(d.signIns)}</td>
                  <td className="num">{number.format(d.savesSynced)}</td>
                  <td className="num">{number.format(d.romUploads)}</td>
                  <td className="num">{number.format(d.linkPlugs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <h2 className="section-title">Games &amp; platforms</h2>
      <section className="grid two">
        <div className="card">
          <h3>Players by platform</h3>
          <p className="muted small">Players who synced a save, all time</p>
          {data.platforms.length ? (
            <HBarChart rows={data.platforms.map((p) => ({ label: platformName(p.platform), value: p.players, detail: `${number.format(p.saves)} saves` }))} />
          ) : (
            <p className="muted">No saves synced yet.</p>
          )}
        </div>
        <div className="card">
          <h3>Top games</h3>
          <p className="muted small">By players who synced a save, all time</p>
          {data.games.length ? (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Game</th>
                    <th>Platform</th>
                    <th className="num">Players</th>
                    <th className="num">Saves</th>
                    <th>Last save</th>
                  </tr>
                </thead>
                <tbody>
                  {data.games.map((g) => (
                    <tr key={g.gameId}>
                      <td>{gameName(g.gameId, g.platform)}</td>
                      <td className="muted">{platformName(g.platform)}</td>
                      <td className="num">{number.format(g.players)}</td>
                      <td className="num">{number.format(g.saves)}</td>
                      <td className="muted">{formatWhen(g.lastSynced)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No saves synced yet.</p>
          )}
        </div>
      </section>

      <h2 className="section-title">Storage &amp; social</h2>
      <section className="tiles">
        <Tile label="ROMs in cloud libraries" value={data.storage.roms} sub={`${formatBytes(data.storage.romBytes)} · ${plural(data.storage.playersWithRoms, "player")}`} />
        <Tile label="Custom covers" value={data.storage.covers} sub={formatBytes(data.storage.coverBytes)} />
        <Tile label="Profiles" value={data.social.profiles} />
        <Tile label="Friendships" value={data.social.friendships} sub={`${plural(data.social.pendingRequests, "pending request")}`} />
        <Tile label="Leaderboard scores" value={data.social.scores} />
      </section>
      {data.storage.truncated && <p className="muted small">The bucket is large; storage totals stopped counting early and are a lower bound.</p>}

      <h2 className="section-title">Players</h2>
      <Players players={data.players} total={data.playerCount} />
    </main>
  );
}

function Tile({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="card tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value" title={number.format(value)}>
        {value >= 10_000 ? compact.format(value) : number.format(value)}
      </span>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

function DailyCard({
  title,
  daily,
  field,
  total = true,
}: {
  title: string;
  daily: DailyStats[];
  field: keyof Omit<DailyStats, "day">;
  /** Whether adding the days up means anything (it doesn't for distinct active players). */
  total?: boolean;
}) {
  const last = daily.at(-1)?.[field] ?? 0;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
        <span className="muted small">
          {total ? `${number.format(sum(daily, field))} total` : `${number.format(last)} today`}
        </span>
      </div>
      <ColumnChart label={title} points={daily.map((d) => ({ day: d.day, value: d[field] }))} />
    </div>
  );
}

const KIND_LABELS = { account: "Account", anonymous: "Anonymous" } as const;

function Players({ players, total }: { players: AdminPlayer[]; total: number }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? players.filter((p) => p.playerId.includes(q) || (p.name ?? "").toLowerCase().includes(q)) : players;
  }, [players, query]);
  return (
    <section className="card">
      <div className="card-head">
        <input
          type="search"
          className="search"
          placeholder="Search name or player id"
          aria-label="Search players"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted small">
          {shown.length === players.length ? `${number.format(players.length)}` : `${number.format(shown.length)} of ${number.format(players.length)}`}
          {total > players.length && ` (most recent of ${number.format(total)})`} players
        </span>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Type</th>
              <th>Last seen</th>
              <th>First seen</th>
              <th className="num">Saves synced</th>
              <th className="num">Cloud ROMs</th>
              <th className="num">Links</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.playerId}>
                <td>
                  <span className="player-name">{p.name ?? <span className="muted">No profile</span>}</span>
                  <code className="player-id" title={p.playerId}>
                    {p.playerId.slice(0, 12)}
                  </code>
                </td>
                <td>{p.kind ? <span className={`badge ${p.kind}`}>{KIND_LABELS[p.kind]}</span> : <span className="muted">—</span>}</td>
                <td className="muted">{p.lastSeen ? formatWhen(p.lastSeen) : "—"}</td>
                <td className="muted">{p.firstSeen ? new Date(p.firstSeen).toLocaleDateString() : "—"}</td>
                <td className="num">{number.format(p.savesSynced)}</td>
                <td className="num">{p.roms ? `${p.roms} · ${formatBytes(p.romBytes)}` : "0"}</td>
                <td className="num">{number.format(p.linkPlugs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Saves synced and links count from when tracking began; last seen updates about once a day. Emails are never stored, so players
        are known by id and display name.
      </p>
    </section>
  );
}
