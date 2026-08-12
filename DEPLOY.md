# Deploying AgentMS to the droplet

Target: DigitalOcean droplet `168.144.26.72` (Ubuntu 22.04), which **already runs the
EV Research Streamlit + FastAPI apps**. This deploy is **fully isolated** and makes **no
nginx changes**, so the existing apps are untouched.

## Approach (and why)

There is **no domain** and **port 80/443 are already taken** by the EV app's nginx, so
Let's Encrypt / subdomain routing isn't possible yet. Instead AgentMS runs on its **own
dedicated port with self-signed HTTPS**:

| Concern | Choice |
| --- | --- |
| Port | **8444** (free; 22/80/443/3000/8000/8443/8501/8787 are in use) |
| TLS | App's **self-signed** HTTPS (browser shows a one-time "not trusted" warning) |
| Runtime | Node 22 already on the droplet — no install |
| Database | Fresh **PostgreSQL** (none present), localhost-only, dedicated `agentms` DB + role |
| Process | systemd service `agentms`, dedicated `agentms` user, `Restart=always` |
| Reverse proxy | **None** — nginx is not touched |
| Firewall | `ufw allow 8444/tcp` only |

Resulting URL: **https://168.144.26.72:8444/login**

## Run it (from this Windows machine)

```bash
KEY=/c/Users/Admin/.ssh/ev_research_do
scp -i "$KEY" deploy/remote-setup.sh root@168.144.26.72:/root/remote-setup.sh
ssh -i "$KEY" root@168.144.26.72 'APP_PORT=8444 bash /root/remote-setup.sh'
```

The script is **idempotent** — re-running pulls the latest code, keeps the existing DB and
secrets, and restarts the service. It seeds demo data **once** (guarded by
`/opt/agentms/.seeded`) so re-runs never wipe data.

Generated admin/demo passwords are written to `/opt/agentms/CREDENTIALS.txt` (root-only) —
no secrets live in the repo or the `.env` that's committed.

## ⚠ DigitalOcean cloud firewall

`ufw` opens 8444 on the host, but if a **DO cloud firewall** is attached to the droplet,
you must also add an inbound **TCP 8444** rule in the DigitalOcean control panel — the host
firewall alone won't let external traffic in. (SSH connectivity is unaffected.)

## Verify

```bash
# on the droplet
systemctl status agentms
curl -k https://localhost:8444/login -o /dev/null -w '%{http_code}\n'   # expect 200
# from anywhere
curl -k https://168.144.26.72:8444/login -o /dev/null -w '%{http_code}\n'
# confirm the EV app is unaffected
curl -I http://168.144.26.72                                            # still the EV app
```

Then open <https://168.144.26.72:8444/login>, accept the self-signed warning, and sign in
with the credentials from `/opt/agentms/CREDENTIALS.txt`.

## Update a running deployment

Just re-run the same command — or on the droplet:

```bash
sudo -u agentms git -C /opt/agentms/app pull --ff-only
sudo -u agentms bash -lc 'cd /opt/agentms/app && npm ci --omit=dev && node scripts/migrate.js'
systemctl restart agentms
```

### Migrations are additive — keep them that way

`db/schema.sql` opens with a `DROP TABLE` block that destroys every table. It is
fenced between `-- @fresh-only:start` / `-- @fresh-only:end` markers and
`scripts/migrate.js` **strips it unless you pass `--fresh`**, so the command
above adds new tables/columns and leaves live data alone. Columns added after a
database was first created are applied by the catch-up `ALTER ... ADD COLUMN IF
NOT EXISTS` block at the foot of `schema.sql` — put new ones there.

- **Never** run `migrate.js --fresh` (or `npm run reset` / `npm run setup`, which
  both imply it) against the droplet — it drops the lot.
- `seed.js` TRUNCATEs everything and now refuses to run against a database that
  already has agents or users unless given `--force`.

This bit twice before the guards existed: agencies created through the admin
portal on 11 Aug were destroyed by later schema deploys, which looked like
"new agencies don't show up in the officer view".

## Rollback / remove (AgentMS only — never touches the EV app)

```bash
systemctl disable --now agentms
rm -f /etc/systemd/system/agentms.service && systemctl daemon-reload
ufw delete allow 8444/tcp
# optional, destroys AgentMS data only:
sudo -u postgres dropdb agentms && sudo -u postgres dropuser agentms
rm -rf /opt/agentms
```

## Notes / risks

- **Memory:** the droplet has ~1.9 GB RAM with the EV stack already running. Adding
  PostgreSQL + Node is expected to fit (~1 GB was available at inspection) but is worth
  watching with `free -h` after deploy.
- **Self-signed cert:** fine for a demo/internal tool; to remove the browser warning later
  you'd point a domain at the droplet and front AgentMS with nginx + Let's Encrypt (that
  step *would* touch nginx, so it'd be done as a deliberate, separate change with the
  existing config preserved).
