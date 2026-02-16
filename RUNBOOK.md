# Hyperliquid Bot Runbook (VPS trader-only)

This runbook covers deployment and operations only. Trading logic is out of scope.

## 0. Rules
- SSH user is `trader` only (key-based auth). No root SSH login.
- Keep `.env.local` only on VPS. Never commit it.
- `deploy.sh` runs as `trader`; it uses `sudo` only for `systemctl` and `journalctl`.

## 1. VPS bootstrap (Ubuntu)

### 1-1. One-time setup (run as trader)
```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates gnupg lsb-release sudo
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo useradd --system --create-home --shell /bin/bash hlauto || true
sudo mkdir -p /opt/hlauto
sudo chown -R trader:trader /opt/hlauto
git clone <YOUR_GITHUB_REPO_URL> /opt/hlauto/trade
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
sudo systemctl daemon-reload
sudo systemctl enable hlauto
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

### 3-1. GitHub Actions 用 SSH鍵の扱い（秘密鍵をVPSに残さない）
1. GitHub Secrets の `VPS_SSH_KEY` に秘密鍵を登録済みであることを確認する。
2. VPS 上に残る秘密鍵 `~/.ssh/github_actions_trader` を削除する。
3. `~/.ssh/github_actions_trader.pub` は残してよい（必須ではない）。
4. `~/.ssh/authorized_keys` の該当公開鍵行は残す（削除しない）。

```bash
rm -f ~/.ssh/github_actions_trader
# shred が使える環境では以下を優先してもよい（必須ではない）
# shred -u ~/.ssh/github_actions_trader
```

鍵ローテーション時は、`~/.ssh/authorized_keys` の対象公開鍵行を削除すると、その鍵でのログインを無効化できる。

Get SSH fingerprint:
```bash
# NOTE: appleboy/ssh-action uses drone-ssh (Go crypto/ssh) which prefers the ECDSA host key when available.
# Pin the ECDSA host key fingerprint to avoid "host key fingerprint mismatch".
ssh <HOST> ssh-keygen -l -f /etc/ssh/ssh_host_ecdsa_key.pub | cut -d ' ' -f2

# Alternative (no remote execution), still ECDSA only:
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

## 5. Rollback
Deploy a previous commit SHA:
```bash
cd /opt/hlauto/trade
HLAUTO_APP_DIR=/opt/hlauto/trade HLAUTO_APP_USER=trader HLAUTO_SERVICE_NAME=hlauto bash ops/scripts/deploy.sh <COMMIT_SHA>
```

From Actions: `Run workflow` and set `deploy_ref`.

## 6. .env.local incident handling

### 6-1. Preventive check
```bash
git ls-files --error-unmatch .env.local >/dev/null 2>&1 && echo "NG: tracked" || echo "OK: not tracked"
```

### 6-2. If tracked now
```bash
git rm --cached .env.local
echo ".env.local" >> .gitignore
git add .gitignore
git commit -m "chore: stop tracking .env.local"
```

### 6-3. If leaked in history (full purge)
```bash
cp .env.local /tmp/env.local.backup
git filter-repo --path .env.local --invert-paths --force
git for-each-ref --format="delete %(refname)" refs/original | git update-ref --stdin
git reflog expire --expire=now --all
git gc --prune=now --aggressive
git push origin --force --all
git push origin --force --tags
```

## 7. Fix local repo if it was accidentally re-initialized
```bash
git remote remove origin || true
git remote add origin <YOUR_GITHUB_REPO_URL>
git fetch --prune --tags origin
git checkout -B main origin/main
git branch --set-upstream-to=origin/main main
git tag -l
```

Optional local backup before relink:
```bash
git branch backup/local-before-relink
```

## 8. Runtime diagnostics
```bash
sudo /bin/systemctl status hlauto --no-pager
sudo /bin/journalctl -u hlauto -n 200 --no-pager
sudo /bin/journalctl -u hlauto --since "10 min ago" --no-pager
```

## 9. Self-audit checklist
- [ ] `.env.local` is not committed
- [ ] only `.env.local.example` is committed
- [ ] `VPS_USER=trader` (SSH key auth only)
- [ ] Actions uses SSH fingerprint verification
- [ ] rollback via `deploy.sh <COMMIT_SHA>` works
