# Hyperliquid Bot Runbook (VPS 24/7)

このRunbookは「取引ロジックを変更せずに」運用/デプロイ基盤を整えるための手順です。

## 0. 前提
- ローカルでコード編集してGitHubへpushする。
- VPSは `systemd` で `hlauto` サービスを常駐。
- デプロイは GitHub Actions -> SSH -> VPS の `ops/scripts/deploy.sh` で実行。
- `.env.local` はVPS上にのみ配置し、Gitへコミットしない。

## 1. VPS 初期セットアップ (Ubuntu)

### 手動セットアップ
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

### 半自動セットアップ (任意)
```bash
sudo bash /opt/hlauto/trade/ops/scripts/vps_bootstrap.sh <YOUR_GITHUB_REPO_URL>
```

## 2. systemd 導入
```bash
sudo cp /opt/hlauto/trade/ops/systemd/hlauto.service /etc/systemd/system/hlauto.service
sudo systemctl daemon-reload
sudo systemctl enable hlauto
```

`.env.local` を VPS に作成:
```bash
sudo -u hlauto cp /opt/hlauto/trade/.env.local.example /opt/hlauto/trade/.env.local
sudo -u hlauto nano /opt/hlauto/trade/.env.local
```

サービス起動確認:
```bash
sudo systemctl start hlauto
sudo systemctl status hlauto --no-pager
sudo journalctl -u hlauto -n 100 --no-pager
```

## 3. GitHub Secrets 設定
リポジトリの `Settings -> Secrets and variables -> Actions` に以下を登録:
- `VPS_HOST`
- `VPS_PORT`
- `VPS_USER`
- `VPS_SSH_KEY`
- `VPS_FINGERPRINT`

`VPS_FINGERPRINT` の取得例（ローカル）:
```bash
ssh-keyscan -p <PORT> <HOST> 2>/dev/null | ssh-keygen -lf - -E sha256
```
表示された `SHA256:...` を `VPS_FINGERPRINT` に登録。

## 4. デプロイの流れ

### 自動デプロイ
- `main` へ push すると `.github/workflows/deploy-vps.yml` が起動。
- workflow は `appleboy/ssh-action@v1` で VPS に接続し、以下を実行:
  1. `ops/scripts/deploy.sh <sha>`
  2. `git fetch/check out`
  3. `npm ci`
  4. `npm run test`
  5. `npm run selftest`
  6. `systemctl restart hlauto`
  7. `journalctl` の直近ログ検査

### 手動デプロイ (VPS上)
```bash
sudo -u hlauto HLAUTO_APP_DIR=/opt/hlauto/trade bash /opt/hlauto/trade/ops/scripts/deploy.sh main
```

## 5. ロールバック手順
前のコミットSHAを指定して再デプロイ:
```bash
sudo -u hlauto HLAUTO_APP_DIR=/opt/hlauto/trade bash /opt/hlauto/trade/ops/scripts/deploy.sh <COMMIT_SHA>
```

GitHub Actionsから実行する場合:
- `Actions -> deploy-vps -> Run workflow`
- `deploy_ref` に rollback したい SHA を入力して実行

## 6. 障害時の確認コマンド
```bash
sudo systemctl status hlauto --no-pager
sudo journalctl -u hlauto -n 200 --no-pager
sudo journalctl -u hlauto --since "10 min ago" --no-pager
```

## 7. デプロイスクリプトの失敗条件
`ops/scripts/deploy.sh` は以下を検出すると非0で終了:
- テスト失敗 (`npm run test`, `npm run selftest`)
- `systemctl is-active` が失敗
- journalに `invalid price` / `vault not registered` / `blocked_preflight`
- flatten系シグナルの連発（3回以上）

## 8. 代替案 (軽く)
- SSHデプロイの代替として self-hosted runner をVPS上に置く方式もある。
- ただし本Runbookでは、鍵管理とネットワーク境界が単純な SSH デプロイを採用。

## 9. 自己監査チェックリスト
- [ ] `.env.local` をコミットしていない
- [ ] GitHub Secrets の権限を最小化している
- [ ] `systemd` が `Restart=always` で自動再起動する
- [ ] Actions が `fingerprint` 検証付きでSSH接続している
- [ ] デプロイ失敗時に rollback コマンドで復旧できる
