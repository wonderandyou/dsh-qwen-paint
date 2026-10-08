/**
 * dsh-qwen-paint — 安装 / 卸载 / 自检
 * ============================================================================
 * 官方首选路径是 DSH 自己的 Plugin Manager（`plugin_manager` 的 `install_bundle`，
 * target = 本包绝对目录），它自己完成"装包 + 写 profile 的 package.json + 挂进
 * bundle"这三件事，官方文档明确写着**不要用 shell 命令替代**。
 *   等价的 CLI：`dsh plugin --profile desktop add link:<本目录>`
 *   ——⚠ desktop profile 必须**完全退出 DSH** 才能跑 CLI（运行时会被拒）。
 *
 * 本脚本是**兜底**路径：做与官方等价的两件事 + 一个 Junction，并且：
 *   · 改前把 profile 的 package.json 备份到 profile 下的时间戳目录
 *   · 改后**真的去 import 一次插件入口**（ESM 语法错、依赖解析失败会当场暴露，
 *     不会留到重启后让 DSH 起不来）
 *   · 验证不过就**自动回滚**，并把备份留着
 *   · 幂等：重复跑不会重复加
 *   · 绝不重启 DSH（重启会掐断主人正在跑的会话 —— 时机交给主人）
 *
 * 用法（在插件目录下）：
 *   node scripts/install.mjs               安装到 desktop profile（默认）
 *   node scripts/install.mjs --profile web  装到别的 profile
 *   node scripts/install.mjs --uninstall    卸载
 *   node scripts/install.mjs --dry-run      只打印将要做的事
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 && args[profileIndex + 1] ? args[profileIndex + 1] : 'desktop'
const uninstall = args.includes('--uninstall')
const dryRun = args.includes('--dry-run')

/** 装进 profile 的依赖写法：pnpm 的 link: 协议，与 dsh-whale-widget 同款。 */
const LINK_SPEC = `link:${ROOT.replace(/\\/g, '/')}`

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/**
 * 真去 import 一次插件入口，确认它能被 Node 加载且导出形状正确。
 * 这一步能抓住：ESM 语法错、顶层抛错、import 了不存在的包（解析失败）。
 */
function verifyEntryLoads() {
  const entry = pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href
  const probe = [
    `import(${JSON.stringify(entry)})`,
    '.then((m) => {',
    "  if (typeof m.apply !== 'function') { console.error('缺 apply 导出'); process.exit(3) }",
    // 注意：cordis 插件名（模块导出的 name）与 npm 包名**本来就不同**
    //（qwen-paint vs dsh-qwen-paint），所以这里只校验它存在且是非空字符串。
    "  if (typeof m.name !== 'string' || m.name.length === 0) { console.error('导出 name 缺失或不是字符串'); process.exit(2) }",
    "  console.log('entry-ok cordis-name=' + m.name)",
    '})',
    ".catch((e) => { console.error('加载失败：' + (e && e.message ? e.message : e)); process.exit(1) })",
  ].join('\n')
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' })
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() }
}

/** 检查 profile 里插件行的当前状态。 */
function inspectProfile(pkgFile) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  const bundles = pkg.dsh?.profile?.bundles
  return {
    pkg,
    inDeps: Object.hasOwn(pkg.dependencies ?? {}, PKG.name),
    inBundles: Array.isArray(bundles) && bundles.includes(PKG.name),
    bundlesIsArray: Array.isArray(bundles),
  }
}

/* ------------------------------------------------------------------ 主流程 ---- */

console.log(`插件　：${PKG.name}@${PKG.version}　（${PKG.meta?.title ?? ''}）`)
console.log(`目录　：${ROOT}`)
console.log(`profile：${profile}　（DSH_HOME=${DSH_HOME}）`)
console.log('')

const profileDir = path.join(DSH_HOME, 'profiles', profile)
const pkgFile = path.join(profileDir, 'package.json')
const linkPath = path.join(profileDir, 'node_modules', PKG.name)

if (!fs.existsSync(pkgFile)) {
  console.error(`✗ 找不到 ${pkgFile} —— profile 名字对不对？`)
  process.exit(1)
}

const before = inspectProfile(pkgFile)
if (!before.bundlesIsArray) {
  console.error('✗ profile 的 dsh.profile.bundles 不是数组，停手不动它。')
  process.exit(1)
}

if (dryRun) {
  console.log(`（--dry-run）将要做的事：`)
  console.log(`  1. 备份 ${pkgFile} → ${profileDir}\\_backup-${PKG.name}-<时间戳>\\`)
  console.log(`  2. dependencies["${PKG.name}"] = "${LINK_SPEC}"`)
  console.log(`  3. dsh.profile.bundles ${uninstall ? '移除' : '加入'} "${PKG.name}"`)
  console.log(`  4. Junction：${linkPath} → ${ROOT}`)
  console.log(`  5. import 一次入口验证可加载`)
  process.exit(0)
}

/* ---- 卸载 ---- */
if (uninstall) {
  const backupDir = path.join(profileDir, `_backup-${PKG.name}-uninstall-${timestamp()}`)
  fs.mkdirSync(backupDir, { recursive: true })
  fs.copyFileSync(pkgFile, path.join(backupDir, 'package.json'))
  const pkg = before.pkg
  delete pkg.dependencies?.[PKG.name]
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((n) => n !== PKG.name)
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false })
  if (stat) {
    if (stat.isSymbolicLink()) fs.unlinkSync(linkPath)
    else fs.rmSync(linkPath, { recursive: true, force: true })
  }
  console.log(`✓ 已卸载：依赖、bundles、node_modules 链接都已移除`)
  console.log(`  备份：${backupDir}`)
  console.log('  ★ 重启 DSH 后生效。')
  process.exit(0)
}

/* ---- ① 先验证入口，加载不了就别动 profile ---- */
console.log('① 验证插件入口能被 Node 加载…')
const probe = verifyEntryLoads()
if (!probe.ok) {
  console.error(`✗ 入口验证失败，**没有动 profile**：\n${probe.output}`)
  process.exit(1)
}
console.log(`  ✓ ${probe.output}`)

/* ---- ② 备份 + 改 profile ---- */
const backupDir = path.join(profileDir, `_backup-${PKG.name}-${timestamp()}`)
fs.mkdirSync(backupDir, { recursive: true })
fs.copyFileSync(pkgFile, path.join(backupDir, 'package.json'))
console.log(`② 已备份 profile：${backupDir}`)

const pkg = before.pkg
pkg.dependencies = pkg.dependencies ?? {}
pkg.dependencies[PKG.name] = LINK_SPEC
if (!pkg.dsh.profile.bundles.includes(PKG.name)) pkg.dsh.profile.bundles.push(PKG.name)
fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

/* ---- ③ Junction ---- */
fs.mkdirSync(path.dirname(linkPath), { recursive: true })
const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false })
if (existing) {
  if (existing.isSymbolicLink()) fs.unlinkSync(linkPath)
  else fs.rmSync(linkPath, { recursive: true, force: true })
}
fs.symlinkSync(ROOT, linkPath, 'junction')
console.log(`③ Junction：${linkPath} → ${ROOT}`)

/* ---- ④ 复核 + 回滚兜底 ---- */
const after = inspectProfile(pkgFile)
const ok = after.inDeps && after.inBundles && fs.existsSync(linkPath)
if (!ok) {
  console.error('✗ 复核没过（依赖/bundles/链接有一项没落），正在回滚…')
  fs.copyFileSync(path.join(backupDir, 'package.json'), pkgFile)
  const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false })
  if (stat) {
    if (stat.isSymbolicLink()) fs.unlinkSync(linkPath)
    else fs.rmSync(linkPath, { recursive: true, force: true })
  }
  console.error(`  已回滚 package.json（备份仍在 ${backupDir}）`)
  process.exit(1)
}

console.log('')
console.log('✓ 安装完成（幂等，重复跑无副作用）')
console.log(`  dependencies["${PKG.name}"] = "${LINK_SPEC}"`)
console.log(`  dsh.profile.bundles 里有 "${PKG.name}"`)
console.log('')
console.log('★ 接下来请**彻底退出 DSH 再重新打开**（DSH 是桌面端，没有刷新页面这回事）：')
console.log('  宿主侧插件的工具清单只在启动时装配一次，不重启看不到 draw_image。')
console.log('  另外出图前要先把 ComfyUI 跑起来（双击 D:\\ComfyUI\\启动ComfyUI.bat），')
console.log('  没启动时 draw_image 会明确告诉你，不会默默失败。')
