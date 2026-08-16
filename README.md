# dsh-quota-dashboard

[English](#english) | [中文](#中文)

A draggable **quota & cost dashboard** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) **Web GUI**. One floating card combines **OpenRouter** and **DeepSeek** balances and spend — from official APIs plus a local session-log pricing engine.

---

## 中文

一个为 DeepSeek Harness（dsh）Web GUI 打造的**可拖拽额度/费用面板**。一张悬浮卡片整合 **OpenRouter** 与 **DeepSeek** 的余额与花费——数据来自官方 API 加本地会话日志计价引擎。

### 功能

| 数据 | OpenRouter | DeepSeek |
|------|-----------|----------|
| 余额（真实剩余） | ✅ 官方 `/credits` | ✅ 官方 `/user/balance` |
| 赠送额度 | — | ✅ granted / topped-up |
| 当前对话费用 | ✅ 会话日志回放 | ✅ 会话日志回放 |
| 今日 / 本周 / 本月 | ✅ 官方 `/auth/key` | ✅ 今日：官方（平台 token）或回放 |
| 过去 1 小时 | ✅ 本地记账 | ✅ 回放 |

其他特性：

- **可拖拽**：按住卡片拖到任意位置，位置自动记住（localStorage）
- **点击展开/收起** 详情面板
- **中英双语**：跟随浏览器语言，面板内一键切换（持久化）
- **色盲友好配色**：区分信息不单靠颜色
- **自动刷新**（60s）+ 手动刷新按钮
- **API key 永不出机器**：浏览器只访问本地路由 `GET /api/quota-dashboard`，密钥由宿主 credentials 服务解析

### 安装

**方式一：npm（推荐，一行安装）**

```sh
dsh plugin --profile web add @wangyong1972/dsh-quota-dashboard
# 重启 dsh web（bundle 层启动时加载），然后硬刷新浏览器（Cmd+Shift+R）
```

已发布到 npm：[![npm](https://img.shields.io/npm/v/@wangyong1972/dsh-quota-dashboard)](https://www.npmjs.com/package/@wangyong1972/dsh-quota-dashboard)

**方式二：从源码安装（开发/贡献）**

```sh
git clone https://github.com/wangyong1972/dsh-quota-dashboard
dsh plugin --profile web add /path/to/dsh-quota-dashboard
```

### 配置（可选）

插件的 key 复用 DSH 已有的 credentials：

| 凭据 | 用途 |
|------|------|
| `OPENROUTER_API_KEY` | OpenRouter 余额/用量（Settings → Models 页面设置） |
| `DEEPSEEK_API_KEY` | DeepSeek 余额 |
| `DEEPSEEK_PLATFORM_TOKEN`（可选） | 解锁 DeepSeek 官方「今日」用量（与控制台一致）。获取：登录 https://platform.deepseek.com → DevTools → Console → `JSON.parse(localStorage.getItem('userToken')).value` → 加入 `~/.dsh/.credentials.yaml` |

未配置 `DEEPSEEK_PLATFORM_TOKEN` 时，「今日」自动回放本地会话日志（准确，包含安装前历史）。

### 数据来源

- **余额 / 赠送 / 日周月**：官方 API（实时）
- **当前对话 / 今日 / 1h**：回放会话日志 × 官方价格引擎（OpenRouter 用 `/models` 价格表，DeepSeek 用官方定价）
- **本地 ledger**：`$DSH_HOME/storages/quota-dashboard-ledger.jsonl`（记账最近 7 天）

### 隐私

- API key 只存在于宿主进程，通过 `ctx.credentials` 解析，**不发送到浏览器**
- 无遥测、无外部上报
- 价格表与官方 API 端点均为公开数据

### 许可

MIT。`lib/pricing.js` 移植自 [dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing)（MIT），见 [LICENSE](LICENSE)。

---

## English

A draggable **quota & cost dashboard** for the DeepSeek Harness (dsh) **Web GUI**. One floating card combines **OpenRouter** and **DeepSeek** balances and spend — from official APIs plus a local session-log pricing engine.

### Features

| Data | OpenRouter | DeepSeek |
|------|-----------|----------|
| Balance (real remaining) | ✅ official `/credits` | ✅ official `/user/balance` |
| Granted credit | — | ✅ granted / topped-up |
| This-chat cost | ✅ session-log replay | ✅ session-log replay |
| Today / Week / Month | ✅ official `/auth/key` | ✅ Today: official (platform token) or replay |
| Last hour | ✅ local ledger | ✅ replay |

Also:

- **Draggable** — grab and move anywhere; position persists (localStorage)
- **Click to expand/collapse** the detail panel
- **i18n (zh/en)** — follows browser locale, one-click toggle in the panel (persisted)
- **Colorblind-safe palette** — never relies on color alone
- **Auto-refresh** (60s) + manual refresh button
- **API keys never leave the machine** — the browser only talks to the local route `GET /api/quota-dashboard`; secrets resolve via the host credentials service

### Install

**Option 1: npm (recommended, one line)**

```sh
dsh plugin --profile web add @wangyong1972/dsh-quota-dashboard
# restart `dsh web` (bundle layers load at boot), then hard-refresh (Cmd+Shift+R)
```

Published on npm: [![npm](https://img.shields.io/npm/v/@wangyong1972/dsh-quota-dashboard)](https://www.npmjs.com/package/@wangyong1972/dsh-quota-dashboard)

**Option 2: from source (development / contributions)**

```sh
git clone https://github.com/wangyong1972/dsh-quota-dashboard
dsh plugin --profile web add /path/to/dsh-quota-dashboard
```

### Configuration (optional)

Keys reuse the harness credentials:

| Credential | Purpose |
|------------|---------|
| `OPENROUTER_API_KEY` | OpenRouter balance/usage (Settings → Models page) |
| `DEEPSEEK_API_KEY` | DeepSeek balance |
| `DEEPSEEK_PLATFORM_TOKEN` (optional) | Unlocks the official DeepSeek "today" usage (same data as the platform console). Get it: log in to https://platform.deepseek.com → DevTools → Console → `JSON.parse(localStorage.getItem('userToken')).value` → add to `~/.dsh/.credentials.yaml` |

Without `DEEPSEEK_PLATFORM_TOKEN`, "today" falls back to replaying local session logs (accurate, includes pre-install history).

### Data sources

- **Balances / granted / daily-weekly-monthly**: official APIs (live)
- **This chat / today / last hour**: session-log replay × official price engines (OpenRouter `/models` table, DeepSeek official pricing)
- **Local ledger**: `$DSH_HOME/storages/quota-dashboard-ledger.jsonl` (7-day retention)

### Privacy

- API keys live only in the host process, resolved via `ctx.credentials` — **never sent to the browser**
- No telemetry, no external reporting
- Price tables and official API endpoints are public data

### License

MIT. `lib/pricing.js` is ported from [dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing) (MIT); see [LICENSE](LICENSE).
