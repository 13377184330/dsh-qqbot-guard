// dsh-qqbot-guard 冒烟测试：mock 网关 + mock ctx，验证完整链路
// 运行（项目根）：node tests/smoke.mjs
import http from 'node:http'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { apply } from '../lib/index.js'

// 清掉上次测试残留的冷却状态（避免进入冷却影响断言）
try { rmSync('tests/.run/state.json', { force: true }) } catch {}

const PORT = 18991
let gatewayAlive = true // mock 网关连接状态（初始健康）

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ gateway: { connected: gatewayAlive } }))
})
await new Promise((r) => server.listen(PORT, r))

let tickFn = null
const logLines = []
const ctx = {
  config: {
    health: { endpoint: `http://127.0.0.1:${PORT}/api/state`, intervalMs: 60000, timeoutMs: 3000, maxFailures: 2 },
    rescue: {
      processName: 'NONEXISTENT_GUARD_TEST_PROC',
      command: ['node', '-e', 'console.log("guard-rescue-ran")'],
      retWaitMs: 100,
      restartWaitMs: 100,
      cooldownMs: 60000,
      stateDir: 'tests/.run', // 相对项目根（已 gitignore）
    },
  },
  logger: { info: (m) => logLines.push(m) },
  setInterval: (fn) => { tickFn = fn; return 1 },
}
apply(ctx)

const stateFile = 'tests/.run/state.json'
const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf-8')) : null)
const countRescues = () => logLines.filter((l) => l.includes('救援完成')).length

let passed = 0, failed = 0
const check = (name, cond) => { if (cond) { passed++; console.log(`  PASS ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

// 1. 健康时：不动作、不累计失败
await tickFn()
check('健康时不累计失败', (readState()?.failures ?? 0) === 0)

// 2. 假死一次：计数=1（未达阈值不救援）
gatewayAlive = false
await tickFn()
check('单次失败计数=1 且未救援', readState()?.failures === 1 && countRescues() === 0)

// 3. 恢复健康：计数清零（无需等冷却）
gatewayAlive = true
await tickFn()
check('恢复健康即清零', readState()?.failures === 0)

// 4. 再次假死并连续失败：触发救援 + 冷却
gatewayAlive = false
await tickFn()
await tickFn()
check('连续2次失败触发救援', countRescues() === 1)
check('救援执行了重启命令', logLines.some((l) => l.includes('已启动：node')))
const st1 = readState()
check('救援后记录冷却时间', !!st1 && st1.lastRescueAt > 0 && st1.failures === 0)

// 5. 冷却：下一次 tick 跳过，不二次救援
const rescuesBefore = countRescues()
await tickFn()
check('冷却中跳过（救援数不变）', countRescues() === rescuesBefore)
check('冷却日志已输出', logLines.some((l) => l.includes('冷却中，跳过')))

console.log(`\n结果：${passed} 通过，${failed} 失败`)
server.close()
process.exit(failed ? 1 : 0)