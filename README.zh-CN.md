# pi-spend-guard

[![npm](https://img.shields.io/npm/v/pi-spend-guard)](https://www.npmjs.com/package/pi-spend-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/xinghe-labs/pi-spend-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/xinghe-labs/pi-spend-guard/actions/workflows/ci.yml)

**[pi](https://pi.dev) 的硬性预算守卫。** 超支前先警告、自动降级到便宜模型、必要时直接拦截请求。

pi 已经能告诉你花了多少。但没有任何东西阻止你花掉它。

---

## 问题在哪

pi 生态里不缺「显示花费」的扩展——状态栏、可观测性插件、用量面板。它们全是**只读**的。当 agent 在凌晨三点陷入循环、连续跑掉四十次工具调用时，一个状态栏不是控制手段。

`pi-spend-guard` 是控制手段。它读取 provider 真实上报的成本，然后逐级升级应对：

| 花费达到 | 会发生什么 |
|---|---|
| `warn` | 通知你 |
| `downgrade` | 本次运行切换到更便宜的模型 |
| `block` | 请求**在发出前就被中止** |

三个档位可分别配置，作用于三个维度：**session（本次会话）**、**daily（今日）**、**monthly（本月）**。

### 和「会话级花费上限」的区别

只做会话级上限是最常见的做法：一个限额，超了就中止。这留下两个缺口。

- **一次会话不等于一个计费周期。** 一天里五十次小会话，每一次都没超会话上限，
  但月度花费可能已经失控。本扩展从持久化账本里计算 `daily` 和 `monthly` 预算，
  与 `session` 并行生效。
- **中止是最后手段，不是第一手段。** 跨过软阈值时切换到更便宜的模型，让任务
  继续完成，而不是直接停掉。目前没有别的会话上限方案这么做。

此外，模型没有价格数据时会明确警告——这是唯一会让所有预算静默失效的故障模式。

## 从 npm 安装

```bash
pi install npm:pi-spend-guard
```

不改动 settings 直接试：

```bash
pi -e npm:pi-spend-guard
```

### 从 git 安装（不需要 npm 账号）

本扩展没有运行时依赖，所以可以直接从仓库安装：

```bash
pi install git:github.com/xinghe-labs/pi-spend-guard
```

两种方式行为完全一致，唯一区别是曝光：只有发布到 npm 的包才会出现在
[pi 扩展目录](https://pi.dev/packages) 里。

## 快速开始

装上就生效，默认阈值如下：

| 维度 | warn | downgrade | block |
|---|---|---|---|
| session | $2 | $5 | $10 |
| daily | $10 | $25 | $50 |
| monthly | $100 | $250 | $500 |

随时查看当前状态：

```
/budget
```

```
session $3.42   daily $11.80   monthly $63.10
Budget warning: $11.80 of $10.00 (daily)

enabled: true    block: true    retention: 120d
session warn $2       downgrade $5       block $10
daily   warn $10      downgrade $25      block $50
monthly warn $100     downgrade $250     block $500
downgrade: cheapest available
```

## 验证过的行为

拦截不是一句承诺，是可以直接观察的。把 `block` 设为 `0`：

```console
$ pi -ne -e ./src/extension.ts --budget-config ./examples/block-all.json -p "Reply with exactly: ok"
Request aborted
```

同一条命令换成正常预算，输出就是 `ok`。

预检估算会在请求**发出之前**拦住那个会越线的请求。下面这个例子里，模型在 pi 目录中
**完全没有价格**——只有守卫自己的 `pricing` 表能给它定价——而且此时花费还是 `$0`：

```console
$ PI_CODING_AGENT_DIR=/tmp/verify pi -ne -e ./src/extension.ts --budget-config /tmp/with-pricing.json -p "hi"
Request aborted
$ PI_CODING_AGENT_DIR=/tmp/verify pi -ne -e ./src/extension.ts --budget-config /tmp/no-pricing.json -p "hi"
Connection error.
```

同一个模型、同一套阈值、同样 `$0` 已花。唯一的差别就是那张 `pricing` 表，而这正是
「守卫真的在拦」和「守卫什么也没做」的分界。

## 命令

| 命令 | 作用 |
|---|---|
| `/budget` | 查看花费、当前判定、定价状态、生效配置 |
| `/budget set daily.block=20` | 修改阈值并持久化 |
| `/budget set session.warn=none` | 关掉单个档位 |
| `/budget set downgrade.model=deepseek-chat` | 指定降级目标模型 |
| `/budget set estimate.enabled=false` | 关闭预检估算 |
| `/budget set estimate.outputTokens=4096` | 估算时假定更长的回复 |
| `/budget on` / `/budget off` | 开关拦截 |
| `/budget reset` | 清空持久化账本 |
| `/budget models` | 按模型统计花费，从高到低 |

## 配置

配置文件位于 `<agent 目录>/pi-spend-guard/config.json`，通常是
`~/.pi/agent/pi-spend-guard/config.json`。完整示例见 [`examples/config.json`](./examples/config.json)。

```json
{
  "enabled": true,
  "limits": {
    "session": { "warn": 2, "downgrade": 5, "block": 10 },
    "daily":   { "warn": 10, "downgrade": 25, "block": 50 },
    "monthly": { "warn": 100, "downgrade": 250, "block": 500 }
  },
  "downgrade": {
    "enabled": true,
    "model": null,
    "preferProviders": ["deepseek"]
  },
  "block": { "enabled": true },
  "estimate": { "enabled": true, "outputTokens": 2048 },
  "pricing": {
    "my-provider/*": { "input": 0.5, "output": 1.5 }
  },
  "notify": { "onWarn": true, "onDowngrade": true, "onBlock": true },
  "retentionDays": 120
}
```

要点：

- 省略某个维度 = 继承默认值；写成 `null` = 完全关闭该维度。
- 省略单个档位 = 继承默认值；写成 `null` = 只关闭该档位。
- `0` 是有效阈值，会立即触发。
- `block.enabled: false` 保留警告但永不中止，适合先试跑一段时间。
- `downgrade.model` 优先于 `preferProviders`；两者都不设则自动选当前可用的最便宜模型。
- `estimate` 控制预检估算。它需要价格才能工作，没有价格时自动退化为「只按已花金额」判定。
- `pricing` 是守卫自己的费率表，用于 pi 没有价格的模型。

命令行参数：`--budget-config <path>` 指定另一个配置文件；`--no-budget` 让本次运行完全不拦截。

### 定价：守卫怎么知道一个模型多少钱

成本按三步解析，可信度从高到低：

1. **provider 上报的金额。** `Usage.cost.total` 反映了真实折扣、请求级阶梯价、以及
   provider 侧的缓存定价，这些本地查表无从得知。
2. **你的 `pricing` 表**，写在守卫自己的配置里。
3. **pi 的模型目录**——`~/.pi/agent/models.json` 里模型定义上的 `cost`。

之所以需要第 2、3 步，是因为第 1 步经常什么都不报：本地网关、自建代理，以及任何 pi
没有内置价格的模型都属于这种情况。

```json
{
  "pricing": {
    "workbuddy/global:glm-5.3": { "input": 0.27, "output": 1.1 },
    "workbuddy/*": { "input": 0.5, "output": 1.5 },
    "deepseek-chat": { "input": 0.28, "output": 0.42 },
    "*": { "input": 1, "output": 3 }
  }
}
```

费率单位是**美元 / 百万 token**。键的匹配顺序是从最具体到最宽松：
`provider/model` → `provider/*` → 裸 `model` → `*`。一个完全定不了价的条目
（费率全为 0）会被跳过，而不是让它遮蔽更宽松的键。省略 `cacheRead` /
`cacheWrite` 时回退到 `input` 费率；需要按 token 阈值阶梯计费的模型可以写
`tiers`：

```json
{
  "pricing": {
    "anthropic/claude-sonnet": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "tiers": [{ "inputTokensAbove": 200000, "input": 6, "output": 22.5 }]
    }
  }
}
```

一个实用的价目来源是 [models.dev](https://models.dev) —— 它的
[`api.json`](https://models.dev/api.json) 收录了数百个 provider 的价格。请取模型的
**第一方**条目（provider `zai`、`deepseek`、`moonshotai` 等），而不是转售商的，并务必
**显式写上 `cacheWrite`**：配置表在缺省时会把 `cacheWrite` 回退到 `input` 费率，而像 Kimi
K3（缓存写 $3/Mtok，与 input 相同碰巧无害）或 GLM（缓存写真的是 $0，缺省会被多计 50 倍）
这样的模型，省略这个字段可能错上几个数量级。

也可以把费率写回它本该待的地方——pi 模型目录：

```json
{
  "providers": {
    "my-provider": {
      "models": [
        {
          "id": "my-model",
          "cost": { "input": 0.5, "output": 1.5, "cacheRead": 0.05, "cacheWrite": 0.5 }
        }
      ]
    }
  }
}
```

**如果一个请求哪里都定不了价，守卫不会假装它是免费的。** 这条记录会带上
`"unpriced": true` 落盘，session 开始时会有一句警告直接点出模型名和该加的配置键，
`/budget` 也会报告账本里有多少条无价记录。「价格未知」和「真的是 0」是两回事，
账本会把它们分开。

### 预检估算

只看「已花金额」的判定，只能在钱花掉**之后**才拦住请求。开启 `estimate`（默认开启）后，
守卫还会预估即将发出的这个请求本身要花多少，如果这个预估值会越线，就直接在发出前拦住。
可直接运行的示例见 [`examples/estimate.json`](./examples/estimate.json)：

```console
$ pi -ne -e ./src/extension.ts --budget-config ./examples/estimate.json -p "hi"
Request aborted
```

一分钱都没花——请求被拦下时 `session spend` 还是 `$0`。拦截文案会区分这两种情况，
不会把「还没花」说成「已经花超」：

```
Budget: this request (~$0.0033) would take session spend to $0.0033, past the $0.001 limit — blocked before sending
```

预估用当前上下文大小作为输入 token，用 `estimate.outputTokens`（默认 `2048`）作为输出
token。这个假设是刻意保守的：`maxTokens` 是模型的**上限**而不是典型回复长度，拿它来估算
会拦住那些本来便宜得多的请求。想要纯粹的「只按已花金额」判定，把
`estimate.enabled` 设为 `false`；想更保守就调大 `estimate.outputTokens`。

估算需要价格。上下文大小或费率缺失时，它会退化为只按已花金额判定，而不是凭空编一个数字。

## 工作原理

```
before_agent_start ──► 判定 ──► 降级（pi.setModel）
before_provider_request ──► 预估成本 ──► 判定 ──► 拦截（ctx.abort）
message_end ──► 解析成本 ──► ledger.json
session_start ──► 加载配置与账本，模型无价格时警告
```

四个刻意的设计决定：

**session 花费每次从 session branch 重建，不在内存里累加。**
每次判定都遍历 `ctx.sessionManager.getBranch()`，同时累加 `message` 条目里的 assistant `usage` **和** `usage` 条目（cache warming 之类）。因此 fork、`/reload`、恢复会话得到的数字完全一致——内存计数器会漂移。而漏掉非 message 的 `usage` 条目会导致静默少算。

**provider 上报的成本永远优先于本地价目表。**
`Usage.cost.total` 反映了真实折扣、请求级阶梯价、以及 provider 侧的缓存定价，这些本地查表无从得知。价目表只是兜底，且兜底结果会标记 `"estimated": true`，让你分得清「实测成本」和「猜的成本」。

**拦截发生在 `before_provider_request`。**
这个钩子在**每一次** provider 调用前触发，包括单次 agent run 内部的每一轮后续请求，而不只是开头一次。降级单独放在 `before_agent_start`，保证便宜的模型对整轮运行生效。

**拦截是预防性的，而不只是事后记账。**
发送之前，守卫会预估这个请求本身的成本并加到所有维度上。会越线的请求会在花费仍然低于
阈值时就被拦住，而且文案会如实说明——写「would take session spend to $X」，而不是谎称
你已经花超了。预估是失败安全的：拿不到上下文大小或费率时它返回 `0`，退回按已花金额判定，
而不是猜一个可能误拦好请求的数字。

## 局限

直说，因为一个悄悄失效的预算守卫比没有更糟：

- **哪里都定不了价的模型无法计量。** provider 上报的成本、`pricing` 表、模型目录按这个顺序依次查。三者都没声音时，守卫会在 session 开始时说明，把该次调用标成 `"unpriced": true`，并在 `/budget` 里报告——它绝不会把「价格未知」当成 `$0` 然后宣称预算已生效。
- **预检估算终究是估算。** 它假定输出长度为 `estimate.outputTokens`；很长的回复可能超出预估，只能在**下一次**调用时才被拦住。它是护栏，不是对单个请求的硬上限。
- **daily / monthly 从扩展首次装上时开始累计。** 它们来自持久化账本，只认得「装了这个扩展之后跑过的会话」。session 花费没有这个缺口——它从 branch 重建。
- 只统计流经 pi 的花费，其他工具的用量看不到。
- 账本是本地 JSON 文件。没有同步、没有多机汇总、没有任何云端。

## 开发

```bash
npm install --ignore-scripts
npm test          # 142 个测试，不联网、不调用模型
npm run typecheck
```

`src/policy.ts`、`src/ledger.ts`、`src/config.ts`、`src/pricing.ts`、`src/store.ts` 是纯函数且零依赖，所以可以脱离 agent 做穷尽测试。`test/extension.test.ts` 用一个假的 `ExtensionAPI` 驱动真实的扩展工厂，因此拦截路径在不花一分钱的情况下做到了端到端覆盖。

| 文件 | 职责 |
|---|---|
| `src/extension.ts` | pi 集成：hooks、flags、`/budget` 命令 |
| `src/policy.ts` | 阈值判定、严重度比较、模型选择 |
| `src/pricing.ts` | 费率解析：配置表 → 模型目录，通配符与阶梯价 |
| `src/ledger.ts` | 成本运算、时间窗口、按价目表估算 |
| `src/config.ts` | 配置规范化与命令行覆盖 |
| `src/store.ts` | 原子、防御性的 JSON 持久化 |

## License

MIT
