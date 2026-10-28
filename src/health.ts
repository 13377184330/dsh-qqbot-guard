/**
 * 深度健康检查：探测 HTTP 状态接口，判定「进程活着但网关连接断了」的假死状态。
 *
 * 背景：NapCat 等 OneBot 实现里，承载机器人的子进程被宿主重开后，反向 WebSocket
 * 常常不再重连——端口在听、进程活着，但消息一条都收不到。只查端口发现不了这种
 * 假死，必须直接查网关的 connected 状态。
 */

import type { HealthConfig } from './types.js'

export interface ProbeResult {
  ok: boolean
  detail: string
}

/** 在任意嵌套对象里按路径取布尔值/字符串（支持 a.b.c） */
function digBool(obj: unknown, path: string): boolean | undefined {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  if (typeof cur === 'boolean') return cur
  if (typeof cur === 'string') {
    const s = cur.toLowerCase()
    if (s === 'true' || s === 'ok' || s === 'online' || s === 'listening') return true
    if (s === 'false' || s === 'failed' || s === 'offline' || s === 'error') return false
  }
  return undefined
}

/** 自动探测常见健康字段，返回是否健康 */
function autoJudge(obj: unknown): boolean | undefined {
  for (const path of ['gateway.connected', 'connected', 'data.status', 'status', 'ok', 'online']) {
    const v = digBool(obj, path)
    if (v !== undefined) return v
  }
  return undefined
}

export async function probe(cfg: HealthConfig): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
  try {
    const resp = await fetch(cfg.endpoint, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
    if (!resp.ok) {
      return { ok: false, detail: `HTTP ${resp.status}` }
    }
    const json: unknown = await resp.json()
    if (!json || typeof json !== 'object') {
      return { ok: false, detail: '响应不是 JSON 对象' }
    }
    const judge = cfg.healthyField
      ? digBool(json, cfg.healthyField)
      : autoJudge(json as Record<string, unknown>)
    if (judge === undefined) {
      // 没有明确的健康字段：HTTP 200 视为健康（保守，避免误杀）
      return { ok: true, detail: 'HTTP 200（未发现健康字段，视为健康）' }
    }
    return judge ? { ok: true, detail: '网关已连接' } : { ok: false, detail: '网关未连接（假死）' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: `探测失败：${msg}` }
  } finally {
    clearTimeout(timer)
  }
}