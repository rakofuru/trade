# Hyperliquid Bot Runbook (VPS / Ops)

This runbook covers deployment and operations only. Trading logic is out of scope.

## 0. Rules
- SSH deploy user is key-based auth only (recommended: `trader`). No root SSH login.
- Keep `.env.local` only on VPS. Never commit it.
- `deploy.sh` runs as the SSH deploy user (`VPS_USER`); it uses `sudo` only for `systemctl` and `journalctl`.
- Unit ownership model (fixed):
  - `hlauto.service` -> `User=hlauto`, `Group=hlauto`
  - `hlauto-daily-summary.service` -> `User=trader`, `Group=trader`, `SupplementaryGroups=hlauto`
  - `data/*` owner/group -> `hlauto:hlauto` with `setgid + g+w`
- systemd unit source of truth is repo (`ops/systemd/*`). `/etc/systemd/system/*` is generated from repo and may be overwritten.
- Hard risk stops are immutable. Do not change Daily/Weekly/MDD/Risk-per-trade/Exposure hard limits in ops work.
- Invariant A/B are priority-1: unprotected position and flip-order violations are never acceptable.

## 1. VPS bootstrap (Ubuntu)

### 1-1. One-time setup (as `trader`)
```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates gnupg lsb-release sudo
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo groupadd --system hlauto || true
sudo useradd --system --create-home --shell /bin/bash hlauto || true
sudo usermod -g hlauto hlauto || true
sudo usermod -aG hlauto trader || true
sudo mkdir -p /opt/hlauto
sudo chown -R trader:trader /opt/hlauto
git clone <YOUR_GITHUB_REPO_URL> /opt/hlauto/trade
sudo mkdir -p /opt/hlauto/trade/data/{streams,rollups,state,reports}
sudo chown -R hlauto:hlauto /opt/hlauto/trade/data
sudo find /opt/hlauto/trade/data -type d -exec chmod 2775 {} +
sudo find /opt/hlauto/trade/data -type f -exec chmod 0664 {} +
chmod +x /opt/hlauto/trade/ops/scripts/deploy.sh /opt/hlauto/trade/ops/scripts/vps_bootstrap.sh
```

Quick one-shot finalize (recommended, as root):
```bash
sudo bash /opt/hlauto/trade/ops/scripts/finalize-vps.sh
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
sudo bash /opt/hlauto/trade/ops/scripts/install-systemd-units.sh
sudo systemctl enable --now hlauto-daily-summary.timer
```

Create VPS env file:
```bash
cp /opt/hlauto/trade/.env.local.example /opt/hlauto/trade/.env.local
nano /opt/hlauto/trade/.env.local
```

LINE webhook env (if using human-in-the-loop):
```bash
LINE_CHANNEL_ID=...
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
PUBLIC_BASE_URL=https://<your-domain>
LINE_WEBHOOK_PATH=/line/webhook
LINE_WEBHOOK_PORT=8787
LINE_ALLOWED_USER_IDS=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ASKQUESTION_COOLDOWN_MS=1800000
ASKQUESTION_DAILY_MAX=8
ASKQUESTION_REASON_COOLDOWN_MS=7200000
ASKQUESTION_TRIGGER_WINDOW_MS=900000
ASKQUESTION_TRIGGER_DRAWDOWN_BPS=150
ASKQUESTION_TRIGGER_DAILY_PNL_USD=-10
ASKQUESTION_TRIGGER_POSITION_NOTIONAL_RATIO=0.8
ASKQUESTION_TRIGGER_RECONCILE_FAILURE_STREAK=2
ASKQUESTION_TRIGGER_WS_TIMEOUTS_15M=2
ASKQUESTION_TRIGGER_BLOCKED_AGE_MS=1800000
ASKQUESTION_TRIGGER_BLOCKED_GROWTH_15M=50
ASKQUESTION_SUPPRESS_FLAT_LOW_RISK=true
ASKQUESTION_TTL_DEFAULT_ACTION_FLAT=HOLD
ASKQUESTION_TTL_DEFAULT_ACTION_IN_POSITION=FLATTEN
DAILY_EVAL_ENABLED=true
DAILY_EVAL_AT_UTC=00:10
```
- LINE Developers の Webhook URL は `PUBLIC_BASE_URL + LINE_WEBHOOK_PATH` を設定
- 受信経路（reverse proxy / firewall）で `LINE_WEBHOOK_PORT` まで到達できることを確認

First deploy:
```bash
cd /opt/hlauto/trade
HLAUTO_APP_DIR=/opt/hlauto/trade HLAUTO_APP_USER=trader HLAUTO_SERVICE_NAME=hlauto bash ops/scripts/deploy.sh main
```

## 3. GitHub Actions secrets
Create these repository secrets:
- `VPS_HOST`
- `VPS_PORT`
- `VPS_USER` (deploy user; recommended `trader`)
- `VPS_SSH_KEY` (private key for deploy user)
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
# Prefer ECDSA fingerprint
ssh <HOST> ssh-keygen -l -f /etc/ssh/ssh_host_ecdsa_key.pub | cut -d ' ' -f2

# Alternative without remote execution:
ssh-keyscan -p <PORT> -t ecdsa <HOST> 2>/dev/null | ssh-keygen -lf - -E sha256 | awk '{print $2}'
```

## 4. Deploy flow
- Trigger: push to `main` or `workflow_dispatch`.
- Workflow checks `.env.local` is not tracked.
- Workflow uses native OpenSSH with host-key fingerprint preflight and strict known_hosts.
- Workflow runs `npm ci`, `npm run test`, `npm run selftest` on GitHub Actions runner first.
- Workflow uploads a repository snapshot (`.git/.github/node_modules/.env.local/data` excluded) to VPS `/tmp` as best-effort.
- Deploy step first tries to apply snapshot to `/opt/hlauto/trade`; if apply fails, it tries `git fetch/checkout` best-effort.
- Deploy step has SSH retry (up to 3 attempts) for transient network failures.
- Deploy failure emits remote diagnostics (`systemctl status hlauto`, recent `journalctl`) before retry/fail.
- GitHub Actions deploy path restarts service directly:
  1. snapshot apply (best-effort)
  2. git checkout fallback (best-effort)
  3. `systemctl restart hlauto` and `is-active` check
  4. recent `journalctl` tail output
- `ops/scripts/deploy.sh` is still the manual strict deploy path (`git/npm test/selftest/journal checks`).
- Ops-sanity/invariant checks run in dedicated post-deploy steps.

Post-deploy checks:
1. Quick check for last `10 minutes`: warning only if Invariant A/B is not PASS.
2. `24h` summary: warning only (do not fail workflow).
3. Ops sanity check: unit `User/Group/WorkingDirectory/ExecStart`, `journalctl` readability, and report-dir writability must pass.

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

LINE webhook diagnostics:
```bash
# env反映確認（値そのものは出さない）
sudo systemctl show hlauto --property=Environment --no-pager | sed 's/ /\n/g' | grep '^LINE_'

# webhook listener確認
sudo ss -lntp | grep ':8787'

# 直近LINEイベントの確認
sudo /bin/journalctl -u hlauto -n 200 --no-pager | grep -E 'line_webhook|line_command|ask_question|LINE'
```

Emergency stop (kill switch file):
```bash
touch /opt/hlauto/trade/data/state/KILL_SWITCH
```
- Bot detects `RUNTIME_KILL_SWITCH_FILE` and performs graceful shutdown.
- `run-bot.sh` waits while the file exists, so auto-restart does not resume trading.
- 致命例外/cleanup最終失敗時も同ファイルが自動作成され、二次被害防止のため再起動売買を停止維持する。

Resume:
```bash
rm -f /opt/hlauto/trade/data/state/KILL_SWITCH
sudo /bin/systemctl restart hlauto
```

Runtime guardrails (always-on):
- Single instance lock: `run-bot.sh` uses `flock` (`data/state/hlauto.lock`) to block duplicate bot processes.
- WS watchdog: if no WS message for `WS_MESSAGE_TIMEOUT_MS`, bot forces reconnect (`WS_WATCHDOG_INTERVAL_MS` poll).
- Open order reconcile: every `OPEN_ORDERS_RECONCILE_INTERVAL_MS`, exchange open-orders are reconciled to local state.
- Reconcile hard-fail: consecutive reconcile errors reaching `OPEN_ORDERS_RECONCILE_MAX_FAILURES` trigger shutdown.
- Daily loss window: `DAILY_LOSS_MODE=utc_day|rolling24h` (default `utc_day`) controls realized PnL day-start.
- Shutdown cleanup retry: cancel/flatten retries (`SHUTDOWN_CLEANUP_MAX_RETRIES`, `SHUTDOWN_CLEANUP_BACKOFF_BASE_MS`).
- Stability fail action default is `STABILITY_FAIL_ACTION=shutdown` (fail-open禁止).
- LINE webhook security: `X-Line-Signature` を `LINE_CHANNEL_SECRET` で検証
- LINE operator allowlist: `LINE_ALLOWED_USER_IDS` 以外は拒否
- LINE command format: `BOT_DECISION_V2` ブロックのみ解釈（自由文は無視）
- LINE actions: `RESUME / REJECT / PAUSE / HOLD / FLATTEN / CANCEL_ORDERS / CUSTOM`
- `APPROVE` は互換入力として受理するが内部では `RESUME` に正規化
- `APPROVE(RESUME)` は「異常停止からの復旧再開」用途のみ（通常判断用途では使わない）
- AskQuestion 1通目のクイックリプライ:
  - `📋 GPT再送` / `ℹ DETAIL` / `⏸ PAUSE` / `✅ APPROVE(RESUME)`
- AskQuestion は 2通送信（人間向け短文 + GPT貼り付け用テンプレ）
- AskQuestion TTL切れ時の既定動作:
  - flat: `ASKQUESTION_TTL_DEFAULT_ACTION_FLAT`（既定 `HOLD`）
  - in position: `ASKQUESTION_TTL_DEFAULT_ACTION_IN_POSITION`（既定 `FLATTEN`）
- Daily evaluation は `DAILY_EVAL_AT_UTC` に 1日1回、LINEへ2通送信

## 7. Invariant report (on-demand)
```bash
cd /opt/hlauto/trade
bash ops/scripts/ops-report.sh --since "24 hours ago" --service hlauto
```
- Output is human-oriented with Japanese labels (plus machine JSON).

Summary only:
```bash
bash ops/scripts/ops-report.sh --since "24 hours ago" --service hlauto --summary-only
```

Quick check A/B:
```bash
bash ops/scripts/ops-report.sh --since "10 minutes ago" --service hlauto --json-only | node ops/assert-invariants.mjs --require A,B
```

Ops sanity (permission / unit model):
```bash
bash ops/scripts/ops-sanity-check.sh --app-dir /opt/hlauto/trade --service hlauto --summary-service hlauto-daily-summary
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
- Both include `Recent Entry Rationales` (entry-time reasonCode/features; no live re-calculation)
- Inspect example:
```bash
jq '.entryRationales[:5]' data/reports/$(date -u -d "yesterday" +%F)/daily-summary.json
```

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
sudo usermod -aG hlauto trader
sudo chown -R hlauto:hlauto /opt/hlauto/trade/data
sudo find /opt/hlauto/trade/data -type d -exec chmod 2775 {} +
sudo find /opt/hlauto/trade/data -type f -exec chmod 0664 {} +
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
- `position-why` is based on `entry_snapshot` saved at entry-fill time (no current market re-calculation of reason/features).
- `ops-report` recent chains also resolve entry reason in this order:
  - `entry_snapshot`
  - `fill_execution_summary`
  - `orders`
  - `execution`

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
4. LINEが届かない:
   - `LINE_CHANNEL_ACCESS_TOKEN` の未設定/期限切れを確認
   - channel側のWebhook有効化とURL（`PUBLIC_BASE_URL + LINE_WEBHOOK_PATH`）を確認
   - `LINE_ALLOWED_USER_IDS` に運用者 `userId` が入っているか確認
5. 署名エラー:
   - `line_webhook_rejected reason=signature_invalid` が出る場合は `LINE_CHANNEL_SECRET` 不一致
   - reverse proxy等でrequest bodyを書き換えていないか確認
6. allowlist拒否:
   - `line_webhook_rejected reason=allowlist_denied` を確認
   - 友だち追加済み運用者の `userId` を `LINE_ALLOWED_USER_IDS` に追加
7. コマンド形式エラー:
   - `line_command_invalid` を確認
   - 返信本文に `BOT_DECISION_V2` ブロックがあるか確認

## 11. Self-audit checklist
- [ ] `.env.local` is not committed
- [ ] only `.env.local.example` is committed
- [ ] `VPS_USER` is deploy user with SSH key auth only
- [ ] deploy user has passwordless sudo for `/bin/systemctl` and `/bin/journalctl`
- [ ] Actions uses SSH fingerprint verification
- [ ] rollback via `deploy.sh <COMMIT_SHA>` works
- [ ] quick check output for Invariant A/B is monitored after deploy
- [ ] daily summary timer is active
