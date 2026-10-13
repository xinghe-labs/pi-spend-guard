# pi-spend-guard

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

## 安装

```bash
pi install npm:pi-spend-guard
```

不改动 settings 直接试：

```bash
pi -e npm:pi-spend-guard
```

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

## 命令

| 命令 | 作用 |
|---|---|
| `/budget` | 查看花费、当前判定、生效配置 |
| `/budget set daily.block=20` | 修改阈值并持久化 |
| `/budget set session.warn=none` | 关掉单个档位 |
| `/budget set downgrade.model=deepseek-chat` | 指定降级目标模型 |
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

命令行参数：`--budget-config <path>` 指定另一个配置文件；`--no-budget` 让本次运行完全不拦截。

### 模型没有价格怎么办

如果 pi 不知道某个模型多少钱，它的预算就无法生效。把费率补进
`~/.pi/agent/models.json`（单位：美元 / 百万 token）：

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

当前模型没有价格时，`pi-spend-guard` 会在 session 开始时明确警告一次，
所以配置不当时不会出现「看起来有保护、其实没有」的情况。

## 工作原理

```
before_agent_start ──► 判定 ──► 降级（pi.setModel）
before_provider_request ──► 判定 ──► 拦截（ctx.abort）
message_end ──► 记录成本 ──► ledger.json
session_start ──► 加载配置与账本，模型无价格时警告
```

三个刻意的设计决定：

**session 花费每次从 session branch 重建，不在内存里累加。**
每次判定都遍历 `ctx.sessionManager.getBranch()`，同时累加 `message` 条目里的 assistant `usage` **和** `usage` 条目（cache warming 之类）。因此 fork、`/reload`、恢复会话得到的数字完全一致——内存计数器会漂移。而漏掉非 message 的 `usage` 条目会导致静默少算。

**provider 上报的成本永远优先于本地价目表。**
`Usage.cost.total` 反映了真实折扣、请求级阶梯价、以及 provider 侧的缓存定价，这些本地查表无从得知。价目表只是兜底，且兜底结果会标记 `"estimated": true`，让你分得清「实测成本」和「猜的成本」。

**拦截发生在 `before_provider_request`。**
这个钩子在**每一次** provider 调用前触发，包括单次 agent run 内部的每一轮后续请求，而不只是开头一次。降级单独放在 `before_agent_start`，保证便宜的模型对整轮运行生效。

## 局限

直说，因为一个悄悄失效的预算守卫比没有更糟：

- **模型在 pi 目录里没有价格时无法计量。** 只有当 provider 定义里带 `cost` 费率、或者 provider 自己上报了 usage 成本时，pi 才知道一个模型多少钱。两者都没有时，守卫会在 session 开始时明确告诉你一次，而不是假装在保护你。
- **daily / monthly 从扩展首次装上时开始累计。** 它们来自持久化账本，只认得「装了这个扩展之后跑过的会话」。session 花费没有这个缺口——它从 branch 重建。
- 只统计流经 pi 的花费，其他工具的用量看不到。
- 账本是本地 JSON 文件。没有同步、没有多机汇总、没有任何云端。

## 开发

```bash
npm install --ignore-scripts
npm test          # 106 个测试，不联网、不调用模型
npm run typecheck
```

`src/policy.ts`、`src/ledger.ts`、`src/config.ts`、`src/store.ts` 是纯函数且零依赖，所以可以脱离 agent 做穷尽测试。`test/extension.test.ts` 用一个假的 `ExtensionAPI` 驱动真实的扩展工厂，因此拦截路径在不花一分钱的情况下做到了端到端覆盖。

| 文件 | 职责 |
|---|---|
| `src/extension.ts` | pi 集成：hooks、flags、`/budget` 命令 |
| `src/policy.ts` | 阈值判定、严重度比较、模型选择 |
| `src/ledger.ts` | 成本运算、时间窗口、按价目表估算 |
| `src/config.ts` | 配置规范化与命令行覆盖 |
| `src/store.ts` | 原子、防御性的 JSON 持久化 |

## License

MIT
