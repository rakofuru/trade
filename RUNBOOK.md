# Hyperliquid Bot Runbook (VPS / Ops)

This runbook covers deployment and operations only. Trading logic is out of scope.

## 0. Rules
- SSH user is `trader` only (key-based auth). No root SSH login.
- Keep `.env.local` only on VPS. Never commit it.
- `deploy.sh` runs as `trader`; it uses `sudo` only for `systemctl` and `journalctl`.
- Hard risk stops are immutable. Do not change Daily/Weekly/MDD/Risk-per-trade/Exposure hard limits in ops work.
- Invariant A/B are priority-1: unprotected position and flip-order violations are never acceptable.

## 1. VPS bootstrap (Ubuntu)

### 1-1. One-time setup (as `trader`)
```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates gnupg lsb-release sudo
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo useradd --system --create-home --shell /bin/bash hlauto || true
sudo mkdir -p /opt/hlauto
sudo chown -R trader:trader /opt/hlauto
git clone <YOUR_GITHUB_REPO_URL> /opt/hlauto/trade
sudo mkdir -p /opt/hlauto/trade/data/{streams,rollups,state,reports}
sudo chown -R hlauto:hlauto /opt/hlauto/trade/data
chmod +x /opt/hlauto/trade/ops/scripts/deploy.sh /opt/hlauto/trade/ops/scripts/vps_bootstrap.sh
```

### 1-2. sudoers for deploy (required)
Create `/etc/sudoers.d/hlauto-deploy`:
```bash
echo 'trader ALL=(root) NOPASSWD: /bin/systemctl, /bin/journalctl' | sudo tee /etc/sudoers.d/hlauto-deploy
sudo chmod 440 /etc/sudoers.d/hlauto-deploy
sudo visudo -cf /etc/sudoers.d/hlauto-deploy
```

## 2. systemd install
```bash
sudo cp /opt/hlauto/trade/ops/systemd/hlauto.service /etc/systemd/system/hlauto.service
sudo cp /opt/hlauto/trade/ops/systemd/hlauto-daily-summary.service /etc/systemd/system/hlauto-daily-summary.service
sudo cp /opt/hlauto/trade/ops/systemd/hlauto-daily-summary.timer /etc/systemd/system/hlauto-daily-summary.timer
sudo systemctl daemon-reload
sudo systemctl enable hlauto
sudo systemctl enable --now hlauto-daily-summary.timer
```

Create VPS env file:
```bash
cp /opt/hlauto/trade/.env.local.example /opt/hlauto/trade/.env.local
nano /opt/hlauto/trade/.env.local
```

First deploy:
```bash
cd /opt/hlauto/trade
HLAUTO_APP_DIR=/opt/hlauto/trade HLAUTO_APP_USER=trader HLAUTO_SERVICE_NAME=hlauto bash ops/scripts/deploy.sh main
```

## 3. GitHub Actions secrets
Create these repository secrets:
- `VPS_HOST`
- `VPS_PORT`
- `VPS_USER` = `trader`
- `VPS_SSH_KEY` (private key for trader)
- `VPS_FINGERPRINT`

### 3-1. GitHub Actions SSH key handling (do not leave private key on VPS)
1. Confirm private key is already stored in GitHub Secrets `VPS_SSH_KEY`.
2. Remove VPS-side private key file:
```bash
rm -f ~/.ssh/github_actions_trader
# If available, shred is preferred:
# shred -u ~/.ssh/github_actions_trader
```
3. `~/.ssh/github_actions_trader.pub` may remain.
4. Keep the corresponding public-key line in `~/.ssh/authorized_keys`.
5. For key rotation, remove the public-key line from `authorized_keys` to disable login.

Get SSH fingerprint:
```bash
# Prefer ECDSA fingerprint (drone-ssh / appleboy behavior)
ssh <HOST> ssh-keygen -l -f /etc/ssh/ssh_host_ecdsa_key.pub | cut -d ' ' -f2

# Alternative without remote execution:
ssh-keyscan -p <PORT> -t ecdsa <HOST> 2>/dev/null | ssh-keygen -lf - -E sha256 | awk '{print $2}'
```

## 4. Deploy flow
- Trigger: push to `main` or `workflow_dispatch`.
- Workflow checks `.env.local` is not tracked.
- Workflow uses `appleboy/ssh-action@v1` with fingerprint verification.
- VPS deploy steps in `deploy.sh`:
  1. `git fetch/checkout`
  2. `npm ci`
  3. `npm run test`
  4. `npm run selftest`
  5. `systemctl restart hlauto`
  6. inspect journal logs since service activation time

Post-deploy checks:
1. Quick check for last `10 minutes`: fail workflow if Invariant A/B is not PASS.
2. `24h` summary: warning only (do not fail workflow).

## 5. Rollback
Deploy a previous commit SHA:
```bash
cd /opt/hlauto/trade
HLAUTO_APP_DIR=/opt/hlauto/trade HLAUTO_APP_USER=trader HLAUTO_SERVICE_NAME=hlauto bash ops/scripts/deploy.sh <COMMIT_SHA>
```

From Actions: `Run workflow` and set `deploy_ref`.

## 6. Runtime diagnostics
```bash
sudo /bin/systemctl status hlauto --no-pager
sudo /bin/journalctl -u hlauto -n 200 --no-pager
sudo /bin/journalctl -u hlauto --since "10 min ago" --no-pager
```

## 7. Invariant report (on-demand)
```bash
cd /opt/hlauto/trade
bash ops/scripts/ops-report.sh --since "24 hours ago" --service hlauto
```

Summary only:
```bash
bash ops/scripts/ops-report.sh --since "24 hours ago" --service hlauto --summary-only
```

Quick check A/B:
```bash
bash ops/scripts/ops-report.sh --since "10 minutes ago" --service hlauto --json-only | node ops/assert-invariants.mjs --require A,B
```

## 8. Daily summary (UTC auto generation)
One-shot (previous UTC day):
```bash
cd /opt/hlauto/trade
bash ops/scripts/daily-summary.sh --day-offset 1 --summary-only
```

Specific day:
```bash
bash ops/scripts/daily-summary.sh --day 2026-02-17
```

Saved files:
- `data/reports/YYYY-MM-DD/daily-summary.json`
- `data/reports/YYYY-MM-DD/daily-summary.md`

Timer status:
```bash
sudo systemctl status hlauto-daily-summary.timer --no-pager
sudo systemctl list-timers --all | grep hlauto-daily-summary
```

If `hlauto-daily-summary.service` fails:
```bash
sudo systemctl status hlauto-daily-summary.service --no-pager
sudo journalctl -u hlauto-daily-summary.service -n 200 --no-pager
# If permission error appears:
sudo chown -R hlauto:hlauto /opt/hlauto/trade/data
sudo systemctl restart hlauto-daily-summary.service
```

## 9. On-demand performance view
```bash
cd /opt/hlauto/trade
bash ops/scripts/performance-report.sh --hours 24 --format table
bash ops/scripts/performance-report.sh --since "2026-02-17T00:00:00Z" --until "now" --format md
bash ops/scripts/performance-report.sh --hours 6 --format json
```

Current position entry rationale:
```bash
bash ops/scripts/position-why.sh --format table
bash ops/scripts/position-why.sh --coin BTC --format md
bash ops/scripts/position-why.sh --format json
```

## 10. Failure triage
1. Quick check failed (A/B):
   - `bash ops/scripts/ops-report.sh --since "10 minutes ago" --service hlauto`
   - Focus first on `NO_PROTECTION`, `same_direction_add`, `flip_violations`.
2. No trades:
   - `bash ops/scripts/performance-report.sh --hours 6 --format table`
   - Check top reasons (`cycle_no_signal`, `book_too_thin`, `NO_TRADE_*`).
3. Daily timer failed:
   - `sudo journalctl -u hlauto-daily-summary.service -n 200 --no-pager`
   - `sudo systemctl daemon-reload && sudo systemctl restart hlauto-daily-summary.timer`

## 11. Self-audit checklist
- [ ] `.env.local` is not committed
- [ ] only `.env.local.example` is committed
- [ ] `VPS_USER=trader` (SSH key auth only)
- [ ] Actions uses SSH fingerprint verification
- [ ] rollback via `deploy.sh <COMMIT_SHA>` works
- [ ] quick check enforces Invariant A/B on deploy
- [ ] daily summary timer is active
