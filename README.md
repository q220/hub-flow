# Hub Player Flow (hub-flow)

Formerly the offline player visualizer. On MCME it is the admin dashboard's **Players → New players** page: the dashboard serves it under `/hub-flow/` behind its own sign-in, and reads its signals for alerts.

A web tool for finding problems in how new players get through the MCME hub: where they stop in the intro, whether their resource pack loads, whether they reach another server and come back. A second tab shows the hub world as a block map with logged-off players as a heatmap.

## Flow page

The default view (`#flow`). It refreshes its data every 15 minutes.

- **Signals** - What changed in the last 14 days against the 8 weeks before: intro completion, players stopping at the welcome screen or the compatibility check, resource pack failures and declines, pack releases that fail for many of the window's new players, game versions other than the server's that finish the intro far less often, players who finished but did not reach another server, fewer players coming back, fewer new players, and how often stuck players retried. Plus the fast check below: a game version whose pack failed for new players in the last 24 hours (`pack-24h:<version>`), a new release that fails for a game version (`release:…`), and first results of new releases, one note per pack version (`release-new:<pack>:<version>`, not alerted). Critical signals reach staff through the admin dashboard's alerts (dashboard ADR-047)
- **Resource packs in the last 24 hours** - New players by game version: pack loaded, failed, declined, finished the intro, and which releases they got; whatever range is selected. A game version is failing when at least 8 of its players tried the pack and 60% or more of them failed. Below it, releases first seen in the last 7 days, by game version, for every player whose latest pack they are
- **Before and after each event** - For every marker in `events.json`: new players a day, finished the intro, pack failed, reached another server and came back within 7 days, in the 7 days before against the 7 days after
- **Range** - 2, 4, 12 or 26 weeks, or everything since the hub opened, compared with the period before
- **Key numbers** - New players, finished the intro, stopped at each room, pack failed to load, came back within 7 days, each with its change and a trend line
- **Funnel** - Joined the hub, finished the intro, reached another server; came back within 7 days
- **Charts** - Intro outcome and pack failures per day or week, with dated events marked; each has a table view
- **Tables** - Intro outcome by game version and by pack result, tries before leaving, packs new players got, and failure rates of every pack release
- **New players** - Newest first, filterable by outcome, with their pack, pack result, hub visits and whether they moved on; "Map" flies to them on the map

### Data sources

| Source | Gives | Location (override) |
|---|---|---|
| Player files | First join, last online, position, name | `players/data/` or `playerdata/` in the world |
| MCME-Introduction | Who finished (`finishedPlayerList.uid`); room boxes (`locations.yml`) | `plugins/MCME-Introduction` next to the world (`INTRO_DIR`) |
| MCME-Architect database | Each player's latest resource pack and its load result (`architect_rp`) | Credentials from `plugins/MCME-Architect/config.yml` (`ARCHITECT_DB_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_NAME`) |
| Plan database | Each player's latest game version (`plan_version_protocol`, from Plan's ViaVersion integration) | Credentials from `plugins/Plan/config.yml` (`PLAN_DB_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_NAME`) |
| Hub server logs | Hub visits per player | `logs/` next to the world (`HUB_LOG_DIR`) |
| Velocity proxy logs | Network connections and server moves (by name) | `logs/` of the proxy two folders up (`PROXY_LOG_DIR`; hub's proxy name `HUB_SERVER_NAME`, default `hub`) |
| `events.json` | Dated changes drawn on the charts (`{"date": "YYYY-MM-DD", "label": "..."}`) | Working directory (`FLOW_EVENTS_FILE`) |

Log events are cached per rolled log file under `.cache/`. Servers delete logs after about three months, so what the logs say about each new player (hub visits, first visit length, reaching another server, coming back within 7 days) is also kept in `data/<world>-<hash>/flow-history.json`, frozen 8 days after the first join. `data/<world>-<hash>/pack-releases.json` notes when each resource pack release first appeared in Architect's table, which only keeps each player's latest pack without a time; releases already there on the first run have no date. Unlike `.cache/`, `data/` cannot be rebuilt: back it up. Players who joined before the first run with logs still covering them stay unknown; the page says so where it matters.

## Map features

- **Block map rendering** - Top-down view of the world using 300+ Minecraft block colors
- **Player heatmap** - Density overlay with log-scale normalization and gaussian blur
- **Player search** - Search by name or UUID, fly to their location on the map
- **Dimension switching** - Toggle between Overworld, Nether, and End
- **Date filtering** - Filter players by last login date, re-render heatmap on the fly
- **Player dots** - Individual player markers appear when zoomed in
- **Where players gave up after the intro** - A heatmap of the last hub position of new players (since a date) who finished the intro but never reached another server
- **Incremental indexing** - After the first run only player files saved since the last start are parsed again
- **World formats** - Reads both the 26.1+ layout (`dimensions/`, `players/data/`) and the older one (`region/`, `DIM-1/`, `playerdata/`)

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later

## Setup

```bash
# Clone the repo
git clone https://github.com/q220/hub-flow.git
cd hub-flow

# Install dependencies
npm install

# Build the client
npx vite build
```

## Usage

Point the server at your Minecraft world folder:

```bash
npx tsx src/server/index.ts /path/to/your/minecraft/world
```

Then open http://localhost:3000 in your browser.

### Running it as a service

On MCME it runs as the systemd user service `hub-flow`, from the production build, on `127.0.0.1:9191`, at low CPU and disk priority. The admin dashboard serves it under `/hub-flow/` and lets only signed-in staff with its `hubflow.view` permission through, so the tool itself has no sign-in and must never listen on a public address.

```bash
scripts/deploy.sh --build-only                      # first time: install and build
scripts/install-service.sh /path/to/world [port]    # write and enable hub-flow.service
systemctl --user start hub-flow
scripts/deploy.sh                                   # later: pull, build, restart, wait until it answers
journalctl --user -u hub-flow -f                    # its output
```

Keep the world path the same when you move the tool or change how it runs: the folders in `.cache/` and `data/` are named after it. `start.sh` only restarts the service. The page loads nothing from other hosts (Leaflet is bundled), so it works under the dashboard's Content-Security-Policy: keep it that way. Opened inside the dashboard (`?embed`), it leaves out its own title.

### What happens at startup

1. Scans the world structure (dimensions, MC version and spawn from `level.dat`)
2. Indexes players from `players/data/*.dat` (or `playerdata/`), reusing cached records for files whose mtime has not changed
3. Takes names from each file's `bukkit.lastKnownName`, falling back to `usercache.json` (which only keeps the last 1000 players)
4. Computes map bounds by flood-filling region files from spawn
5. Renders a heatmap per dimension for players online in the last 30 days
6. Starts the web server, then pre-renders a 512x512 tile per region in the background

Caches live in `.cache/<world>-<hash>/` (`players.json`, `tiles/`), one folder per world path. A tile is re-rendered when its region file is newer than the cached PNG. Nothing is written into the world folder.

"Last online" comes from `bukkit.lastPlayed` (or `Paper.LastSeen`), not the file mtime: on MCME about 330,000 player files share the mtime of a bulk copy on 2026-03-11.

### Development mode

```bash
npm run dev
```

This runs the server (with hot reload via tsx) and the Vite dev server concurrently. The Vite dev server proxies API requests to the backend.

### Configuration

- **Port**: Set the `PORT` environment variable (default: `3000`)
- **Host**: Set the `HOST` environment variable (default: `127.0.0.1`; use `0.0.0.0` to listen on all interfaces)
- **Refresh**: `REFRESH_MINUTES` (default `15`; `0` turns it off)
- **Tile pre-rendering**: `PRERENDER_TILES=0` skips it (tiles still render on demand)
- **World bounds**: Computed from the region files connected to spawn, capped at 10000x10000 blocks

## API

| Endpoint | Description |
|---|---|
| `GET /api/world-info` | World name, MC version, dimensions, player count, bounds |
| `GET /api/players?dimension=&after=&before=&limit=&offset=` | Paginated player list |
| `GET /api/players/search?q=<name>&limit=20` | Search players by name or UUID |
| `GET /api/players/:uuid` | Single player details |
| `GET /api/players/clusters?dimension=&zoom=&minX=&maxX=&minZ=&maxZ=&after=&before=` | Players or clusters in a viewport |
| `GET /api/tiles/{dimension}/{tx}/{ty}.png` | Block map tile for one region |
| `POST /api/heatmap/render` | Render a heatmap with date filters, viewport or area |
| `POST /api/heatmap/dropout` | Render the dropout heatmap (single-session players since `cutoffDate`) |
| `GET /api/heatmaps/{id}/heatmap.png`, `/api/heatmaps/{id}/contours.json` | A rendered heatmap (the last 50 are kept in memory) |
| `GET /api/flow?from=&to=` | Flow totals, series, breakdowns, pack health, the last 24 hours and new releases, each marker's before and after, and the current signals |
| `GET /api/flow/players?from=&to=&outcome=&limit=&offset=` | New players in a range, newest first |

## Tech Stack

- **Backend**: Fastify, TypeScript, sharp, prismarine-nbt (region files are read directly), mysql2
- **Frontend**: Leaflet.js (CRS.Simple), Vite, vanilla TypeScript
