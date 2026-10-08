/**
 * dsh-qwen-paint —— 让 DeepSeek Harness 在对话里直接调用本机 ComfyUI，用千问
 * （Qwen-Image 2.1）模型画图。
 * ============================================================================
 * 设计要点（都是照官方内核实现与主人的既有环境核过的，别凭感觉改）：
 *
 * ① **零外部依赖**：不 import `@deepseek-ai/dsh-tools` 之类 dsh 自带的包。
 *    理由 —— `tools.register()` 只强校验 `output.schema` 必须是标准 JSON Schema
 *    （`assertSupportedJsonSchema`），而 `parameters` 的 spec→JSON Schema 转换是
 *    `defineTool()` 干的、`register()` 根本不校验。既然我们自己写成标准
 *    JSON Schema，就不需要 defineTool，也就没有"装进 profile 后解析不到包"的
 *    风险（插件解析失败会让 DSH 起不来，代价太大）。
 *    只用官方 present 工具也用过的关键字子集：type / properties / required /
 *    items / additionalProperties / description。
 *
 * ② **workflow 照抄 `D:\ComfyUI\小鲸鱼生图\app.py` 的 build_workflow()** ——
 *    那是主人机器上**已经在用、已验证**的那份千问文生图工作流，节点与连线
 *    一个字都不改，只把提示词/尺寸/步数/种子做成参数。
 *
 * ③ **纯本地**：只连 127.0.0.1 的 ComfyUI，不出网、不需要任何 API Key。
 *
 * ④ **落盘位置**：默认桌面「千问1生图」，遵循工作区约定。
 *
 * ⑤ **图片怎么显示在聊天框**：真正有效的只有两条 —— 正文 Markdown 图片
 *    （靠 systemPrompt 段落保证）与客户端自定义 toolview（lib/client.js）。
 *    ImageBlock / presentCall / presentationMeta / present 卡片**都不行**。
 *
 * ⑥ **空闲自动关停 ComfyUI**（主人 2026-10-07 要求："不要让 comfyUI 一直跑着，
 *    只要五分钟不生图 comfyUI 后端自动关闭"）：
 *    · 计时**只在插件出过图之后**才开始（`lastActivityAt` 初始为 null）——
 *      这样绝不会误关主人自己打开的、正在「小鲸鱼生图」里用的 ComfyUI；
 *    · 到点还要再确认两件事：ComfyUI 在线、且 `/queue` 为空（有任务在跑就续期）；
 *    · **只杀"监听该端口 且 命令行确实像 ComfyUI（含 comfy…main.py）"的进程**，
 *      认不出来就跳过并记日志——绝不按端口盲杀。
 *
 * ⑦ **只读状态端点**（给客户端的状态指示器用）：
 *    `GET /api/qwen-paint/status.json`（另注册一个根路径同内容作回退）。
 *    只回 {online, busy, idleShutdownInMs, ...} 这类事实，**不含任何路径/密钥**；
 *    并且只放行本机请求。
 * ============================================================================
 */

import { promises as fsp, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

/**
 * ★★ 2026-10-08：「正在生成图片」的呼吸动图 —— 路径与准备。
 *
 * 为什么这么做（主人给的正解，原话）：
 *   「你直接把这个动画当成一张图片发出来不就完美了吗」
 * 在此之前我三次尝试往消息树里插 DOM，最后一次把界面搞成整片空白 —— 那棵树由 React 管理，
 * 插自己的节点会被下一次渲染重排/清空（MEMO 里记过的红线：**只加属性、不改结构**）。
 * 改成动图后：位置就是正文图片的位置、随消息滚动、且完全不碰内核结构。
 *
 * 路径**动态算**（outputDir 已是按当前用户桌面推算的），复制到那儿供正文引用。
 */
function loadingGifPath(cfg) {
  // ★ 2026-10-08：**改用 webp**。GIF 版本在 DSH 里显示「图片无法预览」；
  //   而内核的 MIME 白名单明确支持 png / jpeg / webp / gif 四种（见 client.js L3728-3741），
  //   所以那次失败更可能是"GIF 编码/体积"而非格式本身 —— webp 只有 80KB（GIF 是 266KB）。
  return path.join(cfg.outputDir, '_正在生成图片.webp')
}

/** 把动图复制到用户目录（后台执行，不阻塞 systemPrompt 注册）。 */
async function prepareLoadingGif(cfg, log) {
  try {
    const src = fileURLToPath(new URL('../assets/loading.webp', import.meta.url))
    await fsp.mkdir(cfg.outputDir, { recursive: true })
    await fsp.copyFile(src, loadingGifPath(cfg))   // 每次覆盖：插件升级后动图可能变过
    return true
  } catch (error) {
    log('warn', `准备「正在生成」动图失败（不影响出图）：${error?.message ?? error}`)
    return false
  }
}

/** 稳定标识（与 cordis.patch.yml 里的 id 无关，这个是插件名）。 */
export const name = 'qwen-paint'

/* --------------------------------------------------------------- 默认配置 ---- */

const DEFAULTS = {
  /** ComfyUI 服务地址。 */
  comfyUrl: 'http://127.0.0.1:8188',
  /** 成品落盘目录（工作区约定：一律放「千问1生图」）。 */
  // ★★ 2026-10-07：出图目录**不再硬编码**。原来写死 C:\Users\<你的用户名>\Desktop\千问1生图，
  //    有两个问题：① 泄露 Windows 用户名（发出去的包里带着它）；
  //    ② **别人装上后用不了** —— 那个目录在他们机器上不存在，出图会写失败。
  //    改成按当前用户的桌面推算（USERPROFILE / HOME），profile 里显式配了 outputDir 时仍以配置为准。
  outputDir: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Desktop', '千问1生图'),
  /** ComfyUI 自己的 output 目录，先就地取文件、不行再走 /view 兜底。 */
  comfyOutputDir: 'D:\\ComfyUI\\ComfyUI\\output',
  /** 三个千问模型文件（照抄 app.py 的常量）。 */
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_w4a8.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
  /** 默认步数 / 分辨率 / 单任务超时。 */
  steps: 25,
  resolution: 1024,
  timeoutMs: 600000,
  /** 轮询 ComfyUI 的间隔（毫秒）；自测里会调小。 */
  pollIntervalMs: 1200,
  /** 文件名前缀（落盘命名用）。 */
  filePrefix: 'Qwen2.1',
  /** ★ 空闲自动关停：出图后多久没再出图就关掉 ComfyUI（默认 5 分钟）。 */
  idleShutdownMs: 300000,
  /** 空闲检查的间隔。 */
  idleCheckMs: 30000,
  /** 关掉 ComfyUI 总开关（想一直留着就设 false）。 */
  autoShutdown: true,
  /** 状态探测的缓存时长，避免客户端每秒轮询都去敲 ComfyUI。 */
  statusCacheMs: 3000,
  /** ★★ 生图过程的动画（主人 2026-10-08 要求「使用户生图时可以自选动画」）。
   *   meteor = 现在这个马卡龙流星（默认，观感不变）；其余见 FLOW_STYLES。
   *   界面上的选择会**落盘**（见 uiStatePath），下次启动记得住。 */
  flowStyle: 'meteor',
}

/* ------------------------------------------------ 生图动画方案（界面可自选） ---- */

/**
 * 允许的动画 id 白名单 —— **host 端只需要 id，渲染全在客户端**（见 client.js 的 FLOW_GRADS）。
 * meteor + 15 种流光（色值照搬主人小肥鱼挂件里那套「跑马灯」流光，一个字没改）。
 *
 * ⚠ 这里必须**白名单校验**：`?flowStyle=` 是外部输入，直接塞进样式名会变成注入面。
 * ⚠ 客户端那份表要和这里对齐 —— 自测里有一条专门比对两边 id 集合，改名时两边一起改。
 */
const FLOW_STYLES = [
  'meteor',
  'macaron', 'candy', 'rouge', 'bamboo', 'aurora', 'deepsea', 'sunset', 'forest',
  'champagne', 'lavender', 'mint', 'lava', 'galaxy', 'ink', 'indigo',
]

/** 界面偏好落盘路径：$DSH_HOME 优先（跟着 DSH 的 home 走），其次按用户目录推算。 */
function uiStatePath() {
  const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return path.join(home, 'qwen-paint-ui.json')
}

/** 读界面偏好。文件不存在 / 内容坏了都返回空对象 —— 绝不影响出图。 */
function readUiState() {
  try {
    const parsed = JSON.parse(readFileSync(uiStatePath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

/** 写界面偏好（同步写：文件很小、只在用户点选时发生，避免异步写的竞态）。 */
function writeUiState(state, log) {
  try {
    writeFileSync(uiStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return true
  } catch (error) {
    log('warn', `界面偏好写盘失败（只影响"下次启动还记不记得"）：${error?.message ?? error}`)
    return false
  }
}

/** 画幅比例（照抄 app.py 的 ASPECTS）。 */
const ASPECTS = {
  '1:1': [1, 1],
  '3:4': [3, 4],
  '4:3': [4, 3],
  '2:3': [2, 3],
  '3:2': [3, 2],
  '16:9': [16, 9],
  '9:16': [9, 16],
}

/* ------------------------------------------------------------------ 小工具 ---- */

/** 写日志：宿主 logger 存在就写，不存在就吞掉（绝不让日志把功能搞崩）。 */
function makeLog(ctx) {
  return (level, message) => {
    try {
      const logger = ctx.logger ?? ctx.root?.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[qwen-paint] ${message}`)
      else if (level === 'error' || level === 'warn') console.error(`[qwen-paint] ${message}`)
    } catch {
      /* 日志失败绝不影响出图 */
    }
  }
}

/** 对齐到 32 的倍数（照抄 app.py 的 r32）。 */
function r32(value) {
  return Math.max(32, Math.round(value / 32) * 32)
}

/** 按画幅比例 + 百万像素算尺寸（照抄 app.py 的 calc_size）。 */
function calcSize(aspect, megapixels) {
  const [aw, ah] = ASPECTS[aspect] ?? [1, 1]
  const ratio = aw / ah
  const total = Number(megapixels) * 1e6
  const width = Math.sqrt(total * ratio)
  return [r32(width), r32(width / ratio)]
}

/** 把提示词变成安全的文件名主体（照抄 app.py 的 safe_name 精神）。 */
function safeStem(prompt, maxChars) {
  const cleaned = String(prompt ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned.length === 0) return '无题'
  if (/^[\x20-\x7e]+$/u.test(cleaned)) {
    // 纯英文按词截断，别切半个单词
    let out = ''
    for (const word of cleaned.split(' ')) {
      if (out.length + word.length + 1 > 34) break
      out = `${out} ${word}`.trim()
    }
    return out || cleaned.slice(0, 34)
  }
  return cleaned.slice(0, maxChars)
}

/** 找一个不冲突的落盘路径。 */
async function uniquePath(dir, filename) {
  const first = path.join(dir, filename)
  try {
    await fsp.access(first)
  } catch {
    return first
  }
  const ext = path.extname(filename)
  const stem = path.basename(filename, ext)
  for (let i = 2; i < 999; i += 1) {
    const candidate = path.join(dir, `${stem}-${i}${ext}`)
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

/** 从 comfyUrl 取端口号（取不到就退回 8188）。 */
function portOf(url) {
  try {
    const parsed = new URL(url)
    if (parsed.port !== '') return Number.parseInt(parsed.port, 10)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return 8188
  }
}

/* -------------------------------------------------------------- ComfyUI 交互 ---- */

/** 带超时的 fetch（同时尊重 exec.signal 的取消）。 */
async function fetchWithTimeout(url, { method = 'GET', body, timeoutMs, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => controller.abort(signal.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * ★★ 把 ComfyUI 后端**隐身**启动：无控制台、不弹浏览器、不抢焦点。
 *
 * 主人先后两次要求：①「comfyUI 及其所有后端全部隐藏不要显示出来」；
 * ②（2026-10-07）「生图时依旧有弹窗出来，想办法隐藏掉」。
 * 那个弹窗就是**浏览器**，来源有两处，都已查实：
 *   · 启动 bat 的「已在运行」分支里有一句 `start "" http://127.0.0.1:8188`；
 *   · ComfyUI 自身的 `--auto-launch`（`--windows-standalone-build` 下可能被带上）。
 * 所以这里**绕过 bat**，直接调 python.exe + `-WindowStyle Hidden`（窗口藏住、输出流仍在），
 * 并显式加 `--disable-auto-launch`。两个参数名都用 `main.py --help` 核实过确实存在。
 */
async function startComfyHidden(cfg, log) {
  // ★★ 2026-10-07 实测修正：**绝对不能用 pythonw.exe**！
  //    它没有控制台、sys.stdout 是 None，而 ComfyUI 启动时会大量 print ——
  //    一打印就抛异常、进程立刻退出。现象是出图报「240 秒内没就绪」，实际上
  //    python.exe 11 秒就能起（实测：pythonw 那次 8188 不在听、python 进程一个都没有）。
  //    正确组合 = python.exe + -WindowStyle Hidden：窗口藏住、输出流仍在。
  const py = cfg.comfyPython ?? 'D:\\ComfyUI\\python_embeded\\python.exe'
  const mainPy = cfg.comfyMainPy ?? 'D:\\ComfyUI\\ComfyUI\\main.py'
  const workdir = cfg.comfyWorkdir ?? 'D:\\ComfyUI'
  log('info', `按需启动 ComfyUI（无窗口、不弹浏览器）：${py}`)
  await runPowerShell(
    `Start-Process -FilePath '${py.replace(/'/gu, "''")}' ` +
      `-ArgumentList @('-s','${mainPy.replace(/'/gu, "''")}','--windows-standalone-build','--disable-auto-launch') ` +
      `-WorkingDirectory '${workdir.replace(/'/gu, "''")}' -WindowStyle Hidden`,
    30000,
  )
}

/**
 * ★ 探活；没开就**隐藏启动**并等它就绪 —— 主人要求后端完全不可见、且全自动。
 * 配合空闲关停：出图前自动拉起、闲置 5 分钟自动关掉，全程不需要主人动手。
 */
async function ensureComfyUp(cfg, log, signal) {
  try {
    await assertComfyUp(cfg, signal)
    return
  } catch (error) {
    if (cfg.autoStartComfy === false) throw error
    log('info', 'ComfyUI 没在跑 → 后台隐藏启动它')
  }
  await startComfyHidden(cfg, log)
  const started = Date.now()
  const limit = Number(cfg.startTimeoutMs ?? 240000)
  for (;;) {
    if (Date.now() - started > limit) {
      throw new Error(
        `已在后台启动 ComfyUI，但 ${Math.round(limit / 1000)} 秒内没就绪（首次要加载 13 GB 模型，可能更久）。` +
          '稍等一会儿再让我画一次即可；若一直不行，手动双击 D:\\ComfyUI\\启动ComfyUI.bat。',
      )
    }
    if (signal?.aborted) throw signal.reason ?? new Error('已取消')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      await assertComfyUp(cfg, signal)
      log('info', `ComfyUI 已就绪（等了 ${Math.round((Date.now() - started) / 1000)} 秒）`)
      return
    } catch {
      /* 还在加载，继续等 */
    }
  }
}

/** 探活：ComfyUI 在不在，不在就给一句能照做的提示。 */
async function assertComfyUp(cfg, signal) {
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 8000, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (error) {
    throw new Error(
      `连不上本机 ComfyUI（${cfg.comfyUrl}）：${error?.message ?? error}\n` +
        '请先启动 ComfyUI（例如双击 D:\\ComfyUI\\启动ComfyUI.bat，或先打开「小鲸鱼生图」），' +
        '等服务起来后再让我画一次。',
    )
  }
}

/**
 * ComfyUI 状态（带缓存）。
 * 缓存是为了让客户端每 5 秒的轮询不至于每次都去敲 ComfyUI（它可能正忙）。
 */
function makeComfyStatus(cfg) {
  let cache = { at: 0, online: false }
  return {
    async probe(force = false) {
      const now = Date.now()
      if (!force && now - cache.at < cfg.statusCacheMs) return cache.online
      let online = false
      try {
        const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 3000 })
        online = res.ok
      } catch {
        online = false
      }
      cache = { at: now, online }
      return online
    },
    /** 队列里有东西就算了"忙"——空闲关停会因此续期，绝不打断别人正在跑的任务。 */
    async queueBusy() {
      try {
        const res = await fetchWithTimeout(`${cfg.comfyUrl}/queue`, { timeoutMs: 3000 })
        if (!res.ok) return false
        const data = await res.json()
        const running = Array.isArray(data?.queue_running) ? data.queue_running.length : 0
        const pending = Array.isArray(data?.queue_pending) ? data.queue_pending.length : 0
        return running + pending > 0
      } catch {
        return false
      }
    },
    invalidate() {
      cache = { at: 0, online: cache.online }
    },
  }
}

/* ------------------------------------------------- 空闲关停 + 进程识别（★ 安全） ---- */

/** 跑一段 PowerShell，拿 stdout（windowless，超时保护）。 */
async function runPowerShell(script, timeoutMs = 20000) {
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
  )
  return String(stdout ?? '').trim()
}

/**
 * ★★ 找出"确实是 ComfyUI"的进程。两道闸：
 *   ① 它必须正监听 ComfyUI 的端口；
 *   ② 它的命令行必须同时含 `comfy` 与 `main.py`（本机启动命令是
 *      `…\python_embeded\python.exe -s .\ComfyUI\main.py --windows-standalone-build`）。
 * 只要有一条不满足就返回 null —— **绝不动手**。宁可留着占显存，也不误杀别人的进程。
 * @returns {{pid:number, commandLine:string}|null}
 */
async function findComfyProcess(cfg, log) {
  const port = portOf(cfg.comfyUrl)
  try {
    const pidText = await runPowerShell(
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
        'Select-Object -First 1 -ExpandProperty OwningProcess)',
    )
    const pid = Number.parseInt(pidText, 10)
    if (!Number.isInteger(pid) || pid <= 0) return null
    const commandLine = await runPowerShell(
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | ` +
        'Select-Object -ExpandProperty CommandLine)',
    )
    if (!/comfy/iu.test(commandLine) || !/main\.py/iu.test(commandLine)) {
      log('warn', `端口 ${port} 上的 PID ${pid} 命令行不像 ComfyUI，拒绝关闭：${commandLine.slice(0, 160)}`)
      return null
    }
    return { pid, commandLine }
  } catch (error) {
    log('warn', `识别 ComfyUI 进程失败：${error?.message ?? error}`)
    return null
  }
}

/**
 * 空闲关停器。
 *
 * ★ 计时**只在插件出过图之后**才开始：`lastActivityAt` 初始为 null，此时 tick 永远
 *   返回 false。所以「主人自己打开 ComfyUI 在别处画图」绝不会被本插件关掉。
 * ★ 到点后还要过两关：ComfyUI 在线、`/queue` 为空。队列非空 → 续期（有人在用）。
 */
function makeIdleShutdown(cfg, log, status) {
  const state = { lastActivityAt: null, shuttingDown: false, shutdowns: 0 }

  return {
    /** 记一次活动（出图成功后调用）。 */
    touch() {
      state.lastActivityAt = Date.now()
    },
    /** 距离下次自动关停还有多久（毫秒）；不可用时返回 0。 */
    idleShutdownInMs() {
      if (!cfg.autoShutdown) return 0
      // ★ 2026-10-07 新增：`idleShutdownMs <= 0` 表示**不自动关闭**（主人在界面上选了这一项）。
      //   remaining() 返回 0、shouldShutdown() 返回 false，两者都要挡住，否则会算出负数/立刻关停。
      if (cfg.idleShutdownMs <= 0) return 0
      if (state.lastActivityAt === null) return 0
      return Math.max(0, cfg.idleShutdownMs - (Date.now() - state.lastActivityAt))
    },
    snapshot() {
      return {
        autoShutdown: cfg.autoShutdown,
        lastActivityAt: state.lastActivityAt,
        idleShutdownMs: cfg.idleShutdownMs,
        idleShutdownInMs: this.idleShutdownInMs(),
        shutdowns: state.shutdowns,
      }
    },
    /** 定时检查。真关掉了返回 true。 */
    async tick() {
      if (!cfg.autoShutdown) return false
      // ★ 2026-10-07：idleShutdownMs <= 0 = 主人在界面上选了「不自动关闭」
      if (cfg.idleShutdownMs <= 0) return false
      if (state.lastActivityAt === null) return false
      if (state.shuttingDown) return false
      if (Date.now() - state.lastActivityAt < cfg.idleShutdownMs) return false

      // 关之前必须确认它还在（不在就没什么可关的，顺手复位计时）
      const online = await status.probe(true)
      if (!online) {
        state.lastActivityAt = null
        return false
      }
      // 队列非空 → 有人在用，续期，绝不打断
      if (await status.queueBusy()) {
        state.lastActivityAt = Date.now()
        return false
      }

      state.shuttingDown = true
      try {
        const found = await findComfyProcess(cfg, log)
        if (found === null) {
          log('warn', '空闲已超时，但没能确认哪个进程是 ComfyUI，本次不关闭')
          return false
        }
        await runPowerShell(`Stop-Process -Id ${found.pid} -Force`)
        state.shutdowns += 1
        log('info', `已空闲 ${Math.round((Date.now() - state.lastActivityAt) / 1000)} 秒，关闭 ComfyUI（PID ${found.pid}）`)
        state.lastActivityAt = null
        status.invalidate()
        return true
      } catch (error) {
        log('warn', `关闭 ComfyUI 失败：${error?.message ?? error}`)
        return false
      } finally {
        state.shuttingDown = false
      }
    },
  }
}

/** 只放行本机请求（照 dsh-boot-splash 余额路由的做法）。 */
function isLocalRequest(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const remote = String(req?.socket?.remoteAddress ?? '')
  const hostOk = host === '' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(host)
  const remoteOk = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  return hostOk && remoteOk
}

/** 回 JSON；任何异常都降级成一个可读的错误体，绝不 5xx。 */
function respondJson(res, body, code = 200) {
  try {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  } catch (error) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }))
    } catch {
      /* 连接已经没了 */
    }
  }
}

/* ---------------------------------------------------------------- 工作流与出图 ---- */

/**
 * 组装千问工作流。
 *
 * · 不给 `reference` → **文生图**（照 app.py build_workflow 的无参考图分支，一字未动）
 * · 给了 `reference` → **图生图**（照 `scripts/_img2img.mjs`，那份在本机验证过）
 *
 * ★ 图生图有四个要点，一个都不能少：
 *   ① 加一个 `LoadImage` 节点读参考图
 *   ② `TextEncodeQwenImage21` **必须拿到 `vae`** —— 不给 vae 它就不会编码参考图
 *   ③ 参考图走 `images.image_1`（源码支持到 image_16）
 *   ④ KSampler 的 latent 取自该节点的**第 2 号输出**（positive=0 / negative=1 / latent=2），
 *      并且**删掉 `EmptyLatentImage`** —— 所以图生图的 `resolution` 要用 sqrt(W*H)，
 *      它**直接决定输出尺寸**（文生图那边则由 EmptyLatentImage 决定，所以用固定值即可）
 *
 * @param reference ComfyUI 里的参考图文件名（已经上传过去的）；空 = 文生图
 */
function buildWorkflow(cfg, { prompt, negative, width, height, steps, seed, reference }) {
  const withRef = typeof reference === 'string' && reference !== ''

  const workflow = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: cfg.unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: cfg.clip, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: cfg.vae } },
    5: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0],
        prompt: prompt ?? '',
        negative_prompt: negative ?? '',
        resolution: withRef ? Math.round(Math.sqrt(width * height)) : cfg.resolution,
      },
    },
    7: { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'dsh-qwen-paint' } },
  }

  if (withRef) {
    // 图生图：参考图进来，latent 由编码节点给，不要空 latent
    workflow[4] = { class_type: 'LoadImage', inputs: { image: reference } }
    workflow[5].inputs.vae = ['3', 0]
    workflow[5].inputs['images.image_1'] = ['4', 0]
  } else {
    workflow[6] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } }
  }

  workflow[8] = {
    class_type: 'KSampler',
    inputs: {
      model: ['7', 0],
      seed,
      steps: Math.max(1, Math.min(60, steps)),
      cfg: 1.0,
      sampler_name: 'euler',
      scheduler: 'simple',
      positive: ['5', 0],
      negative: ['5', 1],
      latent_image: withRef ? ['5', 2] : ['6', 0],
      denoise: 1.0,
    },
  }
  return workflow
}

/**
 * 把参考图上传给 ComfyUI，返回它在 ComfyUI 那边的文件名。
 *
 * ★ 为什么必须走 `/upload/image` 而不是"自己复制进 input 目录"：
 *   ComfyUI 的 input 目录**未必是配置里以为的那个**（启动时可以用 `--input-directory` 改），
 *   直接复制过去很可能放错地方；`/upload/image` 是**问 ComfyUI 本人要位置**，永远对。
 *   （同样的坑今天刚在 output 目录上踩过一次。）
 *
 * ⚠ 不能复用 `fetchWithTimeout` —— 它写死了 `Content-Type: application/json`，
 *   而这里要发 multipart。所以自己发一次。
 */
async function uploadReference(cfg, filePath, signal) {
  let bytes
  try {
    bytes = await fsp.readFile(filePath)
  } catch (error) {
    throw new Error(`读不到参考图：${filePath}（${error?.message ?? error}）`)
  }
  const form = new FormData()
  form.append('image', new Blob([bytes]), path.basename(filePath))
  form.append('overwrite', 'true')

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('上传参考图超时')), 120000)
  try {
    const res = await fetch(`${cfg.comfyUrl}/upload/image`, { method: 'POST', body: form, signal: controller.signal })
    if (!res.ok) throw new Error(`参考图上传失败：HTTP ${res.status}`)
    const data = await res.json()
    if (!data?.name) throw new Error(`参考图上传返回异常：${JSON.stringify(data).slice(0, 200)}`)
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** 提交任务，拿 prompt_id。 */
async function submitPrompt(cfg, workflow, signal) {
  const res = await fetchWithTimeout(`${cfg.comfyUrl}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ prompt: workflow, client_id: `dsh-qwen-paint-${process.pid}` }),
    timeoutMs: 60000,
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ComfyUI 拒绝了这次任务（HTTP ${res.status}）：${text.slice(0, 400)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`ComfyUI 返回了看不懂的内容：${text.slice(0, 300)}`)
  }
  if (payload?.error) {
    const detail = payload.error?.message ?? JSON.stringify(payload.error).slice(0, 300)
    const nodeErrors = payload.node_errors === undefined ? '' : `\n节点校验详情：${JSON.stringify(payload.node_errors).slice(0, 500)}`
    throw new Error(`ComfyUI 报错：${detail}${nodeErrors}`)
  }
  if (typeof payload?.prompt_id !== 'string') throw new Error('ComfyUI 没有返回 prompt_id，无法跟踪任务')
  return payload.prompt_id
}

/**
 * 轮询等结果。每 tick 回调一次进度，方便主人看到"在动"。
 * @returns 输出图片描述数组 [{filename, subfolder, type}]
 */
async function waitForResult(cfg, promptId, { signal, onTick, timeoutMs }) {
  const started = Date.now()
  let lastNote = ''
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error(`等 ComfyUI 出图超时（已等 ${Math.round((Date.now() - started) / 1000)} 秒）`)
    if (signal?.aborted) throw signal.reason ?? new Error('已取消')
    await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs ?? 1200))

    let history
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/history/${promptId}`, { timeoutMs: 30000, signal })
      if (!res.ok) continue
      history = await res.json()
    } catch {
      continue // ComfyUI 短暂忙不过来时不要当场判死
    }
    const entry = history?.[promptId]
    if (!entry) {
      if (onTick) onTick(`排队/加载模型中… 已等 ${Math.round((Date.now() - started) / 1000)}s`)
      continue
    }
    const status = entry.status
    if (status?.status_str === 'error' || status?.completed === false) {
      const messages = status?.messages
      if (Array.isArray(messages) && messages.some((m) => Array.isArray(m) && m[0] === 'execution_error')) {
        const err = messages.find((m) => Array.isArray(m) && m[0] === 'execution_error')?.[1]
        throw new Error(`ComfyUI 执行失败：${err?.exception_message ?? JSON.stringify(err).slice(0, 400)}`)
      }
    }
    const images = []
    for (const nodeOutput of Object.values(entry.outputs ?? {})) {
      for (const image of nodeOutput?.images ?? []) {
        if (image?.filename) images.push(image)
      }
    }
    if (images.length > 0) return images
    const note = status?.status_str === 'success' ? '成功但没有图片输出' : `运行中… 已等 ${Math.round((Date.now() - started) / 1000)}s`
    if (note !== lastNote) {
      lastNote = note
      if (onTick) onTick(note)
    }
  }
}

/**
 * 取图片字节。
 *
 * ★★ 0.1.2 修正（真事故，主人一眼看出来的）：
 *   **先走 ComfyUI 官方的 `/view`，本地目录只当兜底。**
 *
 * 原来顺序是反的（先读本地 `comfyOutputDir`），结果踩了个大坑：
 *   ComfyUI 的 output 目录**未必是配置里那个** —— 插件自己拉起 ComfyUI 时会带
 *   `--output-directory <别处>`，或者机器上跑的是另一个实例。而两个实例的
 *   SaveImage 编号**都从 00001 重新开始**，于是**旧目录里恰好躺着一个同名文件** ✗
 *   → `readFile` 成功 → **根本走不到兜底** → 把昨天的旧图当成这次的成果，
 *     还按新 prompt 命名、报新请求的尺寸。主人看到的就是"画得完全不对"。
 *
 *   `/view` 是**问 ComfyUI 要它自己那次产出的文件**，不存在这个问题 ✓
 *   （代价只是多一次本地回环 HTTP，几 MB 而已。）
 */
async function fetchImageBytes(cfg, image, signal) {
  // ① 先问 ComfyUI 本人要 —— 这是唯一权威的来源
  try {
    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    })
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/view?${query.toString()}`, { timeoutMs: 120000, signal })
    if (res.ok) return Buffer.from(await res.arrayBuffer())
  } catch (error) {
    /* 落下去试本地兜底 */
  }
  // ② 本地目录兜底（老版本 ComfyUI、或 /view 不可用时）
  const local = path.join(cfg.comfyOutputDir, image.subfolder ?? '', image.filename)
  try {
    return await fsp.readFile(local)
  } catch (error) {
    throw new Error(`取图失败：/view 和本地都读不到 ${image.filename}（本地路径 ${local}）`)
  }
}

/**
 * 从 PNG 字节头读尺寸；不是 PNG（或太短）返回 null。
 *
 * ★★ 0.1.2 新增：用来做**尺寸校验** —— 这次事故里插件报的是请求尺寸
 *   （832x1216），而实际拿到的文件是 992x992，机器明明"知道"却没人拦。
 *   加上这道闸，同类问题会**当场报错**，不会再静默产出错图。
 */
function readPngSize(bytes) {
  if (!bytes || bytes.length < 24) return null
  // PNG 魔数：89 50 4E 47
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/* ------------------------------------------------------------------ 工具本体 ---- */

/** 参数 schema（标准 JSON Schema；只用官方 present 用过的那几个关键字）。 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: {
      type: 'string',
      description:
        '画面描述，想画什么就写什么（中文可以）。建议写成一段完整、具体的话：主体 + 外观细节 + 环境 + 光线 + 风格 + 画质词。',
    },
    reference: {
      type: 'string',
      description:
        '参考图的本地文件路径（可选）。**给了就走图生图**：以这张图为参考，按 prompt 改姿势、换环境、换动作，'
        + '保持同一个角色和画风；不给就是普通文生图（只按文字描述画）。PNG / JPG / WEBP 都行。',
    },
    size: {
      type: 'string',
      description: '画幅比例，可选：1:1（默认）、3:4、4:3、2:3、3:2、16:9、9:16。',
    },
    megapixels: {
      type: 'number',
      description: '总像素（百万），默认 1.0。想要更清楚就调大，例如 1.5 或 2.0。',
    },
    steps: {
      type: 'integer',
      description: '采样步数，默认 25，范围 1-60。步数越高越精细、越慢。',
    },
    seed: {
      type: 'integer',
      description: '随机种子。同一提示词 + 同一种子 = 同一张图；不填则每次都不一样。',
    },
    negative: {
      type: 'string',
      description: '负面提示词（不想要的内容）。注意千问模型 cfg=1，负面词基本不生效，一般不用填。',
    },
  },
  required: ['prompt'],
}

/** 结果 schema（标准 JSON Schema）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: '成品图片的绝对路径。' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    seed: { type: 'integer' },
    seconds: { type: 'number', description: '本次出图耗时（秒）。' },
    files: { type: 'array', items: { type: 'string' }, description: '本次产出的全部图片路径。' },
  },
  required: ['path', 'width', 'height', 'seed', 'seconds', 'files'],
}

/**
 * 建工具定义。注意这里**不用 defineTool**：register 要的就是这么个对象。
 * @param ctx - 已注入 tools 的上下文
 * @param cfg - 合并后的配置
 * @param log - 记日志
 * @param onProduced - 出图成功后回调（用来 append 交付事件 + 记活动时间）
 */
function makeDrawTool(ctx, cfg, log, onProduced, onStart) {
  return {
    name: 'draw_image',
    description:
      '用本机 ComfyUI 的千问（Qwen-Image 2.1）模型画图。给一段画面描述就能出图，图片会保存到「千问1生图」目录，' +
      '并把绝对路径回给你，用来在回复里内联显示。纯本地运行，不出网、不花钱、不需要任何 API Key。' +
      '需要先启动 ComfyUI；没启动时本工具会明确告诉你。' +
      '（ComfyUI 空闲 5 分钟没有出图会被自动关闭以释放显存，下次出图前需要重新启动它。）',
    parameters: PARAMETERS,
    timeoutMs: cfg.timeoutMs,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: `已出图：${value.path}（${value.width}x${value.height}，seed ${value.seed}，用时 ${value.seconds}s）`,
        },
      ],
      // 落到 tool/result 的 data.meta，供客户端自己的 draw_image 卡片取图片路径。
      // （注意：客户端只对 read_image 读 meta 当标签，我们自己读是为了自绘卡片。）
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const signal = exec?.signal
      const prompt = String(args?.prompt ?? '').trim()
      if (prompt.length === 0) throw new Error('prompt 不能为空：请描述你想画什么。')
      // ★ 出图**一开始**就记一次活动。否则存在这么一个毫秒级窗口：上次出图已过 5 分钟，
      //   这次刚进来还没 submit（所以 /queue 还是空的），定时器正好 tick 到 → 会把
      //   正在用的后端关掉。先 touch 就彻底堵上这个窗口。
      if (typeof onStart === 'function') onStart()

      const aspect = typeof args?.size === 'string' && ASPECTS[args.size] ? args.size : '1:1'
      const megapixels = Number.isFinite(args?.megapixels) && args.megapixels > 0 ? args.megapixels : 1.0
      const steps = Number.isFinite(args?.steps) ? Math.trunc(args.steps) : cfg.steps
      const seed = Number.isFinite(args?.seed) ? Math.trunc(args.seed) : Math.floor(Math.random() * 2 ** 31)
      const [width, height] = calcSize(aspect, megapixels)

      await ensureComfyUp(cfg, log, signal)

      // ★ 给了参考图就走图生图：先把图**上传**给 ComfyUI，拿到它那边的文件名。
      //   为什么不自己复制进 input 目录：那个目录未必是配置里以为的那个
      //   （ComfyUI 可以用 --input-directory 改），复制过去很可能放错地方 ✗
      //   —— 今天刚在 output 目录上踩过一模一样的坑。
      let reference = ''
      const refPath = typeof args?.reference === 'string' ? args.reference.trim() : ''
      if (refPath !== '') {
        reference = await uploadReference(cfg, refPath, signal)
        log('info', `参考图已上传：${refPath} → ${reference}`)
      }

      const workflow = buildWorkflow(cfg, { prompt, negative: args?.negative, width, height, steps, seed, reference })
      log('info', `提交任务 ${width}x${height} steps=${steps} seed=${seed}${reference === '' ? '（文生图）' : `（图生图 参考=${reference}）`}`)
      const promptId = await submitPrompt(cfg, workflow, signal)

      const started = Date.now()
      const images = await waitForResult(cfg, promptId, {
        signal,
        timeoutMs: cfg.timeoutMs,
        onTick: (note) => log('info', `prompt_id=${promptId} ${note}`),
      })
      const seconds = Number(((Date.now() - started) / 1000).toFixed(1))

      await fsp.mkdir(cfg.outputDir, { recursive: true })
      const savedFiles = []
      let firstPath = ''
      let index = 0
      // ★★ 2026-10-08 主人要求「每次只生一张图」。
      //   提示词里已经写明"只调一次"，但提示词是**期望**、不是**保证** ——
      //   ComfyUI 一次返回多张（batch）时，这里只取第一张就收手，
      //   把"只生一张"落到代码层面 ✓
      for (const image of images.slice(0, 1)) {
        index += 1
        const bytes = await fetchImageBytes(cfg, image, signal)

        // ★★ 尺寸校验（2026-10-08 真事故的防线）：
        //   ComfyUI 的 output 目录被 `--output-directory` 改过，而两个实例的
        //   SaveImage 编号**都从 00001 开始** → 旧目录里恰好躺着同名的旧文件
        //   → 老代码先读本地、读到了 → 把**昨天的图**当成这次的成果，
        //     还按新 prompt 命名、报新请求的尺寸。主人一眼看出"画得完全不对"。
        //   ✓ 现在：取图先走 /view（顺序已反转），这里再加一道 —— 尺寸不符**当场报错**，
        //     绝不静默产出错图。机器"知道"的事，就该拦住。
        //   ⚠ 只对**文生图**校验：图生图的输出尺寸由 resolution=sqrt(W*H) 决定，
        //     和请求的 width/height 本来就不是一回事，校验会误报。
        if (reference === '') {
          const actual = readPngSize(bytes)
          if (actual !== null && (actual.width !== width || actual.height !== height)) {
            throw new Error(
              `ComfyUI 出的图尺寸不对：请求 ${width}x${height}，实际 ${actual.width}x${actual.height}。`
              + '\n这通常意味着取到的不是本次任务的文件（output 目录被改过，或目录里存在同名旧文件）。'
              + `\n本次文件名：${image.filename ?? '(未知)'}`,
            )
          }
        }

        const filename = `${safeStem(prompt, 22)}_${cfg.filePrefix}_${width}x${height}_${String(index).padStart(2, '0')}.png`
        const target = await uniquePath(cfg.outputDir, filename)
        await fsp.writeFile(target, bytes)
        savedFiles.push(target)
        if (firstPath === '') firstPath = target
        log('info', `落盘 ${target}（${bytes.length} 字节）`)
      }
      if (firstPath === '') throw new Error('ComfyUI 报告成功，但没有取到任何图片')

      const value = { path: firstPath, width, height, seed, seconds, files: savedFiles }
      if (onProduced) {
        try {
          onProduced(exec, value)
        } catch (error) {
          log('warn', `交付事件登记失败（不影响出图）：${error?.message ?? error}`)
        }
      }
      return value
    },
  }
}

/* ------------------------------------------------------------------ 插件入口 ---- */

/**
 * 宿主侧入口。按主人的经验（MEMO 5189）：**用局部 `root.inject` 等服务**，
 * 不要用对象级 `inject` —— 对象级会把整个 apply 推迟到服务就绪之后，某个服务
 * 在老宿主里不存在时插件会**永远不 apply**，而且不报错，极难排查。
 */
export function apply(root, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = makeLog(root)
  // ★ 落盘的界面偏好（生图动画）恢复。**优先级低于显式配置** ——
  //   cordis.patch.yml 里写了 flowStyle 就以它为准，没写才用上次在界面上选的。
  const savedUi = readUiState()
  if (rawConfig?.flowStyle === undefined && FLOW_STYLES.includes(savedUi.flowStyle)) {
    cfg.flowStyle = savedUi.flowStyle
    log('info', `生图动画：沿用上次界面选择（${cfg.flowStyle}）`)
  }

  root.inject(['tools', 'sessionProjections'], (ctx) => {
    const status = makeComfyStatus(cfg)
    const idle = makeIdleShutdown(cfg, log, status)

    /** 出图后：登记交付物（与官方 present 同载荷）+ 记一次活动时间。 */
    const pending = new WeakMap()
    const onProduced = (exec, value) => {
      idle.touch()
      const session = exec?.agent?.session
      if (session === undefined) return
      let turn
      try {
        const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
        turn = boundary?.lastTurn
      } catch {
        turn = undefined
      }
      if (!Number.isSafeInteger(turn)) return
      const files = value.files.map((file) => ({ path: file, description: '千问（Qwen-Image 2.1）生成' }))
      pending.set(exec, { session, turn, files })
    }

    const tool = makeDrawTool(ctx, cfg, log, onProduced, () => idle.touch())
    ctx.tools.register(tool)
    log('info', `已注册工具 ${tool.name}（ComfyUI=${cfg.comfyUrl}，输出=${cfg.outputDir}）`)

    // 让"出图后必须在正文里内联展示"成为插件的固有行为，而不是靠模型自觉。
    // 走的是官方那条路（与内核自带的 FILE_REFERENCE_PROMPT 同一机制）：
    // 正文里的 Markdown 图片 → 客户端 fileMediaUrl() 重写成 /api/file?path=… → 真 <img>。
    // ⚠ 不要改用 ImageBlock / presentCall / presentationMeta —— 客户端对非 read_image
    //   工具返回的 image block 只会 JSON.stringify 成文本，present 卡片里也根本没有 <img>。
    try {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        // ★★★ 2026-10-08 十五次修正 —— **删掉"出图前先发动图"这条指令**。
        //   主人早就说过「不用图片了」（改成 DOM 动画块），但我一直没把这条摘掉，
        //   结果出图时**动图和动画块同时出现**，看起来就像"重复发了一遍动画"。
        //   ✓ 现在动画只由客户端的 DOM 块承担 —— 那才是"位置正确、随消息滚动"的正解。
        //     本地副本与图片路由保留，仅作备用，**不再进正文**。
        prepareLoadingGif(cfg, log).catch(() => {})   // 只留一份本地副本备用

        systemPrompt.section({
          name: 'qwen-paint:inline-generated-image',
          order: 9100, // 紧挨内核 DELIVERABLE_FILE_REFERENCES(9000) 之后
          text:
            '用 draw_image 出图后，必须在回复正文里用 Markdown 图片语法把生成的图直接展示给用户：' +
            '![画面简述](<图片的绝对路径>)。不要把图片路径放进代码块，也不要只给路径或链接而不给图。',
        })
        log('info', '已注册 systemPrompt 段落：出图后内联展示')

        // ★ 主人定的铁律（2026-10-07，当天三次加严；2026-10-08 又加两条）：
        //   ① 识别到要生图 → 只简短回一句，然后**立刻开画**（不解释、不列参数、不反问）
        //   ② 出图后 → 回复正文**只保留那一句话，紧接着就是图片**（不写耗时/尺寸/提示词等附加说明）
        //   ③ 生成中的呼吸灯 → 出图后由客户端**平滑过渡**成图片（插件已实现，模型无需描述过程）
        //   ④ ★ 思考过程也要极简 —— 界面上思考块是**显示出来**的，用户要看的是图不是分析
        //   ⑤ ★★ 2026-10-08：**生图意图识别提到最高优先级** —— 判断出来就**第一个动作调工具**
        //   ⑥ ★★ 2026-10-08：**一次只生一张**（代码层面也保证，见落盘那里的 slice(0,1)）
        //
        //   ⚠ 为什么"立刻调工具"等于"立刻切动画"：客户端插件**看不到用户消息**，
        //     它能感知的最早事件就是"工具开始跑"。所以动画起点的早晚，
        //     完全取决于模型多快调用 draw_image —— 提示词越狠，动画来得越早。
        systemPrompt.section({
          name: 'qwen-paint:brief-reply-then-draw',
          order: 9101,
          text:
            '【最高优先级】判断用户是不是想生成图片（「画个…」「生成一张…」「来张…」「给我做张图」' +
            '「用这张图做参考画…」等等）—— **这是你最优先要判断的一件事**。' +
            '★ **一旦判断是生图请求，你的第一个动作就是调用 draw_image**：' +
            '不要先写分析、不要先列参数、不要先反问确认（除非用户完全没说画什么）；' +
            '可以只回一句极短的话（说明你要画什么），然后**立刻**调用工具 —— ' +
            '界面上会在你调用工具的那一刻开始播放出图动画，越早调用动画来得越早。' +
            '★ **一次只生一张图**：一条消息里**只调用一次** draw_image，' +
            '不要连着调多次、也不要一次做多张。' +
            '★ 出图后的回复正文**只保留那一句话，紧接着就是图片**：' +
            '不要写「耗时多少秒」「尺寸多大」「提示词是什么」「用的什么模型」这类附加说明，' +
            '也不要分小标题、不要列清单、不要总结。' +
            '生成期间界面上会自己播放动画、出图后平滑转成图片，**不需要用文字描述这个过程**。' +
            '★ 还有一条同样重要：识别到这是生图请求时，**思考过程保持极简** —— ' +
            '不要长篇分析「画什么风格、用什么构图、参数怎么设、会不会好看」，那些用户不看；' +
            '界面上的思考块是**显示出来**的，越写越长越碍事。直接回一句话、调用工具即可。',
        })
        log('info', '已注册 systemPrompt 段落：生图前一句话、出图后紧跟你图片、不写附加说明')
      }
    } catch (error) {
      log('warn', `注册 systemPrompt 段落失败（不影响出图）：${error?.message ?? error}`)
    }

    // ★★★ 2026-10-08 十七次修正 —— **DSH 启动时预热后端**。
    //
    //   主人反馈「怎么我重启就关闭了」：ComfyUI 是 DSH 的子进程，
    //   DSH 重启时整棵进程树被终止（Windows 默认行为），它被连带带走。
    //   而原来只在"出图时"才拉起 —— 于是每次重启后第一次出图都要冷启动等 30 多秒。
    //
    //   ✓ 修法：插件加载后**立刻在后台探一次**，不在线就异步拉起。
    //     这样重启 DSH 之后不用等出图，后端已经在跑了。
    //     ⚠ 完全异步：不 await、不阻塞插件加载，更不阻塞 DSH 启动；
    //       失败只 warn（出图时还有一次自动启动兜底，不会因为预热失败而画不了图）。
    try {
      ctx.effect(() => {
        if (cfg.autoStartComfy === false) return undefined
        let cancelled = false
        Promise.resolve()
          .then(() => status.probe(false))
          .then((online) => {
            if (cancelled) return undefined
            // ★★★ 2026-10-08 修「自动关闭失效」（主人实测）：
            //   原来空闲计时**只在出图成功之后**才开启（lastActivityAt 初始为 null），
            //   而 tick() 的第一道判断就是 `if (state.lastActivityAt === null) return false`
            //   —— 于是"重启 DSH 之后一次图都没画"的场景里，**它永远不关**，
            //   主人在菜单里选「1 分钟后关闭」也没用（状态显示为"在线"，不是"空闲 N 分"）。
            //   ✓ 现在：预热这一趟只要**确认后端在线**（原本就在线、或刚被拉起来），
            //     就把计时起点定在此刻。之后 N 分钟没有新活动，照样会关。
            //     （出图开始时 / 出图成功后依然会 touch 续期，原有语义不变。）
            if (online) {
              idle.touch()
              log('info', '启动预热：ComfyUI 已在线（空闲计时从此刻开始）')
              return undefined
            }
            log('info', '启动预热：ComfyUI 不在线，后台拉起（隐藏窗口）')
            return ensureComfyUp(cfg, log, null).then((started) => {
              if (!cancelled) idle.touch()
              return started
            })
          })
          .catch((error) => log('warn', `启动预热失败（出图时还会再试）：${error?.message ?? error}`))
        return () => { cancelled = true }
      }, 'qwen-paint:warmup')
    } catch (error) {
      log('warn', `注册启动预热失败（不影响出图）：${error?.message ?? error}`)
    }

    // 官方 present 就是这么干的：工具**成功**之后才 append 交付事件。
    ctx.on('tools/result', (exec, result) => {
      const delivery = pending.get(exec)
      pending.delete(exec)
      if (delivery === undefined || result?.isError) return
      try {
        delivery.session.append('deliverables/presented', {
          turn: delivery.turn,
          callId: exec.callId,
          files: delivery.files,
        })
      } catch (error) {
        log('warn', `append deliverables/presented 失败：${error?.message ?? error}`)
      }
    })

    // 空闲关停的定时器：随 ctx 卸载自动清掉。
    // ★ 全包 try/catch：宿主若缺 ctx.effect（裁剪版/老版本），也不许把插件加载拖垮。
    if (cfg.autoShutdown) {
      try {
        ctx.effect(() => {
          const timer = setInterval(() => {
            idle.tick().catch((error) => log('warn', `空闲检查出错：${error?.message ?? error}`))
          }, cfg.idleCheckMs)
          // 别让这个定时器把 node 进程吊住
          if (typeof timer.unref === 'function') timer.unref()
          log('info', `空闲关停已启用：出图后 ${Math.round(cfg.idleShutdownMs / 60000)} 分钟没再出图就关掉 ComfyUI`)
          return () => clearInterval(timer)
        }, 'qwen-paint:idle-shutdown')
      } catch (error) {
        log('warn', `启动空闲关停失败（不影响出图）：${error?.message ?? error}`)
      }
    }

    // 只读状态端点（客户端的状态指示器读它）。webServer 是可选服务 → 用局部 inject，
    // 没有它插件照常出图，只是不显示状态。
    // ★ ctx.inject 本身也可能不存在 → 先检查，宿主差异不许把插件加载拖垮。
    if (typeof ctx.inject !== 'function') {
      log('warn', '宿主没有 ctx.inject，跳过状态端点（不影响出图）')
      return
    }
    ctx.inject(['webServer'], (webCtx) => {
      // ★ 命中计数：用来**从外部**判断客户端的状态指示器到底加载了没有 ——
      //   它每 5 秒轮询一次、且优先打 /api/ 那条路径；api 计数一直涨就说明
      //   客户端半边确实加载并在运行（哪怕界面上暂时没看见）。
      //   我自己用 PowerShell 探测走的是不带 /api/ 的根路径，两者互不混淆。
      const visits = { api: 0, plain: 0, pings: [], firstAt: null, lastAt: null }
      const handler = async (req, res) => {
        try {
          const hit = String(req?.url ?? '')
          if (hit.startsWith('/api/')) visits.api += 1
          else visits.plain += 1
          // 客户端会在 apply 的每个分支自报一次（?ping=apply / no-react / no-slots / registered），
          // 去重记下来 —— 这是判断"客户端到底加载到哪一步"的唯一外部依据。
          const ping = /[?&]ping=([^&]*)/u.exec(hit)
          if (ping !== null) {
            let reason = ping[1]
            try { reason = decodeURIComponent(reason) } catch { /* 原样用 */ }
            if (reason !== '' && !visits.pings.includes(reason)) visits.pings.push(reason)
          }
          if (visits.firstAt === null) visits.firstAt = Date.now()
          visits.lastAt = Date.now()
        } catch {
          /* 计数失败不影响状态返回 */
        }
        if (!isLocalRequest(req)) {
          respondJson(res, { ok: false, reason: 'local requests only' }, 403)
          return
        }
        try {
          const online = await status.probe()
          // ★★ 2026-10-07 新增：`?idleMinutes=N` 现场改「多久没出图就自动关掉后端」。
          //   N = 0 表示**不自动关闭**。安全性：这个端点只放行本机请求（isLocalRequest 在更上面挡住），
          //   而且只改一个数字，不碰任何路径或命令；越界值直接忽略。
          const query = new URL(req.url ?? '/', 'http://127.0.0.1')
          const rawMinutes = query.searchParams.get('idleMinutes')
          if (rawMinutes !== null) {
            const minutes = Number(rawMinutes)
            if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) {
              cfg.idleShutdownMs = Math.round(minutes) * 60000
              // ★★★ 2026-10-08 修「自动关闭失效」：**选完档位就从此刻开始计时**。
              //   原来这里只改数字、不碰计时起点，于是"重启后从没出过图（起点为 null）"
              //   时，主人选了「1 分钟后关闭」也不会关 —— 他实测报的就是这个。
              //   选 0（不自动关闭）时不留起点，保持"不关"的语义干净。
              if (minutes > 0) idle.touch()
              log('info', minutes <= 0
                ? '空闲关停：已按界面选择关闭（不再自动关后端）'
                : `空闲关停：已按界面选择改为 ${Math.round(minutes)} 分钟`)
            }
          }

          // ★★ 2026-10-08 新增：`?flowStyle=xxx` 现场改「生图过程的动画」。
          //   界面（composer 状态点的菜单）点一下就调这里；合法值**立刻落盘**，
          //   重启 DSH 之后照样记得住。非法值只记一行日志、绝不写进样式名。
          const rawStyle = query.searchParams.get('flowStyle')
          if (rawStyle !== null) {
            if (FLOW_STYLES.includes(rawStyle)) {
              cfg.flowStyle = rawStyle
              // 合并写：别把文件里以后可能新增的其它偏好字段冲掉
              writeUiState({ ...readUiState(), flowStyle: rawStyle }, log)
              log('info', `生图动画已改为 ${rawStyle}`)
            } else {
              log('warn', `生图动画取值不在白名单里，已忽略：${String(rawStyle).slice(0, 40)}`)
            }
          }

          const busy = online ? await status.queueBusy() : false
          respondJson(res, {
            ok: true, online, busy, url: cfg.comfyUrl, visits,
            flowStyle: cfg.flowStyle,
            ...idle.snapshot(),
          })
        } catch (error) {
          // 任何意外都回 200 + 可读原因，让前端能显示"未知"而不是报错
          respondJson(res, { ok: false, reason: String(error?.message ?? error) })
        }
      }
      try {
        webCtx.effect(() => {
          const disposers = [
            '/api/qwen-paint/status.json',
            '/qwen-paint/status.json',
          ].map((routePath) => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }))
          log('info', '已注册只读状态端点 /api/qwen-paint/status.json')
          return () => { for (const dispose of disposers) dispose() }
        }, 'qwen-paint:status-route')
      } catch (error) {
        log('warn', `注册状态端点失败（不影响出图）：${error?.message ?? error}`)
      }

      // ★★★ 2026-10-08：**插件自己的动画图片路由** —— 这是"做进插件的新功能"。
      //
      // 为什么需要它（一路试出来的结论）：
      //   · 内核的 `/api/file?path=…` 只肯服务"**被登记过的**文件"：真图是 draw_image 的交付物，
      //     所以正常显示；而「正在生成」动图没被登记 → 一律回「图片无法预览」
      //     （GIF / WebP / 静态 PNG **三种都试过**，与格式无关，也与文件名无关）。
      //   · 往消息树里插 DOM 更不行 —— 会把界面搞成整片空白（React 管理那棵树）。
      //   · 改 app.asar 里的内核代码也不能做：DSH 一升级就全被覆盖。
      // ✓ 正解：由插件自己开一个路由**直接吐字节**，绕开 /api/file 的登记限制；
      //   而且它属于插件本身，**升级 DSH 也不会丢**。
      try {
        webCtx.effect(() => {
          const assetRoute = (name, mime) => async (req, res) => {
            try {
              if (!isLocalRequest(req)) {
                respondJson(res, { ok: false, reason: 'local requests only' }, 403)
                return
              }
              const bytes = await fsp.readFile(
                fileURLToPath(new URL(`../assets/${name}`, import.meta.url)),
              )
              res.writeHead(200, {
                'content-type': mime,
                'content-length': bytes.length,
                'cache-control': 'public, max-age=3600',
                'access-control-allow-origin': '*',
              })
              res.end(bytes)
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
            }
          }
          const disposers = [
            webCtx.webServer.register({
              kind: 'exact',
              path: '/qwen-paint/loading.webp',
              handler: assetRoute('loading.webp', 'image/webp'),
            }),
            webCtx.webServer.register({
              kind: 'exact',
              path: '/qwen-paint/loading.gif',
              handler: assetRoute('loading.gif', 'image/gif'),
            }),
          ]
          log('info', '已注册动画图片路由 /qwen-paint/loading.webp')
          return () => { for (const dispose of disposers) dispose() }
        }, 'qwen-paint:animation-route')
      } catch (error) {
        log('warn', `注册动画图片路由失败（不影响出图）：${error?.message ?? error}`)
      }
    })
  })
}

/** 给自测用的内部导出（真机不依赖这些）。 */
export const __internal = {
  DEFAULTS,
  ASPECTS,
  FLOW_STYLES,
  calcSize,
  r32,
  safeStem,
  buildWorkflow,
  makeDrawTool,
  uniquePath,
  portOf,
  makeComfyStatus,
  makeIdleShutdown,
  isLocalRequest,
}
