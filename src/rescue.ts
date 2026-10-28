/**
 * 救援执行：清残留进程 → 重启命令 → 冷却与状态持久化。
 *
 * 防抖与冷却（血泪教训）：
 * - 防抖：连续 maxFailures 轮探测都失败才动手，避免 ds-bot 刚重启、网关还没重连时误杀；
 * - 冷却：一次救援后 cooldownMs 内绝不再动手——重启后的 QQ 需要快速登录/扫码，
 *   没有冷却会每几分钟杀一次正在等扫码的窗口（真实翻过车：17:50/17:54/17:58 连杀三轮）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { GuardState, RescueConfig } from './types.js'

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function stateFileOf(cfg: RescueConfig): string {
  const dir = expandHome(cfg.stateDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'state.json')
}

export function loadState(cfg: RescueConfig): GuardState {
  const f = stateFileOf(cfg)
  try {
    if (existsSync(f)) {
      const raw = JSON.parse(readFileSync(f, 'utf-8')) as Partial<GuardState>
      return { failures: Number(raw.failures) || 0, lastRescueAt: Number(raw.lastRescueAt) || 0 }
    }
  } catch {
    // 状态文件损坏不致命，从零开始
  }
  return { failures: 0, lastRescueAt: 0 }
}

export function saveState(cfg: RescueConfig, s: GuardState): void {
  try {
    writeFileSync(stateFileOf(cfg), JSON.stringify(s), 'utf-8')
  } catch {
    /* 写失败不阻塞救援 */
  }
}

export function inCooldown(cfg: RescueConfig, state: GuardState): boolean {
  if (!state.lastRescueAt) return false
  return Date.now() - state.lastRescueAt < cfg.cooldownMs
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function killProcess(name: string): Promise<string> {
  const isWin = process.platform === 'win32'
  return new Promise((resolve) => {
    const cmd = isWin ? 'taskkill' : 'pkill'
    const args = isWin
      ? ['/IM', name.endsWith('.exe') ? name : `${name}.exe`, '/T', '/F']
      : ['-f', name]
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    child.on('close', (code) => resolve(`已执行 ${cmd}（exit=${code ?? 'unknown'}）`))
    child.on('error', (e) => resolve(`杀进程失败：${e.message}`))
  })
}

async function runCommand(command: string[]): Promise<string> {
  if (!command || command.length === 0) {
    return '重启命令为空（rescue.command 未配置），跳过重启'
  }
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    child.unref()
    child.on('error', (e) => resolve(`重启命令启动失败：${e.message}`))
    // 命令本身是长驻进程时 close 不会很快触发，这里不等待 close，只等启动结果
    child.on('spawn', () => resolve(`已启动：${command.join(' ')}`))
  })
}

export async function rescue(cfg: RescueConfig, log: (msg: string) => void): Promise<string> {
  log(`[guard] 开始救援：清残留进程 ${cfg.processName}`)
  const killMsg = await killProcess(cfg.processName)
  log(`[guard] ${killMsg}`)
  await sleep(cfg.retWaitMs)
  const startMsg = await runCommand(cfg.command)
  log(`[guard] ${startMsg}`)
  await sleep(cfg.restartWaitMs)
  return `${killMsg}；${startMsg}`
}