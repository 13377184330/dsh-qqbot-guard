/**
 * dsh-qqbot-guard 配置类型
 * 用户通过 profile 的 cordis.patch.yml 覆盖同名键即可（补丁会替换整个 config 值）
 */

export interface HealthConfig {
  /** 健康检查 HTTP 地址（Bot 网关状态接口 或 OneBot HTTP /get_status） */
  endpoint: string
  /** 轮询间隔 ms */
  intervalMs: number
  /** 单次探测超时 ms */
  timeoutMs: number
  /** 连续失败多少次触发救援 */
  maxFailures: number
  /** 期望响应为 JSON；可选校验的字段路径（点分，如 gateway.connected）——缺省自动探测常见字段 */
  healthyField?: string
}

export interface RescueConfig {
  /** 要清理的残留进程名（Windows 不含 .exe；Unix 用进程名） */
  processName: string
  /** 重启命令（argv 数组），如 ["powershell.exe", "-File", "restart.ps1"] */
  command: string[]
  /** 杀完进程后等待 ms */
  retWaitMs: number
  /** 重启命令发出后等待 ms（给登录/重连留时间） */
  restartWaitMs: number
  /** 救援冷却 ms：一次动手后该时长内绝不再动手（防误杀扫码窗口） */
  cooldownMs: number
  /** 状态持久化目录（防抖计数、上次救援时间），默认 ~/.dsh/dsh-qqbot-guard */
  stateDir: string
}

export interface PluginConfig {
  health: HealthConfig
  rescue: RescueConfig
}

export const DEFAULT_CONFIG: PluginConfig = {
  health: {
    endpoint: 'http://127.0.0.1:3001/api/state',
    intervalMs: 120_000,
    timeoutMs: 8_000,
    maxFailures: 2,
  },
  rescue: {
    processName: 'QQ',
    command: [],
    retWaitMs: 3_000,
    restartWaitMs: 25_000,
    cooldownMs: 900_000,
    stateDir: '~/.dsh/dsh-qqbot-guard',
  },
}

export interface GuardState {
  failures: number
  lastRescueAt: number
}

export function mergeConfig(raw: unknown): PluginConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const h = { ...DEFAULT_CONFIG.health, ...(src.health ?? {}) } as HealthConfig
  const r = { ...DEFAULT_CONFIG.rescue, ...(src.rescue ?? {}) } as RescueConfig
  return { health: h, rescue: r }
}