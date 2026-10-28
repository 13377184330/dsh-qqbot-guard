/**
 * dsh-qqbot-guard 插件入口
 *
 * DeepSeek Harness 组合包（bundle）。安装后随 profile 启动，定时做「深度健康检查」，
 * 发现 QQ 机器人假死（进程活着但网关连接断了）自动重启，带防抖与冷却。
 *
 * 使用：dsh plugin --profile <name> add dsh-qqbot-guard
 */

import type { PluginConfig } from './types.js'
import { mergeConfig } from './types.js'
import { probe } from './health.js'
import { inCooldown, loadState, saveState, rescue } from './rescue.js'

export const name = 'dsh-qqbot-guard'

export function apply(ctx: any): void {
  const cfg: PluginConfig = mergeConfig(ctx.config)
  const log = (msg: string) => (ctx.logger?.info?.(msg) ?? console.log(msg))

  let state = loadState(cfg.rescue)

  ctx.setInterval(async () => {
    // 冷却期：绝不动手（上一次救援后要留给快速登录/扫码）
    if (inCooldown(cfg.rescue, state)) {
      log(`[guard] 冷却中，跳过（上次救援于 ${new Date(state.lastRescueAt).toLocaleString()}）`)
      return
    }
    const result = await probe(cfg.health)
    if (result.ok) {
      if (state.failures > 0) {
        state.failures = 0
        saveState(cfg.rescue, state)
        log('[guard] 网关已恢复，失败计数清零')
      }
      return
    }
    // 连续失败累计，达到阈值且非冷却 → 救援
    state.failures += 1
    log(`[guard] 探测失败（${state.failures}/${cfg.health.maxFailures}）：${result.detail}`)
    if (state.failures >= cfg.health.maxFailures) {
      state.failures = 0
      const msg = await rescue(cfg.rescue, log)
      state.lastRescueAt = Date.now()
      saveState(cfg.rescue, state)
      log(`[guard] 救援完成：${msg}`)
    } else {
      saveState(cfg.rescue, state)
    }
  }, cfg.health.intervalMs)
}