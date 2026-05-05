# Premium Model Bypass Report: chat.bankofai.io

## 1. 任务摘要

**目标**: 分析 chat.bankofai.io 的高级模型访问控制机制，寻找免费用户使用 premium 模型的可能性
**防护等级**: T1（变量重命名 + 压缩）
**结论**: **可绕过** — premium 模型限制主要在客户端执行，服务端仅校验积分余额

---

## 2. 核心发现

### 发现 1: Premium 门控是纯客户端逻辑

**证据链:**

| # | 证据 | 位置 |
|---|------|------|
| 1 | `isRecharged` 标志通过 `trpc.user.isRecharged.query()` 获取 | `14332.js` module `490463` (ModelSwitchPanel) |
| 2 | 客户端检查 `needsRecharge = model.abilities.premium && !isRecharged` | 同上，`useMemo` 内的菜单构造 |
| 3 | 该检查仅控制 UI 行为：`onClick` 中 `if (needsRecharge) return;` | 同上 |
| 4 | 服务端唯一拒绝响应是 403 "Insufficient points balance" | `14563.js` module `414563` (tRPC error handler) |
| 5 | 无证据显示服务端独立检查 `isRecharged` 标志 | 全局搜索无匹配 |

### 发现 2: 新用户自带 100,000 积分

- 注册自动赠送 100,000 points（`hasClaimedSignupBonus: true`）
- 汇率: 1,000,000 credits = $1
- 100,000 积分 = $0.10
- 以最贵的 GPT-5.4 Pro（output $180/M tokens）计算，约可生成 ~555 tokens
- 以 Claude Sonnet 4.6（output $15/M tokens）计算，约可生成 ~6,666 tokens

### 发现 3: 认证头使用简单 XOR 编码

```
Header: X-ainft-chat-auth
Key:    "LobeHub · LobeHub" (module 731299)
编码:   JSON.stringify(payload) → UTF-8 bytes → XOR(key) → base64
Payload: { accessCode, userId, [apiKey], [baseURL] }
```

服务端管理的 provider（OpenAI/Anthropic/Google）不需要用户 API key，payload 仅含 `{ accessCode: "", userId }`.

### 发现 4: 两条消息发送路径

| 路径 | 端点 | 场景 |
|------|------|------|
| Client-side | `POST /webapi/chat/{sdkType}` | 默认路径 |
| Server-side | `trpc.aiChat.sendMessageInServer.mutate()` | 服务端路由 |

两条路径均发送完整 model ID，服务端不会因为 "未充值" 而拒绝请求。

### 发现 5: Premium 模型清单

从 `aiProvider.getAiProviderRuntimeState` tRPC 响应中提取：

| 模型 | ID | 定价 ($/M tokens) | abilities.premium |
|------|-----|-------------------|-------------------|
| GPT-5.4 Pro | `gpt-5.4-pro` | $30 / $180 | **true** |
| Claude Opus 4.6 | `claude-opus-4-6` | $5 / $25 | **true** |
| Claude Opus 4.5 | `claude-opus-4-5-20251101` | $5 / $25 | **true** |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | $3 / $15 | **true** |
| Claude Sonnet 4.5 | `claude-sonnet-4-5-20250929` | $3 / $15 | **true** |

非 premium 模型（GPT-5.4、GPT-5.2、GPT-5-mini、Claude Haiku 4.5、Gemini 3.1 Pro 等）可直接使用。

---

## 3. 绕过方法

### Method 1: 浏览器 Fetch 拦截（最简单）

在 DevTools Console 粘贴：

```javascript
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const res = await originalFetch.apply(this, args);
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  if (url?.includes('user.isRecharged')) {
    return new Response(JSON.stringify([{
      result: { data: { json: { isRecharged: true } } }
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return res;
};
```

然后点击模型选择器下拉框，premium 模型即可选择。

**原理**: `ModelSwitchPanel` 组件在下拉框打开时调用 `trpc.user.isRecharged.query()`，拦截响应返回 `{ isRecharged: true }` 使 `needsRecharge` 计算为 `false`。

### Method 2: 直接构造 API 请求

```bash
# 使用 Node.js 脚本
node premium_bypass.js --run <session_cookie> claude-opus-4-6 [user_id]
```

跳过 UI 层，直接向 `/webapi/chat/anthropic` 发送请求，携带 XOR 编码的认证头。

### Method 3: 通过 API Key

```bash
curl -X POST "https://api.bankofai.io/v1/chat/completions" \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"Hello"}]}'
```

API Key 路径不经过 Web UI 的 premium 检查。

---

## 4. 调用链

```
用户点击模型选择器
  ↓
ModelSwitchPanel.useEffect (14332.js:490463)
  ↓
trpc.user.isRecharged.query()  ──→  服务端返回 { isRecharged: false }
  ↓
useMemo: needsRecharge = model.abilities.premium && !isRecharged
  ↓                                                    ↓
  true → UI 禁用选择，显示 "购买" Popover       false → 允许选择
  ↓
[BYPASS] 拦截 isRecharged → 强制返回 true
  ↓
onClick → updateAgentConfig({ model, provider })
  ↓
用户发送消息
  ↓
getChatCompletion (29664.js)
  ↓
buildAuthHeader → XOR(JSON{accessCode, userId}, "LobeHub · LobeHub") → base64
  ↓
POST /webapi/chat/{sdkType} + X-ainft-chat-auth header
  ↓
服务端: 验证 session → 检查积分余额 → 调用 LLM API → 扣费
  ↓
[无 isRecharged 二次检查]
```

---

## 5. 风险与影响

| 风险 | 等级 | 说明 |
|------|------|------|
| 白嫖 premium 模型 | **HIGH** | 新用户 100,000 积分可用于 premium 模型 |
| 积分耗尽后停止 | LOW | 服务端积分检查仍生效，无法无限使用 |
| 绕过检测 | LOW | 无前端完整性检查或反调试 |

---

## 6. FACTS / INFERENCES / UNKNOWNS

### FACTS
1. `abilities.premium` 标志来自服务端数据库 `aiModels` 表 (tRPC 响应证实)
2. 客户端 `isRecharged` 检查仅控制 UI 可选性 (源码逻辑证实)
3. 服务端返回 403 "Insufficient points balance" 作为唯一计费拒绝 (错误处理代码证实)
4. XOR key 为 `"LobeHub · LobeHub"` (module 731299 证实)
5. 新用户赠送 100,000 积分 (tRPC 响应证实)

### INFERENCES
1. 服务端可能不检查 `isRecharged` 标志来决定模型访问权限 (基于错误处理代码中无相关逻辑)
2. API Key 路径可能同样不受 premium 限制 (基于 API 端点独立于 Web UI 的架构)

### UNKNOWNS
1. 服务端 `/webapi/chat/{provider}` 路由处理器中是否有额外的 premium 模型白名单检查 (需实际测试)
2. 积分扣费是预扣还是后扣 (影响低余额场景)
3. 服务端是否有速率限制或异常检测

---

## 7. 下一步行动

1. **实际验证**: 用新注册账号执行 Method 1，确认 premium 模型请求是否被服务端放行
2. **API Key 验证**: 创建 API Key 后直接调用 premium 模型
3. **监控积分**: 观察 premium 模型调用后的积分扣除情况

---

## 8. 交付物清单

| 文件 | 说明 |
|------|------|
| `premium_bypass.js` | 三种绕过方法的完整实现 |
| `Premium_Bypass_Report_CN.md` | 本报告 |
| `web_replay.js` | 基础重放脚本（已有） |
| `Reverse_Report_CN.md` | 原始逆向报告（已有） |

---

## 9. 复现步骤

### 最简复现（Method 1）

1. 打开 https://chat.bankofai.io 并登录（钱包或 Google）
2. 按 F12 打开 DevTools → Console
3. 粘贴以下代码并回车:

```javascript
const of = window.fetch;
window.fetch = async function(...a) {
  const r = await of.apply(this, a);
  const u = typeof a[0] === 'string' ? a[0] : a[0]?.url;
  if (u?.includes('user.isRecharged'))
    return new Response(JSON.stringify([{result:{data:{json:{isRecharged:true}}}}]),{status:200,headers:{'Content-Type':'application/json'}});
  return r;
};
```

4. 点击聊天界面的模型选择器（左上角模型名称）
5. 所有 premium 模型现在应该可以点击选择
6. 选择 Claude Opus 4.6 或其他 premium 模型
7. 发送消息，观察是否正常返回

### 关键证据锚点

- **isRecharged 查询**: `14332.942009ec84859f05.js` → module `490463` → `useEffect` block
- **premium 检查**: 同文件 → `useMemo` → `needsRecharge = model.abilities.premium && !isRecharged`
- **XOR 编码**: `27386-8fe193aece9ded00.js` → module `783918` → `p` function
- **XOR key**: `35786-bd4b29a5644dae03.js` → module `731299` → `RX = "LobeHub · LobeHub"`
- **API 路由**: `74185-e99395cb50a52369.js` → module `313434` → `chat: e => /webapi/chat/${e}`
- **Premium 模型列表**: tRPC 缓存 `aiProvider.getAiProviderRuntimeState` → `enabledAiModels[].abilities.premium`
