---
title: Configuration reference
order: 29
section: Deployment
---

# Configuration reference

Most settings can be supplied as a **command-line flag** or an **environment variable**;
a few are environment-variable only (shown with `—` in the **Flag** column below).
When a setting supports both and both are present, the **environment variable wins** —
handy for baking defaults into a service definition while still overriding per run.

## Options

| Flag | Environment variable | Default | Description |
|---|---|---|---|
| `--port <port>` | `HEZO_PORT` | `3100` | Port the server and web app listen on (1–65535). |
| `--data-dir <path>` | `HEZO_DATA_DIR` | `~/.hezo/` | Where Hezo stores its database, encrypted secrets, and assets. |
| `--master-key <phrase>` | `HEZO_MASTER_KEY` | — | The twelve-word master key, to set up or unlock without the web gate. |
| `--web-url <url>` | `HEZO_WEB_URL` | same origin | Public base URL, used so account sign-ins redirect back correctly. |
| `--reset` | `HEZO_RESET` | off | Start fresh with an empty database (the existing `pgdata` is renamed aside, not deleted). |
| `--no-open` | `HEZO_OPEN` | on | Auto-open the web app in your browser on startup. On by default; automatically skipped in environments without a browser (CI, containers, SSH, headless Linux). Pass `--no-open` or set `HEZO_OPEN=0` to disable. |
| `--log-level <level>` | `HEZO_LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, or `error`. |
| `--keep-old-containers` | `HEZO_KEEP_OLD_CONTAINERS` | off | Keep old project containers instead of removing them — for debugging a crashed container. |
| `--container-bind-host <host>` | `HEZO_CONTAINER_BIND_HOST` | `127.0.0.1` | Interface the egress proxy and SSH bridge bind to so agent containers can reach them. The default suits Docker Desktop; on native-Linux Docker set `0.0.0.0` (or the bridge gateway IP) so containers can reach them via `host.docker.internal`, and firewall-restrict the range to the docker bridge. See [Self-hosting → Networking & firewall](/docs/deployment/self-hosting). |
| `--version` | — | — | Print the Hezo version and exit (also `hezo version`). |
| — | `HEZO_DISABLE_AUTO_UPDATE` | off | Disable the in-app auto-update (release check, the background download, and the "Install & restart" banner). When disabled the banner instead links to the GitHub release page. |
| — | `HEZO_UPDATE_CHECK_CRON` | `0 0 4 * * *` | Cron schedule (seconds-precision) for the daily check that downloads and stages a newer release. A running instance also stages as soon as it detects an update, so the banner's "Install & restart" is instant. |

## Examples

Run on a custom port with a dedicated data directory:

```sh
hezo --port 8080 --data-dir /var/lib/hezo
```

Bring an instance up unattended (for example under a service manager), unlocking it via
the environment:

```sh
HEZO_MASTER_KEY="your twelve word master key phrase here" \
HEZO_DATA_DIR=/var/lib/hezo \
HEZO_WEB_URL=https://hezo.example.com \
  hezo
```

## See also

- [CLI reference](/docs/reference/cli) — commands and usage.
- [Backup & recovery](/docs/deployment/backup-and-recovery) — `--reset` and restoring.
- [First-run setup](/docs/getting-started/first-run) — the master key.
