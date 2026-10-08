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

/* ══════════════════════════════ 显卡检测（0.1.1 新增）══════════════════════════
 *
 * 为什么必须分两条路：
 *   · ComfyUI 的 Windows 便携包是 **CUDA 版**，A 卡用户装上根本跑不起来 ✗
 *   · A 卡在 Windows 上要走 **ROCm**（AMD 官方 ROCm 7.2.1 起原生支持 Windows，不用 WSL）✓
 *   · 两条路**模型完全一样**（都用 Comfy-Org 官方那套 int8，哈希也一模一样）✓
 *     —— 这点很关键：换显卡不用换模型，插件本身也不用改 ✓
 *
 * ⚠⚠ 诚实声明：**A 卡那条路本脚本作者无法实测**（开发机是 N 卡，也不会在主人机器上装）。
 *    所以 A 卡的命令**全部照 AMD 官方博客来**，一个字没自己编：
 *    https://rocm.blogs.amd.com/artificial-intelligence/comfyui-windows/README.html
 *    下载源只用 **AMD 官方软件仓库 repo.radeon.com**（不是任何第三方加速站）✓
 */

/** AMD 官方 Windows ROCm wheels（AMD 官方 CDN）。 */
const ROCM_WHEELS = 'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/'
const ROCM_TORCH = '2.9.1+rocm7.2.1'
const ROCM_TORCHVISION = '0.24.1+rocm7.2.1'
const ROCM_TORCHAUDIO = '2.9.1+rocm7.2.1'

/** `--force-amd`：本机是 N 卡，靠它把 A 卡分支整条走一遍做验证。 */
const FORCE_AMD = has('--force-amd')
/** `--yes`：跳过"A 卡这套操作比较重"的二次确认（给别人做一键安装时用）。 */
const ASSUME_YES = has('--yes')

/**
 * 显卡型号 → ROCm 的 gfx 代号。
 * 只用于**猜**，猜不出就让用户照 ROCm 官方支持列表自己挑 —— 猜错比猜不出更糟，
 * 所以这里只收常见型号，宁缺勿滥。
 */
const GFX_TABLE = [
  [/RX\s*9070|AI\s*PRO\s*R9700|R9600D/iu, 'gfx1201'],
  [/RX\s*9060/iu, 'gfx1200'],
  [/Ryzen\s*AI\s*9\s*HX\s*375/iu, 'gfx1150'],
  [/RX\s*79[05]0|PRO\s*W79[05]0|W7800/iu, 'gfx1100'],
  [/RX\s*78[05]0|RX\s*77[05]0|PRO\s*V710|W7700/iu, 'gfx1101'],
  [/RX\s*7600/iu, 'gfx1102'],
  [/Radeon\s*780M/iu, 'gfx1103'],
  [/RX\s*69[05]0|RX\s*6800|PRO\s*W6800|V620/iu, 'gfx1030'],
  [/RX\s*67[05]0/iu, 'gfx1031'],
  [/RX\s*6600|PRO\s*W6600/iu, 'gfx1032'],
  [/RX\s*5700/iu, 'gfx1010'],
  [/RX\s*5500|PRO\s*W5500/iu, 'gfx1012'],
]

/**
 * 查本机显卡。
 * @returns {{names: string[], vendor: 'nvidia'|'amd'|'intel'|'unknown'}}
 *
 * ⚠ 优先级是**故意的**：只要有 N 卡就走 N 卡那条路 —— 那条路最成熟、也是实测过的。
 *   游戏本经常"核显 + 独显"同时报出来，别被那颗 AMD 核显带到 ROCm 上去。
 */
function detectGpu() {
  let names = []
  try {
    const res = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
    ], { encoding: 'utf8' })
    names = String(res.stdout ?? '').split(/\r?\n/u).map((s) => s.trim()).filter((s) => s !== '')
  } catch (error) { /* 查不到就当未知，不拦路 */ }
  const joined = names.join(' | ')
  let vendor = 'unknown'
  if (/NVIDIA|GeForce|RTX\s*\d|GTX\s*\d|Quadro/iu.test(joined)) vendor = 'nvidia'
  else if (/AMD|Radeon|RX\s*\d|Vega/iu.test(joined)) vendor = 'amd'
  else if (/Intel/iu.test(joined)) vendor = 'intel'
  return { names, vendor }
}

/** 从显卡名猜 gfx 代号；猜不出返回 null。 */
function gfxOf(names) {
  for (const name of names) {
    for (const [re, gfx] of GFX_TABLE) {
      if (re.test(name)) return gfx
    }
  }
  return null
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

/* ══════════════════════════════ A 卡（AMD）那条路 ══════════════════════════════ */

/** 跑一条命令、把输出直接透传给用户；失败返回 false。 */
function run(label, exe, argv, cwd) {
  console.log(`\n    $ ${label}`)
  const res = spawnSync(exe, argv, { stdio: 'inherit', cwd, shell: false })
  if (res.status !== 0) {
    console.error(`    ✗ 失败（退出码 ${res.status}）—— 修好再重跑本脚本即可，前面的步骤会跳过`)
    return false
  }
  console.log('    ✓ 完成')
  return true
}

/**
 * A 卡一键部署。**每一条命令都来自 AMD 官方博客**
 * （https://rocm.blogs.amd.com/artificial-intelligence/comfyui-windows/README.html），
 * 下载源只有 AMD 官方仓库 `repo.radeon.com` + ComfyUI 官方 GitHub + Comfy-Org 官方模型。
 *
 * ⚠ 这套操作很重：ROCm 版 PyTorch 约 3 GB、模型 13 GB；而且是装在**别人的机器**上，
 *   所以默认要确认一次，`--check` 则只打印计划、绝不执行。
 *
 * @returns {Promise<{dir: string}|null>} 装好的 ComfyUI 目录；用户放弃返回 null
 */
async function amdSetup(targetRoot, gfx, checkOnly) {
  console.log('\n① A 卡（AMD Radeon）路线 …')

  // ── 先说三条硬风险（比步骤重要，放最前面）──
  console.log('  ⚠⚠ 动手前必须先知道这三条：')
  console.log('     1. **可能静默出错** —— 在 gfx1100 这类卡上，它跑得飞快、日志也不报错，')
  console.log('        出来的却可能是噪点 / 全黑 / 颜色错。装完**一定要人工看图**，')
  console.log('        不能只看"跑完了"。这是 A 卡最坑的地方，没有之一。')
  console.log('     2. **别升到 ROCm 10.0 那套 wheels** —— 它报 HIP 7.15，实测会破坏权重；')
  console.log(`        本脚本锁死在 ${ROCM_TORCH}（HIP 7.2）。`)
  console.log('     3. 模型是 **Qwen Research License**：仅限研究 / 评估，**禁止商用**。')

  // ── Python 3.12（AMD 的 Windows wheels 只有 cp312，3.13 装不上）──
  const py = spawnSync('py', ['-3.12', '--version'], { encoding: 'utf8' })
  const pyOk = py.status === 0
  const pyText = String(py.stdout ?? py.stderr ?? '').trim()

  console.log('\n  ── 计划 ──')
  console.log(`    Python 3.12：${pyOk ? `✓ ${pyText}` : '✗ 没找到（AMD 的 wheels 只支持 3.12，3.13 装不上）'}`)
  if (!pyOk) {
    console.log('      请先装：winget install --id=Python.Python.3.12 -e')
    console.log('      （装完重跑本脚本。这一步脚本**不替你做** —— 装运行时要动系统，交给你决定）')
  }
  console.log(`    gfx 代号  ：${gfx ?? '⚠ 认不出来，请照 ROCm 官方支持列表自己挑一个'}`)
  console.log(`      列表：https://rocm.docs.amd.com/projects/install-on-linux/en/latest/reference/gpu-specs.html`)
  console.log(`    安装目录  ：${targetRoot}`)
  console.log(`    下载源    ：${ROCM_WHEELS}`)
  console.log('                （AMD 官方软件仓库；ComfyUI 用官方 GitHub，模型用 Comfy-Org 官方仓库）')
  console.log('    ── 步骤 ──')
  console.log(`      1. py -3.12 -m venv ${path.join(targetRoot, 'venv')}`)
  console.log(`      2. pip install -f ${ROCM_WHEELS} "torch==${ROCM_TORCH}"`)
  console.log(`         "torchvision==${ROCM_TORCHVISION}" "torchaudio==${ROCM_TORCHAUDIO}" numpy pillow`)
  console.log('      3. 验证 torch 认到 A 卡（torch.cuda.is_available() 必须 True）')
  console.log('      4. git clone ComfyUI 官方源码')
  console.log('      5. ★ 用 constraints 锁住 torch 再装依赖')
  console.log('         —— 这步最容易翻车：ComfyUI 的 requirements.txt 会把 ROCm 版 torch')
  console.log('            **偷偷换成 CUDA 版**，换完就再也认不到 A 卡了 ✗')
  console.log(`      6. 启动：python main.py --disable-dynamic-vram --use-pytorch-cross-attention`)

  if (checkOnly) {
    console.log('\n  （--check）只打印，没有执行任何一步。去掉 --check 才会真装。')
    return null
  }
  if (!pyOk) {
    console.log('\n  ⚠ Python 3.12 没就绪，先装上再重跑本脚本。')
    return null
  }

  // ── 二次确认：这套操作很重，而且是在别人的机器上 ──
  if (!ASSUME_YES) {
    if (!process.stdin.isTTY) {
      console.log('\n  （非交互环境，没得到确认 → 不执行。确认请加 --yes）')
      return null
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ans = await rl.question('\n  要在这台机器上装 A 卡那套吗？（会下载约 3 GB，还要建 venv）(y/N) ')
    rl.close()
    if (!ans.trim().toLowerCase().startsWith('y')) {
      console.log('  已取消。想只看看计划就加 --check。')
      return null
    }
  }

  const venv = path.join(targetRoot, 'venv')
  const comfyDir = path.join(targetRoot, 'ComfyUI')
  const pyExe = path.join(venv, 'Scripts', 'python.exe')
  fs.mkdirSync(targetRoot, { recursive: true })

  // 1) venv
  if (!fs.existsSync(pyExe)) {
    if (!run(`py -3.12 -m venv ${venv}`, 'py', ['-3.12', '-m', 'venv', venv])) return null
  } else {
    console.log(`\n    · venv 已存在，跳过：${venv}`)
  }
  if (!run('python -m pip install --upgrade pip wheel', pyExe, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'])) return null

  // 2) ROCm 版 PyTorch（AMD 官方源）
  if (!run(
    `pip install -f ${ROCM_WHEELS} torch==${ROCM_TORCH} …`,
    pyExe,
    ['-m', 'pip', 'install', '-f', ROCM_WHEELS,
      `torch==${ROCM_TORCH}`, `torchvision==${ROCM_TORCHVISION}`, `torchaudio==${ROCM_TORCHAUDIO}`,
      'numpy', 'pillow'],
  )) return null

  // 3) 验证认卡
  console.log('\n    验证 torch 能不能认到 A 卡 …')
  const probe = spawnSync(pyExe, ['-c',
    'import torch;print(torch.__version__);print(torch.cuda.is_available());'
    + 'print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-")'],
  { encoding: 'utf8' })
  const probeText = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim()
  console.log(probeText.split(/\r?\n/u).map((l) => `      ${l}`).join('\n'))
  if (!/True/u.test(probeText)) {
    console.error('\n    ✗ torch.cuda.is_available() 不是 True —— A 卡没被认到。')
    console.error('      先查显卡驱动（AMD 官方要求 Adrenalin 较新版本），再重跑。')
    return null
  }
  console.log('    ✓ 认到卡了')

  // 4) ComfyUI 官方源码
  if (!fs.existsSync(path.join(comfyDir, 'main.py'))) {
    if (!run(`git clone ${COMFY_REPO}`, 'git', ['clone', '--depth', '1', COMFY_REPO, comfyDir])) return null
  } else {
    console.log(`\n    · ComfyUI 源码已存在，跳过：${comfyDir}`)
  }

  // 5) ★ constraints 锁 torch —— 这一步不做，前面全白干
  const reqPath = path.join(comfyDir, 'requirements.txt')
  if (fs.existsSync(reqPath)) {
    const reqText = fs.readFileSync(reqPath, 'utf8')
    const kept = reqText.split(/\r?\n/u)
      .filter((line) => !/^\s*(torch|torchvision|torchaudio)\b/u.test(line))
      .join('\n')
    const pinPath = path.join(targetRoot, 'torch-pin.txt')
    const reqNoTorch = path.join(targetRoot, 'requirements-no-torch.txt')
    fs.writeFileSync(pinPath,
      `torch==${ROCM_TORCH}\ntorchvision==${ROCM_TORCHVISION}\ntorchaudio==${ROCM_TORCHAUDIO}\n`, 'utf8')
    fs.writeFileSync(reqNoTorch, kept, 'utf8')
    console.log(`\n    ★ 已把 requirements.txt 里的 torch 三行摘掉（${path.basename(reqNoTorch)}），`)
    console.log(`      并用 constraints（${path.basename(pinPath)}）钉死 ROCm 版 —— 否则会被换成 CUDA 版 ✗`)
    if (!run('pip install -r requirements-no-torch.txt -c torch-pin.txt',
      pyExe, ['-m', 'pip', 'install', '-c', pinPath, '-r', reqNoTorch])) return null
  }

  console.log('\n  ✓ A 卡这套装完了')
  console.log(`    以后启动：${pyExe} ${path.join(comfyDir, 'main.py')} --disable-dynamic-vram --use-pytorch-cross-attention`)
  console.log('    ⚠ 启动参数别省：--disable-dynamic-vram 在 A 卡上是必须的（DynamicVRAM 有已知问题）')
  console.log('    ⚠ 出第一张图后**务必人工看一眼**是不是正常图（A 卡会静默出错）')
  return { dir: comfyDir }
}

/* ------------------------------------------------------------------ 主流程 ---- */

console.log('dsh-qwen-paint · 一键部署')
console.log('='.repeat(64))

/* ⓪ 显卡检测 —— 决定走哪条路（0.1.1 新增） */
console.log('\n⓪ 看显卡 …')
const gpu = FORCE_AMD
  ? { names: ['（--force-amd：强制模拟 AMD 显卡）'], vendor: 'amd' }
  : detectGpu()
if (gpu.names.length === 0) {
  console.log('  · 查不到显卡信息（不影响：也可以用 --comfy <目录> 手动指定）')
} else {
  for (const name of gpu.names) console.log(`  · ${name}`)
}
const VENDOR_LABEL = {
  nvidia: 'NVIDIA → 走 ComfyUI 官方便携包（CUDA）',
  amd: 'AMD → 走 ROCm 路线（下面单独说明）',
  intel: 'Intel 核显 → 基本跑不动，建议换台机器；或加 --force-amd 看 A 卡那条路的说明',
  unknown: '认不出厂商 → 按 NVIDIA 那条路试（最通用）',
}
console.log(`  判定：${VENDOR_LABEL[gpu.vendor]}`)

/* ① ComfyUI */
let comfyDir = null
if (gpu.vendor === 'amd') {
  // A 卡：先试 ROCm 路线；没走通（或用户取消 / --check）就退回"本机已有的 ComfyUI"
  const amdRoot = valueOf('--comfy') ?? path.join(os.homedir(), 'ComfyUI-rocm')
  const amdResult = await amdSetup(amdRoot, gfxOf(gpu.names), CHECK_ONLY)
  if (amdResult !== null) {
    comfyDir = amdResult.dir
  } else {
    const fallback = findComfyDir()
    if (fallback.dir !== null) {
      comfyDir = fallback.dir
      console.log(`\n  · 退回用本机已有的 ComfyUI：${comfyDir}`)
      console.log('    ⚠ 但如果它是 NVIDIA 便携包，A 卡是跑不动的 —— 出图会直接失败。')
    }
  }
}
if (comfyDir === null && gpu.vendor !== 'amd') {
  // ↓↓↓ 这一段是 NVIDIA 那条路，与 0.1.0 完全一致，一个字没动 ↓↓↓
  console.log('\n① 找 ComfyUI …')
  const found = findComfyDir()
  comfyDir = found.dir
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
} // ← 关掉"NVIDIA 那条路"的外层 if（0.1.1 新增的那层）
if (comfyDir === null) {
  console.log('\n  ✗ 没有可用的 ComfyUI。按上面的提示处理完，再重跑本脚本。')
  process.exit(1)
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
