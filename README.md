# Hyperliquid Autonomous Profit Bot

利益最大化を目的に、実行品質・学習・運用安全を同時に回す bot です。

- 観測: raw HTTP/WS + 注文/約定/実行品質 + メトリクス + 改善履歴
- 実行: nonce/idempotency/価格サイズ正規化/拒否別リトライ
- 学習: `coin -> (coin×regime arm)` の階層バンディット
- 改善: OpenAI 提案(JSON厳格) -> ガード -> カナリア -> 採用/却下/ロールバック
- 安全: 予算制御 + ハードリスク制限 + 停止時キャンセル + フラット化

## 1. Setup

```powershell
Copy-Item .env.local.example .env.local
npm.cmd install
```

`.env.local` 未設定キーがある場合は起動時に不足キーを表示して `exit(1)` します。

## 2. Commands

```powershell
npm.cmd run doctor
npm.cmd run start
npm.cmd run replay
npm.cmd run report
npm.cmd run verify -- --hours 1
npm.cmd run selftest
npm.cmd run test
npm.cmd run doctor -- --hours 1
```

- `doctor`: 接続/権限/残高/WS/予算/保存先を総点検
- `start`: 実運用開始
- `replay`: 保存データ再生（発注なし）
- `report`: 人間向け戦績レポート（表形式）
- `verify`: raw_http の exchange:order エラー検査（時間窓ベース）
- `selftest`: 署名系セルフテスト
- `test`: ローテーション/圧縮/保持期限/rollup/schema の単体テスト

## 3. Runbook

- 運用手順の正本: `RUNBOOK.md`
- 明記済み:
  - 起動経路（entrypoint -> init -> loop）
  - データ出力経路（raw/rollup/state）
  - 停止経路（budget/risk/stability/signal）
  - 監視経路（doctor/report/metrics）

## 4. Data Layout

- `data/streams/YYYY-MM-DD/<stream>.jsonl`
- `data/streams/YYYY-MM-DD/<stream>.partN.jsonl`
- `data/streams/YYYY-MM-DD/<stream>.jsonl.gz`
- `data/rollups/YYYY-MM-DD/coin_rollup.jsonl`
- `data/state/*.json`

### Lifecycle (自動)

- ローテーション: `RAW_MAX_FILE_MB` 到達で `partN` へ分割
- 圧縮: 前日以前の raw を gzip 化
- 保持:
  - `RAW_KEEP_DAYS` 超: `.jsonl` 削除（`.gz` のみ保持）
  - `COMPRESSED_KEEP_DAYS` 超: `.jsonl.gz` 削除
  - `ROLLUP_KEEP_DAYS` 超: rollup 削除

## 5. Reporting Policy

- 直近: raw (`REPORT_RAW_LOOKBACK_HOURS`) を利用
- 過去: rollup を利用
- `report` 出力は `byArm/byCoin/byType + exchangeErrors + topImprovements`
- `report`/`doctor` は stability 判定（PASS/WARN/FAIL/WARMUP）を同時出力
- `filledOrderRate` は `filledOrderCount / orderAttemptCount`（`fillRate` は互換エイリアス）
- `rejectRate` は `orderRejectRate`（order attempt基準）を使用
- `exceptionRate` は運用例外（`where != order_submit`）のみを使用
- `cancelErrorRate` は cancel系のうち「already canceled/filled」等の良性noopを除外

## 6. Profit Engine

- 対象銘柄: `BTC` / `ETH` のみ
- レジーム:
  - `TREND_UP / TREND_DOWN / RANGE / TURBULENCE / NO_TRADE`
  - 入力: 1m生データ + 内部集計5m/15m（EMA20/50, ADX14, ATR14%, VWAP60, Zscore60）
- Trend戦略:
  - Pullback継続（EMA20(1m) 押し戻り後の再クロス）
  - maker優先 (`tif=Alo`) / TTL 8s
  - 例外taker (`tif=Ioc`) は TTL失効後の価格乖離条件 + spread/slippage + 日次taker上限を満たす場合のみ
- Range戦略:
  - `RANGE` 時のみ、VWAP回帰逆張り（Zscore60）
  - maker限定 (`tif=Alo`) / TTL 10s / taker禁止
- 追加ガード:
  - `DAILY_TRADE_LIMIT`（日次fill上限）
  - `TAKER_LIMIT`（日次taker fill上限）
  - `TAKER_STREAK_LIMIT`（連続takerで当日maker-only化）
  - `PYRAMIDING_BLOCKED`（同方向追加建て禁止）
  - 反対シグナルは `FLIP_WAIT_FLAT`（先にreduceOnlyでフラット化）

## 7. Hard Risk Limits

以下は利益最大化のための生存条件として強制:

- `RISK_MAX_DAILY_LOSS_USD`
- `RISK_MAX_DRAWDOWN_BPS`
- `RISK_MAX_POSITION_NOTIONAL_USD`
- `RISK_MAX_ORDER_NOTIONAL_USD`
- `RISK_MAX_OPEN_ORDERS`
- `MAX_CONCURRENT_POSITIONS`
- `TPSL_ENABLED`, `TP_BPS`, `SL_BPS`（取引所側 trigger TP/SL）

違反時: 自動停止 -> 未約定キャンセル -> ポジションフラット化（`FLATTEN_POSITIONS_ON_STOP=true`）

## 8. Budget Controls

- Hyperliquid:
  - HTTP (`API_BUDGET_DAILY_MAX_HTTP_CALLS`, `API_BUDGET_HOURLY_MAX_HTTP_CALLS`)
  - WS reconnect (`API_BUDGET_MAX_WS_RECONNECTS`)
  - 注文/取消 (`API_BUDGET_DAILY_MAX_ORDERS`, `API_BUDGET_DAILY_MAX_CANCELS`)
- OpenAI:
  - `OPENAI_DAILY_MAX_TOKENS` (`GPT_DAILY_MAX_TOKENS` 互換)
  - `OPENAI_MAX_COST_USD` (`GPT_MAX_COST_USD` 互換)
  - `OPENAI_MAX_CALLS`
  - 超過時挙動: `OPENAI_BUDGET_EXCEEDED_ACTION=disable|shutdown`

## 9. OpenAI Improvement Loop

- 注文判断はしない（提案のみ）
- 入力はサニタイズ済み統計（秘密情報/識別子を除外）
- 出力は strict JSON:
  - `proposals[]` (`coin|param|ops|strategy`)
  - `stop { suggest, reason, severity }`
  - `alerts[]`
- ガード:
  - パラメータ範囲外は破棄
  - カナリア検証
  - 悪化時ロールバック + `GPT_PROPOSAL_QUARANTINE_CYCLES` で再提案を凍結

## 10. Security Notes

- 秘密鍵/APIキーは `.env.local` のみ
- raw_http 保存時に `nonce/signature/secret` は自動マスク
- CLIログとレポート表示はアドレス等の識別子をマスク
- withdraw 系機能は実装していません

## 11. Hyperliquid Values

- API docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
- API wallets: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/api-wallets

## 12. Mainnet Bring-up

1. `npm.cmd run doctor`
2. `perp accountValue > 0` を確認
3. `OPENAI_ENABLED=false` でまず稼働確認
4. `npm.cmd run start`
5. `npm.cmd run report`

## 13. New Env (今回追加)

- Data lifecycle:
  - `RAW_MAX_FILE_MB`
  - `RAW_KEEP_DAYS`
  - `COMPRESSED_KEEP_DAYS`
  - `ROLLUP_KEEP_DAYS`
  - `ROLLUP_INTERVAL_SEC`
- Coin selection:
  - `COIN_SELECTION_ENABLED`
  - `COIN_UNIVERSE_MAX`
  - `COIN_SELECTION_REFRESH_MS`
- OpenAI:
  - `OPENAI_ENABLED`
  - `OPENAI_MAX_CALLS`
- `OPENAI_BUDGET_EXCEEDED_ACTION`
- Stability:
  - `STABILITY_MIN_ORDERS`
  - `STABILITY_MIN_CANCEL_ATTEMPTS`
  - `STABILITY_MIN_FILL_RATE`
  - `STABILITY_MAX_REJECT_RATE`
  - `STABILITY_MAX_SLIPPAGE_BPS`
  - `STABILITY_MAX_EXCEPTION_RATE`
  - `STABILITY_MAX_CANCEL_ERROR_RATE`
  - `STABILITY_MAX_WS_RECONNECT_RATIO`
  - `STABILITY_MAX_DRAWDOWN_BPS`
  - `STABILITY_FAIL_ACTION=warn|shutdown`
- TP/SL:
  - `TPSL_ENABLED`
  - `TP_BPS`
  - `SL_BPS`
  - `TPSL_IS_MARKET`
  - `TPSL_CLEANUP_ON_STOP`
- Strategy:
  - `STRATEGY_DAILY_FILL_LIMIT`
  - `STRATEGY_DAILY_TAKER_FILL_LIMIT`
  - `STRATEGY_CONSECUTIVE_TAKER_LIMIT`
  - `STRATEGY_DATA_STALE_*`
  - `STRATEGY_TREND_*`, `STRATEGY_RANGE_*`
  - `BTC_*`, `ETH_*`（spread/slippage/turbulence/taker trigger）
 - Vault:
  - `HYPERLIQUID_VAULT_MODE_ENABLED=false`（通常運用で推奨）
