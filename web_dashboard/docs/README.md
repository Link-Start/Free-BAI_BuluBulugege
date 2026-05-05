# 号池机 — Bank of AI API Key Pool

## 概述

号池机是一个用于自动化管理 Bank of AI 平台 API Key 的系统，支持：

- **自动注册**新账号（ETH 钱包 + Claim + API Key 创建）
- **代理轮换**（从代理池 API 获取 IP）
- **额度管理**（检查、刷新、废弃账号自动替换）
- **LiteLLM 集成**（统一网关，支持 OpenAI / Anthropic / Gemini 格式）
- **Dashboard**（可视化操作界面）

---

## 快速开始

### 1. 初始化

```bash
# 初始化默认设置
curl -X POST http://localhost:3999/api/init
```

### 2. 导入旧 Key（可选）

```bash
# 将已有的 all_keys.json 账号导入数据库
npx ts-node --import tsconfig-paths/register scripts/importLegacy.ts
```

### 3. 启动服务

```bash
cd web_dashboard
npm run dev -- --port 3999
```

Dashboard 访问：**http://localhost:3999**

---

## API 参考

所有 API 均返回 JSON。认证通过 Bearer Token（`Authorization: Bearer <LITELLM_MASTER_KEY>`）。

### 基础信息

| 基础 URL | `http://localhost:3999` |
|----------|------------------------|

---

### 账号管理

#### 获取账号列表

```
GET /api/accounts?status=ACTIVE&page=1&limit=20
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `status` | string | 筛选状态：`ACTIVE` / `DEPLETED` / `DEAD` |
| `page` | number | 页码（默认 1） |
| `limit` | number | 每页数量（默认 20） |

响应示例：
```json
{
  "accounts": [
    {
      "id": "clxxxxxxxxxxxxxx",
      "address": "0x29A2...8fE5",
      "apiKey": "sk-3ia...xxxx",
      "credits": 100000,
      "status": "ACTIVE",
      "proxy": "180.127.141.131:11724",
      "createdAt": "2026-04-13T10:30:00.000Z",
      "lastCheckAt": "2026-04-13T12:00:00.000Z",
      "lastUsedAt": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 503,
    "pages": 26
  }
}
```

#### 触发注册（补号）

```
POST /api/accounts/register
Content-Type: application/json

{"count": 10}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `count` | number | 注册数量（最大 50） |

响应示例：
```json
{"success": 8, "failed": 2, "total": 10}
```

---

### 额度管理

#### 检查所有账号额度

```
POST /api/quota/check
```

遍历所有非 DEAD 账号，通过 session 查询 points 或 API 调用验证 key 状态。

响应示例：
```json
{"total": 503, "alive": 412, "dead": 11, "depleted": 80}
```

#### 刷新废弃账号

```
POST /api/quota/refresh
```

将所有 `DEPLETED` 状态的账号重新注册替换。

响应示例：
```json
{"refreshed": 45, "failed": 3, "total": 48}
```

---

### Key 分配

#### 分配一个可用 Key

```
POST /api/alloc
```

从最新入库的 200 个 ACTIVE 账号中，按最近最少使用分配一个 key。

响应示例：
```json
{"apiKey": "sk-3ia...", "accountId": "clxxxxxxxx", "credits": 100000}
```

> **注意**：返回后，该账号的 `lastUsedAt` 已更新，不会立即再被分配出去。

---

### 系统设置

#### 获取所有设置

```
GET /api/settings
```

响应示例：
```json
{
  "registration_concurrency": "10",
  "proxy_fetch_count": "300",
  "proxy_api_url": "http://proxy.siyetian.com/apis_get.html?token=...",
  "auto_refresh_enabled": "true",
  "quota_check_interval": "300",
  "litellm_master_key": "sk-bankofai-pool-master"
}
```

#### 更新设置

```
PUT /api/settings
Content-Type: application/json

{"key": "registration_concurrency", "value": "20"}
```

| key | 说明 | 默认值 |
|-----|------|--------|
| `registration_concurrency` | 注册并发量（≥1） | 3 |
| `proxy_fetch_count` | 每轮 IP 获取量（≥1） | 10 |
| `proxy_api_url` | 代理 API 地址 | — |
| `auto_refresh_enabled` | 是否自动刷新（true/false） | true |
| `quota_check_interval` | 额度检查间隔（秒） | 300 |

---

### 池子统计

```
GET /api/pool-stats
```

响应示例：
```json
{"total": 503, "active": 412, "depleted": 80, "dead": 11, "registering": 0}
```

---

## 集成 LiteLLM

LiteLLM Proxy 作为统一网关，接收 OpenAI / Anthropic 格式的请求，转发给 Bank of AI。

### LiteLLM 配置

编辑 `litellm/config.yaml`：

```yaml
model_list:
  - model_name: glm-5
    litellm_params:
      model: zhipuai/glm-5
      api_key: os.environ/ZHIPUAI_API_KEY

  - model_name: gpt-5.4
    litellm_params:
      model: openai/gpt-5.4
      api_key: os.environ/OPENAI_API_KEY

  - model_name: gemini-3.1-pro
    litellm_params:
      model: gemini/gemini-3.1-pro
      api_key: os.environ/GEMINI_API_KEY
      supports_anthropic_messages: true

  - model_name: gemini-3-flash
    litellm_params:
      model: gemini/gemini-3.0-flash
      api_key: os.environ/GEMINI_API_KEY
      supports_anthropic_messages: true

litellm_settings:
  drop_params: true
  set_verbose: false
  request_timeout: 120
  num_retries: 2

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

### 启动 LiteLLM Proxy

```bash
pip install litellm
export LITELLM_MASTER_KEY="sk-bankofai-pool-master"
export DATABASE_URL="file:./dev.db"  # 可选，用于 LiteLLM 日志存储

litellm --config litellm/config.yaml --port 4000
```

### 请求示例

#### OpenAI 格式

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-bankofai-pool-master" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 100
  }'
```

#### Anthropic 格式

```bash
curl http://localhost:4000/v1/messages \
  -H "Authorization: Bearer sk-bankofai-pool-master" \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-bankofai-pool-master" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "gemini-3.1-pro",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 100
  }'
```

#### 模型列表

```
GET http://localhost:4000/model/info
```

---

## 数据模型

### 账号状态

| 状态 | 说明 |
|------|------|
| `ACTIVE` | 正常，有额度，可分配 |
| `DEPLETED` | 额度用尽，待刷新 |
| `DEAD` | 无法使用，已废弃 |
| `REGISTERING` | 注册中（中间状态） |

### 账号额度

每个 Bank of AI 账号新注册时拥有 **100,000 credits**。

---

## 轮换策略

1. **池子大小**：最新入库的 **200 个** ACTIVE 账号参与分配，超出的保留但不参与轮换
2. **分配算法**：最近最少使用（Least Recently Used）
3. **用尽处理**：额度 ≤0 时标记为 `DEPLETED`，下次 `POST /api/quota/refresh` 时重新注册替换
4. **代理限流**：单 IP 连续失败 2 次自动退役

---

## 文件结构

```
web_dashboard/
├── app/
│   ├── api/
│   │   ├── accounts/          # 账号列表 + 注册
│   │   ├── quota/            # 额度检查 + 刷新
│   │   ├── alloc/             # Key 分配
│   │   ├── pool-stats/       # 池子统计
│   │   └── settings/          # 系统设置
│   ├── PoolStatus.tsx        # 统计卡片组件
│   ├── SettingsForm.tsx       # 设置表单组件
│   ├── AccountTable.tsx      # 账号列表组件
│   ├── LogViewer.tsx          # 实时日志组件
│   └── page.tsx               # Dashboard 首页
├── lib/
│   ├── prisma.ts              # 数据库客户端
│   ├── constants.ts           # 常量（AES_KEY, URLs）
│   ├── types.ts               # TypeScript 类型
│   └── services/
│       ├── BankOfAIService.ts  # 注册 + Claim + API Key
│       ├── ProxyPoolService.ts # 代理池管理
│       ├── QuotaService.ts     # 额度检查 + 分配
│       └── SettingService.ts   # 设置读写
├── litellm/
│   └── config.yaml            # LiteLLM 模型配置
├── scripts/
│   └── importLegacy.ts        # 导入旧 key
├── prisma/
│   ├── schema.prisma          # 数据库 Schema
│   └── migrations/            # 迁移文件
└── dev.db                      # SQLite 数据库
```
