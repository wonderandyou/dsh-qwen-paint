/**
 * 端到端验证「空闲关停」真的能把 ComfyUI 关掉。
 * ============================================================================
 * 为什么单独写这个：`scripts/selftest.mjs` 里**刻意只测到"决定要关"之前**
 * （用 mock status 让 probe=false 或 queueBusy=true），**绝不在自测里真去杀进程** ——
 * 万一判据写错，自测就会误杀主人正在用的 ComfyUI。
 *
 * 所以这一步单独、显式地在**真的 ComfyUI** 上跑一次，验证完整链路：
 *   探活 → 记活动 → 等超时 → 过两关（在线 + 队列空）→ 识别进程 → Stop-Process → 复探确认已关
 *
 * 用法（先把 ComfyUI 启动起来）：
 *   node scripts/_verify-idle-shutdown.mjs
 * ============================================================================
 */

import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { DEFAULTS, makeComfyStatus, makeIdleShutdown } = mod.__internal

/** 故意把超时压到 2 秒，好在几秒内看到结果。 */
const cfg = { ...DEFAULTS, statusCacheMs: 0, idleShutdownMs: 2000 }
const log = (level, message) => console.log(`     [${level}] ${message}`)
const status = makeComfyStatus(cfg)

console.log('1) 探活：ComfyUI 在不在')
const online = await status.probe(true)
console.log(`     online = ${online}`)
if (!online) {
  console.log('\n✗ ComfyUI 没在跑。先双击 D:\\ComfyUI\\启动ComfyUI.bat，等服务起来再跑本脚本。')
  process.exit(2)
}

console.log('2) 队列状态（非空的话空闲关停会续期、不会关）')
const busy = await status.queueBusy()
console.log(`     busy = ${busy}`)

const idle = makeIdleShutdown(cfg, log, status)

console.log('3) 从没出过图时 tick —— 应当 false（保护主人自己开的 ComfyUI）')
const firstTick = await idle.tick()
console.log(`     => ${firstTick}    idleShutdownInMs=${idle.idleShutdownInMs()}`)

console.log('4) 记一次活动（等价于"刚出完图"），等 3 秒让它超过 2 秒的门槛')
idle.touch()
await new Promise((resolve) => setTimeout(resolve, 3000))
console.log(`     idleShutdownInMs=${idle.idleShutdownInMs()}（应当已经是 0）`)

console.log('5) tick —— 这一步会真的去识别进程并关掉它')
const closed = await idle.tick()
console.log(`     => ${closed}`)

await new Promise((resolve) => setTimeout(resolve, 2500))
const stillOnline = await status.probe(true)
console.log(`6) 关掉之后再探活：online = ${stillOnline}（应当是 false）`)

const pass = firstTick === false && closed === true && stillOnline === false
console.log(`\n${pass ? '★ 空闲关停链路端到端实测通过 ✓' : '✗ 没有按预期工作'}`)
process.exit(pass ? 0 : 1)
