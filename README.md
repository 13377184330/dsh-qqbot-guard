# dsh-qqbot-guard

DeepSeek Harness 插件：**QQ 机器人（OneBot v11 系）假死自愈守卫**。

只查端口发现不了"假死"——这个插件直接探测网关的**连接健康**，断了自动重启，带防抖 + 冷却，全程无需人工。

## 它解决什么问题

NapCat / LLOneBot 等 OneBot 实现有一个非常经典的玄学故障：**QQ 进程活着、WebUI 端口在听，但机器人就是一条消息都不回**。

真实根因（2026-10 实测复现）：

- 承载机器人的 **utility 子进程会被 QQ 不定期重开**（无崩溃日志，Windows 事件查看器查不到）；
- 子进程重开后，**反向 WebSocket 永远不会自己重连**（OneBot 配置里的 `reconnectInterval` 形同虚设）；
- 于是出现"端口活、连接死"的假死状态——常规端口检测（`netstat`/`Test-Port`）发现不了，只能手动重启 QQ。

这个插件把"深度健康检查"做成 DSH 组合包：定期调 Bot 网关的状态接口，读 `connected` 之类的字段，**连接断了就自动执行重启**，并在重启后 15 分钟内绝不二次动手（防止把你正在扫码的登录窗口杀掉）。

## 特性

- **深度健康检查**：不止查端口，直接查网关状态（兼容 `gateway.connected`、`data.status`、`status`、`ok` 等常见字段，也可自定义字段路径）；
- **防抖**：连续 N 次探测失败才动手，避免机器人在服务刚重启、还没来得及重连时被误杀；
- **冷却**：一次救援后 15 分钟内绝不再动手，给快速登录/扫码留足时间（这是翻车总结，详见下文"冷却的由来"）；
- **状态持久化**：失败计数与上次救援时间写入本地文件，DSH 重启也不丢；
- **零运行时依赖**：只用了 Node 20+ 内置 `fetch`/`child_process`，无第三方包；
- 兼容 OneBot v11 系（NapCat / LLOneBot / Go-cqhttp 等）与任何暴露 JSON 状态接口的网关。

## 安装

### 方式一：本地 bundle（开发/自用）

```bash
git clone https://github.com/<you>/dsh-qqbot-guard.git
cd dsh-qqbot-guard
npm install          # 安装 typescript（dev 依赖）
npm run build        # 产出 lib/
dsh plugin --profile demo add ./dsh-qqbot-guard
dsh --profile demo
```

### 方式二：Git 直接安装（发布后）

```bash
dsh plugin --profile demo add github:<you>/dsh-qqbot-guard#<commit-sha>
```

> git 安装运行的是源码构建（`prepare` 脚本）；pnpm ≥10 首次安装会要求显式授权构建脚本：
> 把 pnpm 打印的包键加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 再执行一次即可。
> **只对可信源码授权，并固定 commit**。

### 方式三：npm 安装（发布后）

```bash
dsh plugin --profile demo add dsh-qqbot-guard
```

## 配置

默认配置在 `cordis.patch.yml`。在你自己 profile 的 `cordis.patch.yml`（后应用层胜出）覆盖即可：

```yaml
- id: qqbot-guard
  name: dsh-qqbot-guard
  config:
    health:
      endpoint: http://127.0.0.1:3001/api/state   # 你的网关状态接口
      intervalMs: 120000                            # 每 2 分钟查一次
      timeoutMs: 8000
      maxFailures: 2                               # 连续 2 次失败才动手
      # healthyField: gateway.connected            # 可选：自定义健康字段（点分路径）
    rescue:
      processName: QQ                              # 残留进程名（Windows 不带 .exe）
      command:                                     # 重启命令（argv 数组）
        - powershell.exe
        - -NoProfile
        - -ExecutionPolicy
        - Bypass
        - -File
        - D:\scripts\restart-qq-gateway.ps1
      retWaitMs: 3000
      restartWaitMs: 25000
      cooldownMs: 900000                           # 15 分钟冷却
      stateDir: ~/.dsh/dsh-qqbot-guard
```

字段说明：

| 键 | 默认 | 说明 |
|---|---|---|
| `health.endpoint` | `http://127.0.0.1:3001/api/state` | 网关状态 HTTP 接口 |
| `health.intervalMs` | `120000` | 轮询间隔 |
| `health.maxFailures` | `2` | 连续失败多少次触发救援 |
| `health.healthyField` | 自动 | 自定义健康字段路径（如 `gateway.connected`） |
| `rescue.processName` | `QQ` | 要清理的残留进程名 |
| `rescue.command` | 空 | 重启命令（argv 数组）——必填 |
| `rescue.retWaitMs` | `3000` | 杀进程后等待 |
| `rescue.restartWaitMs` | `25000` | 重启后等待（给登录/重连留时间） |
| `rescue.cooldownMs` | `900000` | 救援冷却（15 分钟） |
| `rescue.stateDir` | `~/.dsh/dsh-qqbot-guard` | 状态持久化目录 |

## 假死判定逻辑

1. `fetch(endpoint)` 超时（`timeoutMs`）或非 2xx → 记为一次失败；
2. 响应 JSON 里按顺序探测常见字段：`gateway.connected` → `connected` → `data.status` → `status` → `ok` → `online`；
   布尔 `true` / 字符串 `ok|online|listening` 视为健康，`false|failed|offline|error` 视为假死；
3. 找不到任何健康字段时**保守判健康**（HTTP 200 视为活）——避免误杀；
4. 连续 `maxFailures` 次失败 → 执行救援（清残留进程 → 跑重启命令）；
5. 救援后进入 `cooldownMs` 冷却，期间只记录不动作。

## 冷却的由来（血泪教训）

第一版插件没有冷却：某天下午 QQ 机器人连断 4 次，守卫每 4 分钟杀一次 QQ、重开等扫码——**用户根本来不及扫**，17:50 / 17:54 / 17:58 连杀三轮，把用户刚登录成功的窗口又杀掉。加冷却（15 分钟）后：重开 → 有 15 分钟窗口等快速登录/扫码，用户扫码完成，连接恢复，计数清零。

**如果你的机器人采用"快速登录"方式（无需扫码）且启动快，可以把 `cooldownMs` 调小；凡是需要人工扫码的，务必保留足够冷却。**

## 调试

- 插件日志走 DSH 的 `ctx.logger`，关键词 `[guard]`；
- 状态文件（`rescue.stateDir`）：`failures`（连续失败计数）、`lastRescueAt`（上次救援时间戳）。

## License

MIT