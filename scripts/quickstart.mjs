/**
 * 一键安装（给不想碰命令行的用户；也可以直接让 DSH 跑这一条）。
 *
 * ============================================================================
 * 它做三件事：
 *   ① **自报身份** —— 打印版本号 + 关键文件的 SHA256 前 12 位。
 *      ★ 这一条是踩过坑才加的：有人把新包解压到**已存在的目录**里，
 *        解压工具**跳过了同名文件**，于是 setup.mjs 还是旧的 ——
 *        他却以为自己用的是新包，还奇怪"怎么参数不认" ✗
 *        现在：脚本一开口就自报指纹，跟对方手上的包对一下就知道是不是同一份 ✓
 *   ② **先检测**（--check，不下载任何东西、不改任何设置）
 *   ③ 问一句，确认之后才真装
 *
 * ⚠ 它**不替你装 Python** —— 那属于动系统，只提示命令。
 * ============================================================================
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SETUP = path.join(HERE, 'setup.mjs')

const line = (text = '') => process.stdout.write(`${text}\n`)
const rule = () => line('='.repeat(66))

/** 跑一个子进程，输出直接透传给用户。 */
function run(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/** 关键文件的指纹（用来核对"这到底是哪一版"）。 */
function fingerprint(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
  } catch {
    return '(读不到)'
  }
}

/** 读包版本。 */
function version() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '?'
  } catch {
    return '?'
  }
}

rule()
line('  (绘图)千问 —— 一键安装')
rule()
line()
line(`  包版本      ：${version()}`)
line(`  setup.mjs   ：${fingerprint(SETUP)}   ← 核对指纹，确认你手上就是这一份`)
line(`  运行目录    ：${ROOT}`)
line()
line('  ⚠ 如果你以为用的是新包、但指纹对不上：多半是解压到了已经存在的目录，')
line('    解压工具跳过了同名文件。请**解压到一个全新目录**再跑。')
line()

// ── 依赖检查 ──────────────────────────────────────────────────────────────
line(`  Node.js     ：${process.version} ✓`)
line()

// ── 第一步：检测 ─────────────────────────────────────────────────────────
line('─'.repeat(66))
line('  第一步：检测（只打印，不下载、不改任何东西）')
line('─'.repeat(66))
line()

const first = await run([SETUP, '--check'])

line()
line('─'.repeat(66))
line('  检测结束。')
line()

if (first !== 0) {
  line('  检测没能走完（上面的输出里写了卡在哪）。常见两种：')
  line('    · 显卡认不出来 —— 按提示加 --amd 或 --nvidia 再跑一次')
  line('    · 缺少 Python 3.12 —— AMD 的 Windows 包只支持 cp312，需要先装：')
  line('        winget install --id=Python.Python.3.12 -e')
  line()
  line('  ★ 想单独重跑某一步，可以直接用：')
  line(`      node scripts/setup.mjs --check`)
  line(`      node scripts/setup.mjs --amd --check     （AMD 卡，或显卡认不出来时）`)
  line()
  process.exit(1)
}

// ── 第二步：真装（要确认）────────────────────────────────────────────────
line('  检测通过。')
line()
line('  ⚠ 真正安装会下载：')
line('      · AMD 卡：ROCm 版 PyTorch 约 3 GB + 三个模型约 13.3 GB')
line('      · N 卡 ：ComfyUI 便携包 + 三个模型约 13.3 GB')
line('    中途断了不要紧，直接重跑会**接着下**。')
line()

if (!process.stdin.isTTY) {
  line('  （当前不是交互终端，没得到确认 → 不执行）')
  line(`  要装的话请自己跑：node scripts/setup.mjs --yes`)
  line()
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question('  现在开始安装吗？(y/N) ')
rl.close()
line()

if (!answer.trim().toLowerCase().startsWith('y')) {
  line('  好，先不装。想装的时候再跑一次这个脚本，或者直接：')
  line('      node scripts/setup.mjs --yes')
  line()
  process.exit(0)
}

line('─'.repeat(66))
line('  第二步：开始安装')
line('─'.repeat(66))
line()

const second = await run([SETUP, '--yes'])
line()
if (second === 0) {
  rule()
  line('  ✓ 装完了')
  rule()
  line()
  line('  接下来：**重启那个程序**（关掉 DSH 窗口再打开），插件才会加载。')
  line('  然后说一句「画一只橘猫」试试。')
  line()
  line('  ⚠ A 卡用户特别注意：出第一张图后**一定要人眼看一眼**是不是正常图 ——')
  line('    A 卡可能"静默出错"：跑得飞快、日志也不报错，出来的却是噪点 / 全黑 / 颜色错。')
  line()
} else {
  line('  安装没能走完，看上面的输出。修好之后重跑这个脚本即可（已完成的步骤会跳过）。')
  line()
}
process.exit(second)
