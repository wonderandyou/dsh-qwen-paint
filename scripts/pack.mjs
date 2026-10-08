/**
 * dsh-qwen-paint — 打包（可重复执行）
 * ============================================================================
 * 产出：dist/(绘图)千问-<版本>-src.zip
 *
 * 做四件事（每一步都会打印结果，任一步不过就退出，绝不产出半成品）：
 *   ① 组装 dist/pkg —— 按**规则**收集该进包的文件（不用手写白名单，免得不维护）
 *   ② 发布前检查 —— 不许出现本机用户名 / 用户目录绝对路径 / 临时目录 / 会话残留
 *   ③ 语法自检 —— 每个 .js 都要过 node --check（含客户端那个非 ESM 的 client.js）
 *   ④ 压 zip → 解压到临时目录逐文件核对字节数 → 打印 SHA256 → 清理临时目录
 *
 * 用法：node scripts/pack.mjs
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const DIST = path.join(ROOT, 'dist')
const STAGE = path.join(DIST, 'pkg')
/**
 * 包名后缀：**默认不加 `-src`** —— 主人 2026-10-08 定的规矩：
 * 「以后我没有明确表明要发源码就不加 -src」。
 * 确实要发源码包时才显式加参数：`node scripts/pack.mjs --src`
 *
 * ⚠ meta.title 本身已经带括号（「(绘图)千问」），这里不要再套一层。
 */
const WANT_SRC = process.argv.includes('--src')
const ZIP_NAME = `${PKG.meta?.title ?? PKG.name}-${PKG.version}${WANT_SRC ? '-src' : ''}.zip`
const ZIP = path.join(DIST, ZIP_NAME)

/** 顶层必须进包的文件（少一个就报错，防止"少打包了文档"这种低级事故）。 */
const ROOT_FILES = ['package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'INSTALL.md']
/** 必须进包的目录。 */
const DIRS = ['lib', 'assets', 'scripts']
/** 收集时一律跳过的东西。 */
const SKIP = /(^|[\\/])(node_modules|dist|\.git|_backup[^\\/]*|__pycache__)([\\/]|$)|\.(log|zip|tmp)$/iu

/* ------------------------------------------------------------------ ① 组装 ---- */

console.log(`① 组装 ${path.relative(ROOT, STAGE)} …`)
fs.rmSync(STAGE, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })

const collected = []
function copyInto(absFrom, relTo) {
  const stat = fs.statSync(absFrom)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absFrom)) {
      const nextRel = path.join(relTo, entry)
      if (SKIP.test(nextRel)) continue
      copyInto(path.join(absFrom, entry), nextRel)
    }
    return
  }
  const target = path.join(STAGE, relTo)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(absFrom, target)
  collected.push({ rel: relTo.replace(/\\/g, '/'), bytes: stat.size })
}

for (const name of ROOT_FILES) {
  const abs = path.join(ROOT, name)
  if (!fs.existsSync(abs)) {
    console.error(`✗ 缺少必需文件：${name}`)
    process.exit(1)
  }
  copyInto(abs, name)
}
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) {
    console.error(`✗ 缺少必需目录：${dir}`)
    process.exit(1)
  }
  copyInto(abs, dir)
}
collected.sort((a, b) => a.rel.localeCompare(b.rel))
const totalBytes = collected.reduce((sum, f) => sum + f.bytes, 0)
console.log(`  ✓ ${collected.length} 个文件，共 ${(totalBytes / 1024).toFixed(0)} KB`)

/* ------------------------------------------------- ② 发布前检查（隐私 + 残留） ---- */

console.log('② 发布前检查 …')
const TEXT_EXT = /\.(js|mjs|cjs|json|md|yml|yaml|txt|py|html|css)$/iu
/** 这台机器的用户名 —— **运行时取**，脚本里不写死任何名字（写死了它自己就撞自己的规则）。 */
let LOCAL_USER = ''
try { LOCAL_USER = os.userInfo().username } catch (error) { /* 取不到就只查路径 */ }
/** 打包脚本自己必然含规则字面量，跳过它；其余文件一个不漏。 */
const SELF_REL = path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/')

/**
 * 一旦出现在包里，就说明带了"我这台机器"的痕迹。
 *
 * ⚠ `C:\Users\<你的用户名>` 这种**带尖括号的占位符**是文档的正规写法（README 里就是这么写的），
 *   所以用 `(?!<)` 放行占位符，只拦**真实**用户目录。
 * ⚠ 「开发机工作目录」那条用字符串拼出来 —— 直接写字面量的话它自己就会被自己匹配到。
 */
const FORBIDDEN = [
  LOCAL_USER === ''
    ? null
    : { re: new RegExp(LOCAL_USER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), why: `本机用户名（${LOCAL_USER}）` },
  { re: /C:\\+Users\\+(?!<)/iu, why: 'Windows 用户目录绝对路径（真实用户名）' },
  { re: new RegExp(`D:${'[\\\\/]+'}AI${'工作站'}`, 'iu'), why: '开发机工作目录' },
  { re: /AppData\\+Local\\+Temp/iu, why: '临时目录' },
  { re: /\.dsh[\\/]+sessions/iu, why: '会话记录路径' },
  { re: /sk-[A-Za-z0-9]{12,}/u, why: '疑似 API Key' },
].filter((rule) => rule !== null)
let privacyHits = 0
for (const file of collected) {
  if (!TEXT_EXT.test(file.rel)) continue
  if (file.rel === SELF_REL) continue
  const text = fs.readFileSync(path.join(STAGE, file.rel), 'utf8')
  for (const rule of FORBIDDEN) {
    if (!rule.re.test(text)) continue
    privacyHits += 1
    console.error(`  ✗ ${file.rel} 里出现${rule.why}`)
  }
}
if (privacyHits > 0) {
  console.error(`✗ 隐私检查没过（${privacyHits} 处），**没有产出 zip**。`)
  process.exit(1)
}
console.log('  ✓ 没有用户名 / 用户目录 / 临时目录 / 会话路径 / Key')

/* ------------------------------------------------------------------ ③ 语法 ---- */

console.log('③ 语法自检（node --check）…')
const scripts = collected.filter((f) => /\.(js|mjs|cjs)$/u.test(f.rel))
for (const file of scripts) {
  const res = spawnSync(process.execPath, ['--check', path.join(STAGE, file.rel)], { encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(`  ✗ ${file.rel} 语法不过：\n${res.stderr ?? ''}`)
    process.exit(1)
  }
}
console.log(`  ✓ ${scripts.length} 个脚本全部通过`)

/* ------------------------------------------------------------------ ④ 压缩 ---- */

console.log('④ 压缩 + 复核 …')
fs.rmSync(ZIP, { force: true })
const zipRes = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -CompressionLevel Optimal -Force`,
], { encoding: 'utf8' })
if (zipRes.status !== 0 || !fs.existsSync(ZIP)) {
  console.error(`✗ 压缩失败：\n${zipRes.stderr ?? ''}`)
  process.exit(1)
}

// 解压到临时目录，逐文件核对字节数 —— 只信"解出来的东西"
const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-pack-'))
const unRes = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Expand-Archive -Path '${ZIP}' -DestinationPath '${verifyDir}' -Force`,
], { encoding: 'utf8' })
if (unRes.status !== 0) {
  console.error(`✗ 解压复核失败：\n${unRes.stderr ?? ''}`)
  process.exit(1)
}
let verifyFail = 0
const unpacked = []
for (const file of collected) {
  const abs = path.join(verifyDir, file.rel)
  if (!fs.existsSync(abs)) {
    console.error(`  ✗ 解压后缺少：${file.rel}`)
    verifyFail += 1
    continue
  }
  const size = fs.statSync(abs).size
  unpacked.push(file.rel)
  if (size !== file.bytes) {
    console.error(`  ✗ ${file.rel} 字节数不一致：包内 ${file.bytes}，解出 ${size}`)
    verifyFail += 1
  }
}
fs.rmSync(verifyDir, { recursive: true, force: true })
if (verifyFail > 0) {
  console.error(`✗ 复核没过（${verifyFail} 项），zip 已留在 ${ZIP} 供排查。`)
  process.exit(1)
}
console.log(`  ✓ 解压后 ${unpacked.length} 个文件，字节数全部一致`)

const zipBytes = fs.statSync(ZIP).size
const sha = createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex')
console.log('')
console.log('✓ 打包完成')
console.log(`  文件：${ZIP}`)
console.log(`  大小：${(zipBytes / 1024).toFixed(0)} KB（${collected.length} 个条目）`)
console.log(`  SHA256：${sha}`)
console.log('')
console.log('  清单：')
for (const file of collected) {
  console.log(`    ${String((file.bytes / 1024).toFixed(1)).padStart(7)} KB  ${file.rel}`)
}
