# Hyperliquid Bot Runbook (VPS 24/7 Ops)

This runbook covers deployment and operations only. Trading logic is out of scope.

## 0. Rules
- Keep `.env.local` only on VPS. Never commit it.
- Run `deploy.sh` as `root` or a `deployer` user with passwordless sudo.
- `git` and `npm` run as `hlauto`; `systemctl` and `journalctl` run with admin privileges.

## 1. VPS bootstrap (Ubuntu)

### 1-1. Manual setup
```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates gnupg lsb-release sudo
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo useradd --system --create-home --shell /bin/bash hlauto || true
sudo mkdir -p /opt/hlauto
sudo chown -R hlauto:hlauto /opt/hlauto

sudo -u hlauto git clone <YOUR_GITHUB_REPO_URL> /opt/hlauto/trade
sudo chmod +x /opt/hlauto/trade/ops/scripts/deploy.sh /opt/hlauto/trade/ops/scripts/vps_bootstrap.sh
```

### 1-2. Optional semi-auto setup
Run bootstrap from a temporary clone (works on fresh Ubuntu):
```bash
tmpdir="$(mktemp -d)"
git clone --depth 1 <YOUR_GITHUB_REPO_URL> "$tmpdir/trade"
sudo bash "$tmpdir/trade/ops/scripts/vps_bootstrap.sh" <YOUR_GITHUB_REPO_URL>
rm -rf "$tmpdir"
```

## 2. systemd install
```bash
sudo cp /opt/hlauto/trade/ops/systemd/hlauto.service /etc/systemd/system/hlauto.service
sudo systemctl daemon-reload
sudo systemctl enable hlauto
```

Create VPS env file:
```bash
sudo -u hlauto cp /opt/hlauto/trade/.env.local.example /opt/hlauto/trade/.env.local
sudo -u hlauto nano /opt/hlauto/trade/.env.local
```

First deploy:
```bash
sudo HLAUTO_APP_DIR=/opt/hlauto/trade HLAUTO_APP_USER=hlauto HLAUTO_SERVICE_NAME=hlauto bash /opt/hlauto/trade/ops/scripts/deploy.sh main
```

## 3. GitHub Actions secrets
Create these repository secrets:
- `VPS_HOST`
- `VPS_PORT`
- `VPS_USER` (root or deployer with passwordless sudo)
- `VPS_SSH_KEY`
- `VPS_FINGERPRINT`

Get SSH fingerprint:
```bash
ssh-keyscan -p <PORT> <HOST> 2>/dev/null | ssh-keygen -lf - -E sha256
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
sudo HLAUTO_APP_DIR=/opt/hlauto/trade HLAUTO_APP_USER=hlauto HLAUTO_SERVICE_NAME=hlauto bash /opt/hlauto/trade/ops/scripts/deploy.sh <COMMIT_SHA>
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
sudo systemctl status hlauto --no-pager
sudo journalctl -u hlauto -n 200 --no-pager
sudo journalctl -u hlauto --since "10 min ago" --no-pager
```

## 9. Self-audit checklist
- [ ] `.env.local` is not committed
- [ ] only `.env.local.example` is committed
- [ ] deploy user policy is consistent (`root/deployer` + `HLAUTO_APP_USER=hlauto`)
- [ ] Actions uses SSH fingerprint verification
- [ ] rollback via `deploy.sh <COMMIT_SHA>` works
