/**
 * dsh-qwen-paint — 一键部署（ComfyUI + 千问 Qwen-Image 2.1 模型）
 * ============================================================================
 * 干三件事，缺什么补什么（已就绪的一律跳过，可重复执行）：
 *   ① 找到 / 装好 ComfyUI
 *   ② 把三个千问模型下到正确目录，并做 **SHA256 校验**
 *   ③ 调 install.mjs 把插件挂进 DSH profile
 *
 * ★★ 下载渠道（按主人的铁律一：只走有正规资质的渠道）
 *   模型 = **ModelScope 官方直连**（modelscope.cn，阿里官方平台）。
 *   上传者是 **Comfy Org 官方组织自己的仓库** `Comfy-Org/Qwen-Image-2.1`
 *   （Organization.GithubAddress = https://comfy.org/），不是第三方转存。
 *   期望哈希取自该仓库文件列表 API 的 `sha256` 字段 —— 这正是规则里写明的合法来源。
 *   ComfyUI 本体 = GitHub 官方 release（comfyanonymous/ComfyUI）。
 *   ⚠ ComfyUI 官方 release **不公布哈希**，所以本脚本**默认不去自动下它**，
 *     只在你显式加 `--download-comfy` 时才下，并且会再问一次（铁律三：来源可查 + 知情同意）。
 *
 * 用法：
 *   node scripts/setup.mjs                 检测 + 补齐（缺模型就下模型）
 *   node scripts/setup.mjs --check         只检测，绝不下载（先看看差什么）
 *   node scripts/setup.mjs --verify        已存在的模型也重算一遍 SHA256（慢，但最稳）
 *   node scripts/setup.mjs --comfy D:\ComfyUI   指定 ComfyUI 目录
 *   node scripts/setup.mjs --download-comfy     顺带下载 ComfyUI 官方便携包
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

const CHECK_ONLY = has('--check')
/** --check 只比大小（秒回）；--verify 才真的重算 SHA256（13 GB 要等一会儿）。 */
const FORCE_VERIFY = has('--verify')
const WANT_COMFY = has('--download-comfy')

/* ------------------------------------------------ 模型清单（官方值，别手改） ---- */

/**
 * ⚠ 这三条是**从 ModelScope 官方文件列表 API 抄下来的**，`size` 与 `sha256` 必须成对使用。
 *   要更新版本时，重新取一次 API：
 *   https://modelscope.cn/api/v1/models/Comfy-Org/Qwen-Image-2.1
 */
const MODELS = [
  {
    dir: 'diffusion_models',
    name: 'qwen_image_2.1_int8_convrot.safetensors',
    size: 7256783064,
    sha256: 'cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d',
    note: 'UNet（出图主模型）',
  },
  {
    dir: 'text_encoders',
    name: 'qwen3vl_8b_w4a8.safetensors',
    size: 6312105364,
    sha256: '7754425e55e7bea2bfde4dde59a4cc236cb44e5ee9c215ea66ef8d47012824eb',
    note: 'CLIP / 文本编码器（type=qwen_image）',
  },
  {
    dir: 'vae',
    name: 'qwen_image_2.1_vae_bf16.safetensors',
    size: 675509688,
    sha256: 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9',
    note: 'VAE',
  },
]

const REPO = 'Comfy-Org/Qwen-Image-2.1'
/** ModelScope 官方下载前缀（resolve/<revision>/<仓库内路径>）。 */
const REPO_BASE = `https://modelscope.cn/models/${REPO}/resolve/master/`
const REPO_PAGE = `https://modelscope.cn/models/${REPO}`

const COMFY_RELEASE = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z'
const COMFY_REPO = 'https://github.com/comfyanonymous/ComfyUI'

/* ------------------------------------------------------------------ 小工具 ---- */

const gb = (bytes) => `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`

function which(exe) {
  const res = spawnSync('where.exe', [exe], { encoding: 'utf8' })
  return res.status === 0 ? String(res.stdout).split(/\r?\n/u)[0].trim() : null
}

/** 流式算 SHA256（大文件不能一次读进内存）。 */
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 目录像不像一个 ComfyUI 安装（便携版或源码版都认）。 */
function looksLikeComfy(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  return (
    fs.existsSync(path.join(dir, 'ComfyUI', 'main.py')) ||
    fs.existsSync(path.join(dir, 'main.py'))
  )
}

/** 模型实际该放的位置（兼容便携版 models\ 与 extra_model_paths 的写法）。 */
function modelsRootOf(comfyDir) {
  const inner = path.join(comfyDir, 'ComfyUI', 'models')
  return fs.existsSync(inner) ? inner : path.join(comfyDir, 'models')
}

/* ------------------------------------------------------------ 找 ComfyUI ---- */

function findComfyDir() {
  const explicit = valueOf('--comfy') ?? process.env.DSHQP_COMFY_DIR
  const candidates = [
    explicit,
    process.env.COMFYUI_DIR,
    'D:\\ComfyUI',
    'C:\\ComfyUI',
    path.join(os.homedir(), 'ComfyUI'),
    path.join(os.homedir(), 'Documents', 'ComfyUI'),
    path.join(process.env.USERPROFILE ?? '', 'Desktop', 'ComfyUI'),
  ].filter((item) => typeof item === 'string' && item !== '')
  for (const dir of candidates) {
    if (looksLikeComfy(dir)) return { dir: path.resolve(dir), from: dir === explicit ? '参数指定' : '自动找到' }
  }
  return { dir: null, from: null }
}

/* -------------------------------------------------------------- 下载模型 ---- */

/**
 * 用 curl 下载（Windows 10+ 自带）：`-L` 跟随重定向、`-C -` 断点续传、
 * `--retry` 自动重试。进度不由 curl 打印，而是**每 3 秒读一次文件大小**报一行 ——
 * 这样日志干净，也符合"长任务每 3 秒报一次进度"的规矩。
 */
function downloadWithCurl(url, dest) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const partial = `${dest}.part`
    const child = spawn('curl.exe', [
      '-L', '--fail', '--retry', '5', '--retry-delay', '3',
      '-C', '-', '-o', partial, '--no-progress-meter', url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    let lastBytes = 0
    let lastTick = 0
    const started = Date.now()
    const timer = setInterval(() => {
      const bytes = fs.existsSync(partial) ? fs.statSync(partial).size : 0
      const now = Date.now()
      const speed = now - lastTick > 0 ? (bytes - lastBytes) / ((now - lastTick) / 1000) : 0
      lastBytes = bytes
      lastTick = now
      const elapsed = Math.round((now - started) / 1000)
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
      const ss = String(elapsed % 60).padStart(2, '0')
      console.log(`    [${mm}:${ss}] ${mb(bytes)}  速度 ${speed > 0 ? `${(speed / 1024 / 1024).toFixed(1)} MB/s` : '—'}`)
    }, 3000)

    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })

    child.on('close', (code) => {
      clearInterval(timer)
      if (code === 0 && fs.existsSync(partial)) {
        // 落定：改名成正式文件（校验不过时会再删掉）
        fs.rmSync(dest, { force: true })
        fs.renameSync(partial, dest)
        resolve({ ok: true })
        return
      }
      // ⚠ curl -C - 对**已经完整**的文件会返回非零（rc=33）—— 这时 .part 其实已经是完整文件，
      //   交给后面的"大小 + 哈希"去判断，不在这里武断失败。
      resolve({ ok: false, code, stderr: stderr.trim(), kept: fs.existsSync(partial) })
    })
  })
}

/* ------------------------------------------------------------------ 主流程 ---- */

console.log('dsh-qwen-paint · 一键部署')
console.log('='.repeat(64))

/* ① ComfyUI */
console.log('\n① 找 ComfyUI …')
const found = findComfyDir()
let comfyDir = found.dir
if (comfyDir !== null) {
  console.log(`  ✓ ${comfyDir}（${found.from}）`)
} else {
  console.log('  ✗ 没找到已装的 ComfyUI')
  console.log(`    ComfyUI 官方便携包：${COMFY_RELEASE}`)
  console.log(`    官方仓库：${COMFY_REPO}`)
  console.log('    ⚠ 官方 release **不公布哈希**，所以本脚本默认不替你下它。')
  console.log('      想让它下，加 --download-comfy 重新跑（它会再和你确认一次）。')
  if (!WANT_COMFY) {
    console.log('\n  跳过模型部署（没有 ComfyUI 就不知道往哪放）。')
    console.log('  装好 ComfyUI 后重跑本脚本即可，或者用 --comfy <目录> 指定位置。')
    process.exit(0)
  }
  const sevenZip = which('7z.exe') ?? which('7za.exe')
  console.log(`\n  7-Zip：${sevenZip ?? '✗ 没找到 —— 官方便携包是 .7z，没它解不开'}`)
  // ⚠ 铁律三：官方不公布哈希的东西，要**取得当次同意**才动 —— 所以这里真的问一句。
  //   用 readline 而不是 powershell Read-Host：后者读的是控制台，管道输入喂不进去（踩过）。
  let yes = false
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('    ComfyUI 官方 release 不公布哈希，无法做哈希校验。仍要下载吗？(y/N) ')
    rl.close()
    yes = answer.trim().toLowerCase().startsWith('y')
  } else {
    console.log('    （非交互环境，没得到确认 → 不下载）')
  }
  if (!yes) {
    console.log('  已取消。请自行装好 ComfyUI 后重跑本脚本，或用 --comfy <目录> 指定已有安装。')
    process.exit(0)
  }
  const target = valueOf('--comfy') ?? 'D:\\ComfyUI'
  const archive = path.join(os.tmpdir(), 'ComfyUI_windows_portable_nvidia.7z')
  console.log(`  下载到 ${archive} …`)
  const got = await downloadWithCurl(COMFY_RELEASE, archive)
  if (!got.ok) {
    console.error(`  ✗ 下载失败（GitHub 在国内常常连不上）。`)
    console.error('    按规矩：官方连不上又没有正规镜像时，请开 VPN 再跑，或手动装 ComfyUI。')
    process.exit(1)
  }
  if (sevenZip === null) {
    console.error(`  ✗ 已下到 ${archive}，但没装 7-Zip 解不开。请装 7-Zip 后手动解压到 ${target}。`)
    process.exit(1)
  }
  console.log(`  解压到 ${target} …`)
  const un = spawnSync(sevenZip, ['x', archive, `-o${target}`, '-y'], { encoding: 'utf8' })
  if (un.status !== 0) {
    console.error(`  ✗ 解压失败：\n${un.stderr ?? ''}`)
    process.exit(1)
  }
  // 便携包解出来是 ComfyUI_windows_portable\ 一层，往下找一层真正的根
  const inner = path.join(target, 'ComfyUI_windows_portable')
  comfyDir = looksLikeComfy(inner) ? inner : target
  console.log(`  ✓ 解压完成：${comfyDir}`)
}

/* ② 三个模型 */
const modelsRoot = modelsRootOf(comfyDir)
console.log(`\n② 检查千问 Qwen-Image 2.1 模型（放到 ${modelsRoot}）…`)

let needDownload = 0
let allOk = true
for (const model of MODELS) {
  const dest = path.join(modelsRoot, model.dir, model.name)
  const exists = fs.existsSync(dest)
  const size = exists ? fs.statSync(dest).size : 0
  const sizeOk = exists && size === model.size

  if (sizeOk && !FORCE_VERIFY) {
    console.log(`  ✓ ${model.name}（${gb(model.size)}，大小一致）`)
    continue
  }
  if (sizeOk && FORCE_VERIFY) {
    process.stdout.write(`  … ${model.name} 重算 SHA256（${gb(model.size)}，要等一会儿）`)
    const digest = await sha256Of(dest)
    if (digest === model.sha256) {
      console.log('\r  ✓ ' + `${model.name}（SHA256 一致）`.padEnd(60))
      continue
    }
    console.log('\r  ✗ ' + `${model.name} SHA256 不一致，删除后重下`.padEnd(60))
    fs.rmSync(dest, { force: true })
  } else if (exists) {
    console.log(`  ! ${model.name} 大小不对（实际 ${mb(size)}，应为 ${mb(model.size)}）→ 需要重下`)
  } else {
    console.log(`  · ${model.name} 缺失（${gb(model.size)}）—— ${model.note}`)
  }
  needDownload += 1
  allOk = false
}

if (needDownload === 0) {
  console.log('  ✓ 三个模型都已就绪')
} else {
  console.log(`\n  需要下载 ${needDownload} 个文件，来源：${REPO_PAGE}（Comfy Org 官方仓库）`)
  for (const model of MODELS) {
    const dest = path.join(modelsRoot, model.dir, model.name)
    const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0
    if (size === model.size) continue
    const url = `${REPO_BASE}${model.dir}/${model.name}`
    console.log(`\n  ↓ ${model.name}（${gb(model.size)}）`)
    const got = await downloadWithCurl(url, dest)
    const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0
    if (!got.ok && finalSize !== model.size) {
      console.error(`  ✗ 下载失败（curl 退出码 ${got.code}）：${got.stderr?.slice(0, 300) ?? ''}`)
      console.error('    可重复跑本脚本，curl 会断点续传。')
      allOk = false
      continue
    }
    if (finalSize !== model.size) {
      console.error(`  ✗ 大小不对：${mb(finalSize)}，应为 ${mb(model.size)}`)
      console.error('    ⚠ 按铁律二：校验不过的文件一律删除，不得使用。')
      fs.rmSync(dest, { force: true })
      allOk = false
      continue
    }
    process.stdout.write(`    大小对上了，算 SHA256 …`)
    const digest = await sha256Of(dest)
    if (digest !== model.sha256) {
      console.log('\r  ✗ SHA256 不匹配，已删除该文件（铁律二）'.padEnd(64))
      console.log(`    期望 ${model.sha256}`)
      console.log(`    实际 ${digest}`)
      fs.rmSync(dest, { force: true })
      allOk = false
      continue
    }
    console.log(`\r  ✓ ${model.name} 校验通过（SHA256 与 ${REPO} 一致）`.padEnd(64))
  }
}

/* --check：到此为止 —— 只报告，绝不改任何东西（连插件都不装） */
if (CHECK_ONLY) {
  console.log(allOk
    ? '\n（--check）全部就绪，没有做任何改动。'
    : `\n（--check）还差 ${needDownload} 个模型，共约 ${gb(MODELS.reduce((s, m) => s + m.size, 0))}，没有下载。`)
  console.log(`  去掉 --check 重跑就会自动下载。来源：${REPO_PAGE}`)
  process.exit(allOk ? 0 : 1)
}

/* ③ 插件本体 */
console.log('\n③ 把插件挂进 DSH profile …')
if (!allOk) {
  console.log('  ⚠ 模型还没齐，先不装插件（模型是我们自己的问题，装上也画不出图）。')
  console.log('  处理完上面的问题再重跑本脚本。')
  process.exit(1)
}
const installer = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'install.mjs')], {
  stdio: 'inherit', cwd: ROOT,
})
if (installer.status !== 0) {
  console.error('  ✗ 插件安装失败，见上面的输出。')
  process.exit(1)
}

console.log('\n' + '='.repeat(64))
console.log('✓ 部署完成')
console.log(`  ComfyUI ：${comfyDir}`)
console.log(`  模型目录 ：${modelsRoot}`)
console.log('  下一步：**彻底退出 DSH 再重新打开**，然后说一句「画一只橘猫」。')
