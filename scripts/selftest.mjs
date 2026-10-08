/**
 * dsh-qwen-paint — 自测（纯 Node，不联网、不需要真 ComfyUI、不出图）
 * ============================================================================
 * 用**假的 ComfyUI HTTP 服务器** + 假的 cordis 上下文，把插件真跑一遍：
 *   ① 模块形状与 `root.inject` 等的服务名对不对
 *      （★ cordis 里服务名拼错**不报错、只会永远等不到**，所以这条必须断言）
 *   ② 工具定义形状合法：register 只强校验 output.schema 是 JSON Schema
 *   ③ 参数/结果 schema 的结构（object 根、required、只用支持的关键字）
 *   ④ 纯函数：尺寸换算（32 对齐）、文件名清洗
 *   ⑤ workflow 结构与主人正在用的那份逐节点对齐
 *   ⑥ 端到端：探活 → 提交 → 轮询 → 取图 → 落盘 → 返回值
 *   ⑦ 交付事件 `deliverables/presented` 的载荷与官方 present 一致
 *   ⑧ ComfyUI 没启动时给出可照做的报错（而不是含糊失败）
 *
 * 运行：node scripts/selftest.mjs
 * ============================================================================
 */

import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Windows 上动态 import 绝对路径必须是 file:// URL，直接给 'C:\...' 会报
// ERR_UNSUPPORTED_ESM_URL_SCHEME。
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { calcSize, safeStem, buildWorkflow, DEFAULTS } = mod.__internal

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` —— ${JSON.stringify(detail)}`}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}

/* ------------------------------------------------- 假 ComfyUI HTTP 服务器 ---- */

let submittedBody = null
let historyCalls = 0
/** 空闲关停判定"忙不忙"要读它；默认空队列 = 不忙。 */
let queuePayload = { queue_running: [], queue_pending: [] }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (url.pathname === '/system_stats') return send(200, { system: { comfyui_version: 'selftest' } })
  if (url.pathname === '/queue') return send(200, queuePayload)
  if (url.pathname === '/prompt') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      submittedBody = JSON.parse(body)
      send(200, { prompt_id: 'selftest-pid' })
    })
    return
  }
  if (url.pathname === '/history/selftest-pid') {
    historyCalls += 1
    return send(200, {
      'selftest-pid': {
        status: { status_str: 'success', completed: true },
        outputs: { 10: { images: [{ filename: 'fake_out.png', subfolder: '', type: 'output' }] } },
      },
    })
  }
  send(404, {})
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/* ------------------------------------------------------------- 临时目录 ---- */

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-paint-selftest-'))
// ★★ 自测必须**隔离界面偏好文件**：host 会把「生图动画」的选择写进 $DSH_HOME。
//    不隔离的话，自测会去覆盖主人真实的那份偏好（等于把他选的动画改掉）。
//    uiStatePath() 是**调用时**才读这个环境变量，所以在这里设就够了。
process.env.DSH_HOME = tmp
const comfyOut = path.join(tmp, 'comfy-out')
const outDir = path.join(tmp, 'out')
await fsp.mkdir(comfyOut, { recursive: true })
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6])
await fsp.writeFile(path.join(comfyOut, 'fake_out.png'), FAKE_PNG)

/* ------------------------------------------------------------- 假 cordis ---- */

const registered = []
const listeners = new Map()
const appended = []
const hostEffects = []
const injectedExtra = []
const hostRoutes = []
const fakeSession = { append: (type, data) => { appended.push({ type, data }); return {} } }
const fakeLogger = { info() {}, warn() {}, error() {}, debug() {} }
const ctx = {
  logger: fakeLogger,
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  on(event, handler) {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
    return () => {}
  },
  sessionProjections: { stateOf: () => ({ lastTurn: 7, openTurnStartSeq: 3 }) },
  effect(callback, label) { hostEffects.push({ label, dispose: callback() }); return () => {} },
  inject(services, callback) { injectedExtra.push(services); return callback(ctx) },
  webServer: { register(route) { hostRoutes.push(route); return () => {} } },
}
let injectedServices = null
const root = {
  logger: fakeLogger,
  inject(services, callback) {
    injectedServices = services
    return callback(ctx)
  },
}

/* ================================================================ 开始断言 ==== */

section('① 模块形状与服务名')
check('导出 name === "qwen-paint"', mod.name === 'qwen-paint', mod.name)
check('导出 apply 是函数', typeof mod.apply === 'function')

mod.apply(root, {
  comfyUrl: `http://127.0.0.1:${port}`,
  comfyOutputDir: comfyOut,
  outputDir: outDir,
  pollIntervalMs: 10,
  timeoutMs: 15000,
})
check('root.inject 收到了服务清单', Array.isArray(injectedServices), injectedServices)
check('注入了 tools', injectedServices?.includes('tools'), injectedServices)
check('注入了 sessionProjections（交付事件要用 turn）', injectedServices?.includes('sessionProjections'), injectedServices)

section('② 工具定义形状（register 的硬校验）')
check('恰好注册了 1 个工具', registered.length === 1, registered.length)
const tool = registered[0] ?? {}
check('工具名是 draw_image', tool.name === 'draw_image', tool.name)
check('有 description', typeof tool.description === 'string' && tool.description.length > 20)
check('output 是对象', typeof tool.output === 'object' && tool.output !== null)
check('output.render 是函数（register 强校验）', typeof tool.output.render === 'function')
check('output.schema 存在', typeof tool.output.schema === 'object' && tool.output.schema !== null)
check('execute 是函数', typeof tool.execute === 'function')
check('timeoutMs 是正有限数', Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, tool.timeoutMs)
check('有 presentationMeta（把图片路径带给客户端卡片）', typeof tool.output.presentationMeta === 'function')
const metaProbe = typeof tool.output.presentationMeta === 'function' ? tool.output.presentationMeta({}, { path: 'C:\\x\\a.png' }) : null
check('presentationMeta 返回 {path}', metaProbe?.path === 'C:\\x\\a.png', metaProbe)

section('③ schema 结构')
check('parameters 根是 object', tool.parameters?.type === 'object')
check('parameters 要求 prompt', Array.isArray(tool.parameters?.required) && tool.parameters.required.includes('prompt'))
check('prompt 是 string', tool.parameters?.properties?.prompt?.type === 'string')
check('parameters 关闭额外字段', tool.parameters?.additionalProperties === false)
check('output.schema 根是 object', tool.output?.schema?.type === 'object')
check(
  'output.schema 要求 path/width/height/seed/seconds/files',
  ['path', 'width', 'height', 'seed', 'seconds', 'files'].every((k) => tool.output?.schema?.required?.includes(k)),
  tool.output?.schema?.required,
)
const renderBlocks = tool.output?.render?.({}, { path: 'X:\\a.png', width: 992, height: 992, seed: 1, seconds: 2, files: ['X:\\a.png'] })
check('render 返回文本块数组', Array.isArray(renderBlocks) && renderBlocks[0]?.type === 'text', renderBlocks)
check('render 文本里带路径', typeof renderBlocks?.[0]?.text === 'string' && renderBlocks[0].text.includes('a.png'))

section('④ 纯函数：尺寸换算（32 对齐）')
check('1:1 @1MP → 992x992', JSON.stringify(calcSize('1:1', 1)) === JSON.stringify([992, 992]), calcSize('1:1', 1))
check('16:9 @1MP → 1344x736', JSON.stringify(calcSize('16:9', 1)) === JSON.stringify([1344, 736]), calcSize('16:9', 1))
check('9:16 @1MP → 736x1344', JSON.stringify(calcSize('9:16', 1)) === JSON.stringify([736, 1344]), calcSize('9:16', 1))
// 2:3@1MP：w=sqrt(1e6*2/3)=816.5→r32=832；h=r32(816.5/(2/3))=r32(1224.7)=1216。
// 注意 h 用**未对齐的 w** 除以比例算，与 app.py 的 `return r32(w), r32(w / ar)` 一致。
check('2:3 @1MP → 832x1216', JSON.stringify(calcSize('2:3', 1)) === JSON.stringify([832, 1216]), calcSize('2:3', 1))
check('未知比例退化为 1:1', JSON.stringify(calcSize('乱写', 1)) === JSON.stringify([992, 992]))
check('尺寸都是 32 的倍数', calcSize('4:3', 1.5).every((v) => v % 32 === 0), calcSize('4:3', 1.5))

section('⑤ 纯函数：文件名清洗')
check('中文截断保留', safeStem('一只在雪地里的柴犬，逆光，胶片颗粒，超广角，电影感', 22).length <= 22, safeStem('一只在雪地里的柴犬，逆光，胶片颗粒，超广角，电影感', 22))
const enStem = safeStem('a cute shiba inu puppy running on snowy field at golden hour', 22)
check('英文按词截断（≤34）且不留尾空格', enStem.length <= 34 && enStem === enStem.trim(), enStem)
check('剥掉 Windows 非法字符', !/[\\/:*?"<>|]/.test(safeStem('a/b\\c:d*e?f"g<h>i|j', 40)), safeStem('a/b\\c:d*e?f"g<h>i|j', 40))
check('空提示词给「无题」', safeStem('', 22) === '无题')

section('⑥ workflow 与主人正在用的那份对齐')
const wf = buildWorkflow({ ...DEFAULTS }, { prompt: '测试', negative: '', width: 992, height: 992, steps: 25, seed: 42 })
check('节点 1 UNETLoader 用千问 2.1 int8', wf['1']?.class_type === 'UNETLoader' && wf['1'].inputs.unet_name === 'qwen_image_2.1_int8_convrot.safetensors')
check('节点 2 CLIPLoader type=qwen_image', wf['2']?.inputs.type === 'qwen_image' && wf['2'].inputs.clip_name === 'qwen3vl_8b_w4a8.safetensors')
check('节点 3 VAELoader 用 2.1 的 vae', wf['3']?.inputs.vae_name === 'qwen_image_2.1_vae_bf16.safetensors')
check('节点 5 TextEncodeQwenImage21', wf['5']?.class_type === 'TextEncodeQwenImage21')
check('节点 5 clip 连到 2:0', JSON.stringify(wf['5'].inputs.clip) === JSON.stringify(['2', 0]))
check('节点 6 EmptyLatentImage 尺寸正确', wf['6']?.inputs.width === 992 && wf['6'].inputs.height === 992 && wf['6'].inputs.batch_size === 1)
check('节点 7 QwenImage21Cache 接 1:0', wf['7']?.class_type === 'QwenImage21Cache' && JSON.stringify(wf['7'].inputs.model) === JSON.stringify(['1', 0]))
check('节点 8 KSampler cfg=1.0（负面词不生效的原因）', wf['8']?.inputs.cfg === 1.0)
check('节点 8 euler + simple', wf['8'].inputs.sampler_name === 'euler' && wf['8'].inputs.scheduler === 'simple')
check('节点 8 正负提示词接 5:0 / 5:1', JSON.stringify(wf['8'].inputs.positive) === JSON.stringify(['5', 0]) && JSON.stringify(wf['8'].inputs.negative) === JSON.stringify(['5', 1]))
check('节点 8 latent 接 6:0', JSON.stringify(wf['8'].inputs.latent_image) === JSON.stringify(['6', 0]))
check('节点 8 seed 生效', wf['8'].inputs.seed === 42)
check('节点 9 VAEDecode', wf['9']?.class_type === 'VAEDecode' && JSON.stringify(wf['9'].inputs.vae) === JSON.stringify(['3', 0]))
check('节点 10 SaveImage 接 9:0', wf['10']?.class_type === 'SaveImage' && JSON.stringify(wf['10'].inputs.images) === JSON.stringify(['9', 0]))
check('步数被夹到 1..60', buildWorkflow({ ...DEFAULTS }, { prompt: '', width: 992, height: 992, steps: 999, seed: 1 })['8'].inputs.steps === 60)

section('⑦ 端到端：探活 → 提交 → 轮询 → 落盘 → 返回值')
const exec = { signal: new AbortController().signal, callId: 'call-abc', agent: { session: fakeSession } }
let value = null
try {
  value = await tool.execute({ prompt: '一只在雪地里的柴犬', size: '16:9', seed: 42 }, exec)
} catch (error) {
  check('execute 不应抛错', false, String(error?.message ?? error))
}
check('返回宽高与 16:9 一致', value?.width === 1344 && value?.height === 736, value && [value.width, value.height])
check('返回 seed 是传入值', value?.seed === 42, value?.seed)
check('返回耗时是正数', typeof value?.seconds === 'number' && value.seconds >= 0, value?.seconds)
check('返回 1 个文件路径', Array.isArray(value?.files) && value.files.length === 1, value?.files)
check('路径落在输出目录里', typeof value?.path === 'string' && value.path.startsWith(outDir), value?.path)
const onDisk = value?.path === undefined ? null : await fsp.readFile(value.path).catch(() => null)
check('文件真的落盘了', onDisk !== null)
check('落盘字节与来源一致', onDisk !== null && Buffer.compare(onDisk, FAKE_PNG) === 0)
check('文件名符合约定', /_Qwen2\.1_1344x736_01\.png$/u.test(path.basename(value?.path ?? '')), path.basename(value?.path ?? ''))
check('提交体带 client_id', typeof submittedBody?.client_id === 'string' && submittedBody.client_id.length > 0, submittedBody?.client_id)
check('提交的是 prompt 字段包裹的 workflow', submittedBody?.prompt?.['5']?.inputs?.prompt === '一只在雪地里的柴犬')
check('提交的尺寸正确', submittedBody?.prompt?.['6']?.inputs?.width === 1344 && submittedBody?.prompt?.['6']?.inputs?.height === 736)
check('提交的 seed 正确', submittedBody?.prompt?.['8']?.inputs?.seed === 42)
check('轮询确实发生了', historyCalls > 0, historyCalls)

section('⑧ 交付事件（与官方 present 同一套载荷）')
for (const handler of listeners.get('tools/result') ?? []) handler(exec, { isError: false })
check('监听了 tools/result', (listeners.get('tools/result') ?? []).length === 1)
check('append 了 deliverables/presented', appended[0]?.type === 'deliverables/presented', appended[0]?.type)
check('载荷带 turn（整数）', Number.isSafeInteger(appended[0]?.data?.turn), appended[0]?.data?.turn)
check('载荷带 callId', appended[0]?.data?.callId === 'call-abc', appended[0]?.data?.callId)
check('载荷 files 是 [{path,description}]', Array.isArray(appended[0]?.data?.files) && appended[0].data.files[0]?.path === value?.path, appended[0]?.data?.files)
check('失败的调用不登记交付（isError 分支）', (() => {
  const before = appended.length
  for (const handler of listeners.get('tools/result') ?? []) handler(exec, { isError: true })
  return appended.length === before
})())

section('⑨ ComfyUI 没启动时的报错要能照做')
const deadTool = mod.__internal.makeDrawTool(
  { ...ctx },
  // ★ 必须显式关掉自动启动：否则它会**真的去启动 ComfyUI** 并死等 startTimeoutMs
  //   （自测会挂住 + 产生真实副作用）。这一节测的是"连不上时的报错文案"。
  { ...DEFAULTS, comfyUrl: 'http://127.0.0.1:1', outputDir: outDir, pollIntervalMs: 10, autoStartComfy: false },
  () => {},
  null,
)
let deadMessage = ''
try {
  await deadTool.execute({ prompt: 'x' }, { signal: new AbortController().signal })
} catch (error) {
  deadMessage = String(error?.message ?? error)
}
check('报错提到连不上 ComfyUI', deadMessage.includes('连不上本机 ComfyUI'), deadMessage.slice(0, 120))
check('报错给出启动办法', deadMessage.includes('ComfyUI.bat'), deadMessage.slice(0, 200))
check('报错带上地址', deadMessage.includes('127.0.0.1:1'))

section('⑩ 空提示词要被拦住')
let emptyMessage = ''
try {
  await tool.execute({ prompt: '   ' }, exec)
} catch (error) {
  emptyMessage = String(error?.message ?? error)
}
check('空 prompt 抛错', emptyMessage.includes('prompt 不能为空'), emptyMessage.slice(0, 80))

section('⑪ 客户端半边：给 draw_image 一张自己的卡片')
// client.js 是**非 ESM 的浏览器脚本**（走 window.__ModuleLoader__），用 Function 当沙箱跑，
// 只喂 window / document；这样不用重启 DSH 就能验证卡片的渲染逻辑。
const clientCode = await fsp.readFile(path.join(ROOT, 'lib', 'client.js'), 'utf8')
let loaderCall = null
const fakeWindow = { __ModuleLoader__: { load(options) { loaderCall = options } }, innerHeight: 800 }
const styleNodes = []
const fakeDocument = {
  head: { appendChild: (node) => styleNodes.push(node) },
  createElement: () => ({
    id: '',
    className: '',
    textContent: '',
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value) },
    appendChild() {},
    remove() { const i = styleNodes.indexOf(this); if (i >= 0) styleNodes.splice(i, 1) },
  }),
}
new Function('window', 'document', clientCode)(fakeWindow, fakeDocument)
check('脚本调了 window.__ModuleLoader__.load', loaderCall !== null)
check('注册 id 与包名一致', loaderCall?.id === 'dsh-qwen-paint', loaderCall?.id)

const fakeReact = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    }
  },
  // 自测桩：只要存在即可（真实语义由 DSH 的 React 提供）。
  // ★ 它们**必须存在**，否则插件会走"hooks 不齐就跳过 dock 注册"的降级分支。
  useRef: () => ({ current: null }),
  useEffect: () => undefined,
}
const clientModule = loaderCall?.factory((name) => (name === 'react' ? fakeReact : undefined))
check('客户端模块导出 apply', typeof clientModule?.apply === 'function')
check('客户端模块导出 name', clientModule?.name === 'dsh-qwen-paint', clientModule?.name)
// ★ 这条是防回归的关键：漏了 exports.inject 的话，apply 可能早于 slots 就绪，
//   ctx.slots 为 undefined → 守卫安静 return → 重启后图永远不显示且不报错。
check('导出 inject 声明了 slots', Array.isArray(clientModule?.inject) && clientModule.inject.includes('slots'), clientModule?.inject)

const injectedKeys = []
const clientRegistrations = []
const effects = []
const fakeClientCtx = {
  effect(callback, label) { effects.push(label); return callback() },
  slots: {
    inject(key, callback) { injectedKeys.push(key); return callback() },
    register(options, component) { clientRegistrations.push({ options, component }); return () => {} },
  },
}
clientModule.apply(fakeClientCtx)
check('注册了样式 effect（卸载时摘样式）', effects.includes('qwen-paint:style'), effects)
check('注入的槽是 tool.call.toolview', injectedKeys.includes('tool.call.toolview'), injectedKeys)
check('注册了 2 个格子（图片卡片 + 状态点）', clientRegistrations.length === 2, clientRegistrations.length)
check('格子 0 key = draw_image', clientRegistrations[0]?.options?.key === 'draw_image', clientRegistrations[0]?.options)
const statusOptions = clientRegistrations[1]?.options
check('状态点挂在 input.right（发送按钮前面，避免中间空白）', statusOptions?.name === 'conversation.input.right', statusOptions)
check('状态点 id 是自己的（不抢自带位置）', statusOptions?.id === 'qwen-paint-status', statusOptions)
check('状态点给了 order', typeof statusOptions?.order === 'number', statusOptions)
const dockOptions = clientRegistrations[1]

// 让 useEffect 真的跑一次，从而走到 mountStatus 的纯 DOM 挂载路径，然后立刻清理
const fakeSeat = {
  className: '',
  textContent: '',
  attrs: {},
  children: [],
  appendChild(child) { this.children.push(child); return child },
  setAttribute(name, value) { this.attrs[name] = String(value) },
}
let effectCleanup = null
fakeReact.useRef = () => ({ current: fakeSeat })
fakeReact.useEffect = (fn) => { effectCleanup = fn() }
const dockVnode = dockOptions === undefined ? null : clientRegistrations[1].component()
check('状态指示器渲染出座位 span', dockVnode?.props?.className === 'dshqp-seat', dockVnode?.props)
check('座位里挂了圆点 + 文字两个元素', fakeSeat.children.length === 2, fakeSeat.children.length)
check('圆点带上了状态的 data 属性', fakeSeat.children[0]?.attrs?.['data-state'] !== undefined, fakeSeat.children[0]?.attrs)
if (typeof effectCleanup === 'function') effectCleanup()
check('清理函数把座位文字清空（停轮询）', fakeSeat.textContent === '', fakeSeat.textContent)
check('样式进了文档头（卡片样式 + 流光样式两张表）', styleNodes.length === 2, styleNodes.map((el) => el.id))
const gradSheet = styleNodes.find((el) => el.id === 'dshqp-flowgrad-css') ?? null
check('★ 流光样式表已注入（id 对得上）', gradSheet !== null, styleNodes.map((el) => el.id))
check(
  '★ 流光样式表里 15 条渐变 + 15 个菜单色块一条不少',
  typeof gradSheet?.textContent === 'string' &&
    gradSheet.textContent.includes('.dshqp-flow-grad-aurora::before {') &&
    gradSheet.textContent.includes('.dshqp-menu-swatch-aurora {') &&
    (gradSheet.textContent.match(/\.dshqp-flow-grad-[a-z]+::before \{/gu) ?? []).length === 15,
  typeof gradSheet?.textContent === 'string' ? gradSheet.textContent.length : null,
)
check(
  '★ 渐变层**不平铺**（135deg 斜纹平铺必然错位 —— 主人截图里那道竖条就是这么来的）',
  typeof gradSheet?.textContent === 'string' &&
    gradSheet.textContent.includes('background-repeat: no-repeat') &&
    !gradSheet.textContent.includes('background-repeat: repeat') &&
    gradSheet.textContent.includes('inset: -200%'),
)
check(
  '★ 流光关键帧是"平移放大层"（7s 单程、来回折返，不再靠 background-position 平铺）',
  typeof gradSheet?.textContent === 'string' &&
    gradSheet.textContent.includes('@keyframes dshqp-flowgrad-run') &&
    gradSheet.textContent.includes('translate3d(38%, 38%, 0)'),
)
check(
  '★ 用 alternate 原路倒放回来（衔接处不再"跳回起点"）',
  typeof gradSheet?.textContent === 'string' &&
    gradSheet.textContent.includes('7s ease-in-out infinite alternate'),
)
check(
  '★ 渐变是 135deg（左上扫到右下）—— 15 条渐变各 2 处（动画块 + 菜单色块）一个不漏',
  (gradSheet?.textContent?.match(/linear-gradient\(135deg,rgb/gu) ?? []).length === 30,
  (gradSheet?.textContent?.match(/linear-gradient\(135deg,rgb/gu) ?? []).length,
)
check(
  '★ 每条渐变都首尾同色（否则循环回头时会跳一下）',
  (() => {
    if (typeof gradSheet?.textContent !== 'string') return false
    const rows = gradSheet.textContent.match(/\.dshqp-flow-grad-[a-z]+::before \{ background-image: ([^;]+); \}/gu) ?? []
    if (rows.length !== 15) return false
    return rows.every((row) => {
      const stops = row.match(/rgb\([^)]+\)/gu) ?? []
      return stops.length >= 5 && stops[0] === stops[stops.length - 1]
    })
  })(),
  typeof gradSheet?.textContent === 'string' ? gradSheet.textContent.length : null,
)

const Card = clientRegistrations[0]?.component
function findVnode(node, predicate) {
  if (node === null || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = findVnode(child, predicate)
    if (hit) return hit
  }
  return null
}

// ★ 用明显的"测试路径"，不写真实用户目录（发出去的包里不该出现 Windows 用户目录绝对路径）
const ZH_PATH = 'C:\\test\\千问1生图\\猫_Qwen2.1_992x992_01.png'
const resultVnode = Card({ phase: 'result', block: { meta: { path: ZH_PATH }, content: [] } })
const imgVnode = findVnode(resultVnode, (n) => n.type === 'img')
check('result 阶段渲染出 <img>', imgVnode !== null)
check('src 走 api/file 相对路由（与内核 fileMediaUrl 等价）', typeof imgVnode?.props?.src === 'string' && imgVnode.props.src.startsWith('api/file?path='), imgVnode?.props?.src)
check('中文路径被正确编码', imgVnode?.props?.src?.includes(encodeURIComponent('猫_Qwen2.1_992x992_01.png')))

const fallbackVnode = Card({
  phase: 'result',
  block: { content: [{ type: 'text', text: '已出图：C:\\out\\b.png（992x992，seed 1，用时 2s）' }] },
})
const fallbackImg = findVnode(fallbackVnode, (n) => n.type === 'img')
check('meta 缺失时能退回解析结果文本里的路径', fallbackImg?.props?.src?.includes(encodeURIComponent('C:\\out\\b.png')), fallbackImg?.props?.src)

const startVnode = Card({ phase: 'start', block: {} })
check('start 阶段渲染出 RGB 呼吸灯（不能白屏）', findVnode(startVnode, (n) => n.props?.className === 'dshqp-lamp') !== null, startVnode)
check('start 阶段有小字「正在生成图片」', JSON.stringify(startVnode).includes('正在生成图片'), startVnode)
const preparingVnode = Card({ phase: 'preparing', block: {} })
check('preparing 阶段同样是呼吸灯', findVnode(preparingVnode, (n) => n.props?.className === 'dshqp-lamp') !== null)

const errorVnode = Card({ phase: 'result', block: { isError: true, content: [{ type: 'text', text: '连不上本机 ComfyUI' }] } })
check('失败时显示错误原文', JSON.stringify(errorVnode).includes('连不上本机 ComfyUI'), errorVnode)
check('失败时不渲染图', findVnode(errorVnode, (n) => n.type === 'img') === null)

// 拿不到 React 时必须**不注册**（否则组件一渲染就 TypeError，污染 dsh 渲染树）
let loaderCallNoReact = null
const fakeWindow2 = { __ModuleLoader__: { load(options) { loaderCallNoReact = options } } }
new Function('window', 'document', clientCode)(fakeWindow2, fakeDocument)
const noReactModule = loaderCallNoReact?.factory(() => undefined)
const registrationsNoReact = []
noReactModule.apply({
  effect: (cb) => cb(),
  slots: { inject: (k, cb) => cb(), register: (o, c) => { registrationsNoReact.push(o); return () => {} } },
})
check('拿不到 React 时安静降级（不注册槽）', registrationsNoReact.length === 0, registrationsNoReact.length)

// ★ 这两条是"绝不许拖垮 dsh"的护栏：客户端插件抛错会让 DSH 启动/界面崩掉。
let slotThrew = false
// 这一步会**故意**触发插件的 warn，自测里静音，免得脏了 stderr（会让自动化误判失败）
const realConsoleWarn = console.warn
console.warn = () => {}
try {
  clientModule.apply({
    effect: (cb) => cb(),
    slots: { inject: () => { throw new Error('slot missing') }, register: () => {} },
  })
} catch (error) {
  slotThrew = true
} finally {
  console.warn = realConsoleWarn
}
check('槽注册抛错时不冒出去（否则会拖垮 dsh 启动）', slotThrew === false)

let renderThrew = false
let badVnode = null
try {
  badVnode = Card({ phase: 'result', get block() { throw new Error('boom') } })
} catch (error) {
  renderThrew = true
}
check('组件渲染抛错时不冒出去', renderThrew === false)
check('组件渲染抛错时给出可见提示', JSON.stringify(badVnode ?? {}).includes('渲染出错'), badVnode)

section('⑫ 包清单（DSH 重启后靠它加载客户端半边，字段写错就白重启）')
const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'))
check('package.json 是合法 JSON 且 name 正确', pkg.name === 'dsh-qwen-paint', pkg.name)
check('exports["."] → lib/index.js（host 半边）', pkg.exports?.['.']?.default === './lib/index.js', pkg.exports?.['.'])
check('exports["./client"] → lib/client.js（客户端半边）', pkg.exports?.['./client']?.default === './lib/client.js', pkg.exports?.['./client'])
check('exports["./client"] 指向的文件真的存在', await fsp.access(path.join(ROOT, 'lib', 'client.js')).then(() => true, () => false))
check('exports["./package.json"] 已导出（面板要读元数据）', pkg.exports?.['./package.json'] === './package.json')
check('dsh.bundle.patch → cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml', pkg.dsh?.bundle)
check('dsh.client.inject 含 slots', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('slots'), pkg.dsh?.client)
check('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
check('dsh.client.immediately = true', pkg.dsh?.client?.immediately === true)
check('files 含 lib 与 cordis.patch.yml', Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'), pkg.files)
check('meta.title 是给面板看的中文名', typeof pkg.meta?.title === 'string' && pkg.meta.title.length > 0, pkg.meta?.title)

section('⑬ 空闲自动关停（★ 只关"确认是 ComfyUI"的进程）')
const { makeComfyStatus, makeIdleShutdown, portOf, isLocalRequest } = mod.__internal
check('portOf 解析出端口', portOf('http://127.0.0.1:8188') === 8188, portOf('http://127.0.0.1:8188'))
check('portOf 对坏 URL 退回 8188', portOf('不是URL') === 8188)

const idleCfg = { ...DEFAULTS, comfyUrl: `http://127.0.0.1:${port}`, statusCacheMs: 0 }
const liveStatus = makeComfyStatus(idleCfg)
check('探活：假 ComfyUI 在线', (await liveStatus.probe(true)) === true)
check('队列为空 → 不忙', (await liveStatus.queueBusy()) === false)
queuePayload = { queue_running: [[0, 'x']], queue_pending: [] }
check('队列有任务 → 忙', (await liveStatus.queueBusy()) === true)
queuePayload = { queue_running: [], queue_pending: [] }

const quiet = () => {}
const idleFresh = makeIdleShutdown({ ...idleCfg, idleShutdownMs: 1000 }, quiet, liveStatus)
check(
  '★ 从没出过图 → 永远不关（保护主人自己开的 ComfyUI）',
  idleFresh.idleShutdownInMs() === 0 && (await idleFresh.tick()) === false,
)
idleFresh.touch()
check('出过图之后才开始计时', idleFresh.idleShutdownInMs() > 0, idleFresh.idleShutdownInMs())
check('刚出过图不会关', (await idleFresh.tick()) === false)

// 超时 + ComfyUI 已经不在 → 不关（顺手复位计时）
const offlineStatus = { probe: async () => false, queueBusy: async () => false, invalidate() {} }
const idleOffline = makeIdleShutdown({ ...idleCfg, idleShutdownMs: 1 }, quiet, offlineStatus)
idleOffline.touch()
await new Promise((resolve) => setTimeout(resolve, 5))
check('超时但 ComfyUI 已不在 → 不关', (await idleOffline.tick()) === false)

// ★ 超时 + 队列非空 → 续期，绝不打断别人的任务（因此也走不到杀进程那一步）
const busyStatus = { probe: async () => true, queueBusy: async () => true, invalidate() {} }
const idleBusy = makeIdleShutdown({ ...idleCfg, idleShutdownMs: 1 }, quiet, busyStatus)
idleBusy.touch()
await new Promise((resolve) => setTimeout(resolve, 5))
check('超时但队列非空 → 不关并续期', (await idleBusy.tick()) === false && idleBusy.idleShutdownInMs() > 0)
check('autoShutdown=false 时永不关', (() => {
  const off = makeIdleShutdown({ ...idleCfg, autoShutdown: false, idleShutdownMs: 1 }, quiet, busyStatus)
  off.touch()
  return off.idleShutdownInMs() === 0
})())

section('⑭ 只读状态端点（客户端状态指示器的数据源）')
check('本机 Host 放行', isLocalRequest({ headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' } }) === true)
check('localhost 放行', isLocalRequest({ headers: { host: 'localhost:3000' }, socket: { remoteAddress: '::1' } }) === true)
check('外网 Host 拒绝', isLocalRequest({ headers: { host: 'evil.example.com' }, socket: { remoteAddress: '127.0.0.1' } }) === false)
check('外网来源拒绝', isLocalRequest({ headers: { host: '127.0.0.1:1' }, socket: { remoteAddress: '10.0.0.5' } }) === false)

const statusRoutes = hostRoutes.filter((r) => r.path.includes('status.json'))
const assetRoutes = hostRoutes.filter((r) => r.path.includes('/qwen-paint/loading'))
check('注册了 2 条状态路由（/api/ 优先 + 根路径回退）', statusRoutes.length === 2, statusRoutes.map((r) => r.path))
// ★ 2026-10-08 新增：插件自己的动画图片路由。
//   内核的 /api/file 只肯服务"被登记过的文件"，动图没登记 → 一律「图片无法预览」
//   （GIF / WebP / 静态 PNG 三种都试过，与格式和文件名都无关）。所以由插件自己开路由吐字节。
check('注册了动画图片路由（webp 主用 + gif 回退）', assetRoutes.length === 2, assetRoutes.map((r) => r.path))
check('路由都是 exact 且带 handler', hostRoutes.every((r) => r.kind === 'exact' && typeof r.handler === 'function'))
check('注册了空闲关停的 effect', hostEffects.some((e) => e.label === 'qwen-paint:idle-shutdown'), hostEffects.map((e) => e.label))
check('局部 inject 等的是 webServer（名字拼错会永远等不到）', injectedExtra.some((s) => Array.isArray(s) && s.includes('webServer')), injectedExtra)

const callStatus = (headers, remoteAddress, url = '/') =>
  new Promise((resolve) => {
    const res = { writeHead() {}, end(text) { resolve(String(text)) } }
    hostRoutes[0].handler({ headers, socket: { remoteAddress }, url }, res)
  })

const statusText = await callStatus({ host: '127.0.0.1:1' }, '127.0.0.1')
const statusJson = JSON.parse(statusText)
check('状态体 ok=true', statusJson.ok === true, statusJson)
check('状态体 online=true（假 ComfyUI 在跑）', statusJson.online === true, statusJson.online)
check('状态体 busy=false（队列空）', statusJson.busy === false, statusJson.busy)
check('状态体带 idleShutdownInMs 字段', 'idleShutdownInMs' in statusJson, Object.keys(statusJson))
check(
  '★ 状态体不含任何本地路径 / 模型名（只暴露事实）',
  !/outputDir|comfyOutputDir|unet|safetensors|C:\\\\/iu.test(statusText),
  statusText.slice(0, 200),
)
const forbiddenText = await callStatus({ host: 'evil.example.com' }, '8.8.8.8')
check('外网请求拿到 ok=false（403 体）', JSON.parse(forbiddenText).ok === false, forbiddenText)

section('⑮ 状态点菜单：当前档位高亮 + 点空白处消失（主人 2026-10-08 新增）')

/* 这一节要**真的点一遍菜单**，所以给假 DOM 补上事件、属性读写和父子关系。
   ⚠ fakeDocument 是 client.js 闭包里持有的**同一个对象**，在这里改它就是改它看到的那份。
   只补菜单用到的那几个方法，别的一概不动。 */
function makeFakeEl(tag) {
  const el = {
    tag,
    className: '',
    textContent: '',
    attrs: {},
    kids: [],
    parent: null,
    handlers: {},
    setAttribute(name, value) { this.attrs[name] = String(value) },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null },
    removeAttribute(name) { delete this.attrs[name] },
    appendChild(child) { this.kids.push(child); child.parent = this; return child },
    remove() {
      const parent = this.parent
      if (parent !== null) {
        const i = parent.kids.indexOf(this)
        if (i >= 0) parent.kids.splice(i, 1)
      }
      this.parent = null
    },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] ?? []).push(fn) },
    removeEventListener(type, fn) {
      const list = this.handlers[type] ?? []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    contains(other) {
      if (other === this) return true
      return this.kids.some((kid) => typeof kid.contains === 'function' && kid.contains(other))
    },
    fire(type, event) { for (const fn of [...(this.handlers[type] ?? [])]) fn(event) },
    get children() { return this.kids },
    // 菜单"要不要翻到下面"的判断要用到这三样，自测里都得能喂：
    style: {},
    rect: { top: 0, bottom: 0, right: 0, width: 0, height: 0 },
    getBoundingClientRect() { return this.rect },
    // 内容总高：按"每条目约 34px"估算 —— 够用来验证方向与限高逻辑
    get scrollHeight() { return this.kids.length * 34 },
  }
  return el
}

const docListeners = []
const realCreateElement = fakeDocument.createElement
fakeDocument.createElement = (tag) => makeFakeEl(tag)
// ★ 菜单现在挂在 document.body 上（为了摆脱 composer 祖先的 overflow 裁剪），假 DOM 也得有个 body
const bodyEl = makeFakeEl('body')
fakeDocument.body = bodyEl
fakeDocument.addEventListener = (type, fn, capture) => { docListeners.push({ type, fn, capture }) }
fakeDocument.removeEventListener = (type, fn) => {
  const i = docListeners.findIndex((l) => l.type === type && l.fn === fn)
  if (i >= 0) docListeners.splice(i, 1)
}

// 假 host：带 idleMinutes=N / flowStyle=x 的请求会改掉"服务器上的值"，之后的查询就回这个 —— 与真实 host 一致
let serverIdleMinutes = 5
let serverFlowStyle = 'meteor'
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const text = String(url)
  const hit = /idleMinutes=(\d+)/.exec(text)
  if (hit !== null) serverIdleMinutes = Number(hit[1])
  const style = /flowStyle=([a-z]+)/.exec(text)
  if (style !== null) serverFlowStyle = style[1]
  return {
    ok: true,
    json: async () => ({
      online: true, busy: false,
      idleShutdownMs: serverIdleMinutes * 60000,
      flowStyle: serverFlowStyle,
    }),
  }
}

const menuSeat = makeFakeEl('span')
fakeReact.useRef = () => ({ current: menuSeat })
let menuCleanup = null
fakeReact.useEffect = (fn) => { menuCleanup = fn() }
dockOptions.component()
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
await settle()

const findMenu = () => bodyEl.kids.find((kid) => kid.className === 'dshqp-menu') ?? null
const seatClick = menuSeat.handlers.click?.[0]
check('状态点绑上了点击处理（能弹出菜单）', typeof seatClick === 'function')

seatClick({ target: menuSeat })
const menuNode = findMenu()
check('点一下弹出菜单', menuNode !== null)
const itemsOf = (kind) => menuNode.children.filter((it) => it.getAttribute('data-kind') === kind)
const itemOf = (kind, value) =>
  itemsOf(kind).find((it) => it.getAttribute('data-value') === String(value)) ?? null
const heads = menuNode.children.filter((it) => String(it.className).includes('dshqp-menu-head'))
check(
  '菜单分成三块标题（自动关闭 / 生图动画 / 流光）',
  heads.length === 3 && heads[2].textContent === '流光 · 抄自月匠',
  heads.map((h) => h.textContent),
)
check('自动关闭组 5 项', itemsOf('idle').length === 5, itemsOf('idle').length)
check('★ 生图动画组 16 项（流星 + 15 种流光）', itemsOf('flow').length === 16, itemsOf('flow').length)
check(
  '★ 15 个流光项都带预览小色块（不用生图就能看出选的是什么颜色）',
  itemsOf('flow').filter((it) => it.kids.some((k) => String(k.className).startsWith('dshqp-menu-swatch'))).length === 15,
)
// ★ 文案按主人 2026-10-08 的要求改过：
//   「把现在的三个字去掉，在流星前加个点，后面写上自制，下面的流光统一做一个大标题，标注抄自月匠」
const meteorItem = itemOf('flow', 'meteor')
check(
  '★「流星」去掉了"（现在的）"，改成：前面一个点 + 后面「自制」标签',
  meteorItem !== null &&
    meteorItem.kids.some((k) => String(k.className).includes('dshqp-menu-bullet')) &&
    meteorItem.kids.some((k) => String(k.className).includes('dshqp-menu-tag') && k.textContent === '自制'),
  meteorItem?.kids.map((k) => [k.className, k.textContent]),
)
check(
  '★ 流星那一项的文字就是「流星」两个字（多余的字一个不留）',
  meteorItem !== null && meteorItem.kids.some((k) => k.textContent === '流星'),
  meteorItem?.kids.map((k) => k.textContent),
)
check(
  '★ 大标题注明出处「抄自月匠」，且是子标题样式（不带分隔线）',
  heads.some((h) => h.textContent.includes('抄自月匠') && String(h.className).includes('dshqp-menu-sub')),
  heads.map((h) => [h.textContent, h.className]),
)
check(
  '★ 流光条目名不再重复带「流光·」前缀（前缀已经收进大标题了）',
  itemsOf('flow').every((it) => !it.kids.some((k) => String(k.textContent).startsWith('流光·'))),
  itemsOf('flow').slice(0, 3).map((it) => it.kids.map((k) => k.textContent)),
)
// ★ 两边 id 必须对齐：host 白名单（决定"能不能选中"）vs 客户端渲染表（决定"画出什么"）。
//   改动画时最容易只改一边 —— 只改 host 是"选了没用"，只改 client 是"根本选不中"。
const hostStyles = mod.__internal.FLOW_STYLES ?? []
check(
  '★ 客户端菜单的动画项与 host 白名单完全一致',
  itemsOf('flow').length === hostStyles.length &&
    itemsOf('flow').every((it) => hostStyles.includes(it.getAttribute('data-value'))),
  { menu: itemsOf('flow').map((it) => it.getAttribute('data-value')), host: hostStyles },
)
check('★ 当前档位（5 分钟＝默认）被高亮', itemOf('idle', 5)?.getAttribute('data-current') === '1', itemOf('idle', 5)?.attrs)
check('★ 非当前档位没有高亮', itemOf('idle', 10)?.getAttribute('data-current') === null, itemOf('idle', 10)?.attrs)
check('★ 默认动画「流星」被高亮', itemOf('flow', 'meteor')?.getAttribute('data-current') === '1', itemOf('flow', 'meteor')?.attrs)
check('★ 没选中的流光不高亮', itemOf('flow', 'aurora')?.getAttribute('data-current') === null, itemOf('flow', 'aurora')?.attrs)
check(
  '★ 两组各自只有一个高亮（不会串组、也不会两个都亮）',
  itemsOf('idle').filter((it) => it.getAttribute('data-current') !== null).length === 1 &&
    itemsOf('flow').filter((it) => it.getAttribute('data-current') !== null).length === 1,
)
check(
  '菜单打开时挂上 document 监听，且必须是捕获阶段',
  docListeners.length === 1 && docListeners[0].capture === true,
  docListeners.map((l) => [l.type, l.capture]),
)

// 点状态点自己不能被"点外面"这条规则误关 —— 否则会关了又立刻打开
docListeners[0].fn({ target: menuSeat })
check('点状态点自己不触发「点外面关闭」', bodyEl.kids.includes(menuNode))
// ★ 菜单挂到 body 之后，点**菜单内部**也不能被判成"点外面"
//   （否则捕获阶段先把菜单关掉，手感就是"点一下没反应"）
docListeners[0].fn({ target: menuNode })
check('★ 点菜单内部不触发「点外面关闭」（挂 body 之后的新要求）', bodyEl.kids.includes(menuNode))
// 点界面任意空白处 → 消失
docListeners[0].fn({ target: makeFakeEl('div') })
check('★ 点任意空白处菜单消失', !bodyEl.kids.includes(menuNode))
check('★ 菜单关掉后 document 监听也摘掉了', docListeners.length === 0, docListeners.length)

// 改选 10 分钟 → 服务器档位变了 → 下次打开菜单的高亮要跟着走
seatClick({ target: menuSeat })
const menu2 = findMenu()
const item10 = menu2.children.find(
  (it) => it.getAttribute('data-kind') === 'idle' && it.getAttribute('data-value') === '10',
)
item10.fire('click', { stopPropagation() {}, target: item10 })
check('选中后菜单立刻收起', !bodyEl.kids.includes(menu2))
await settle()
seatClick({ target: menuSeat })
const pick = (kind, value) =>
  findMenu()?.children.find(
    (it) => it.getAttribute('data-kind') === kind && it.getAttribute('data-value') === String(value),
  ) ?? null
check(
  '★ 选过 10 分钟后高亮跟着走到 10（5 不再亮）',
  pick('idle', 10)?.getAttribute('data-current') === '1' && pick('idle', 5)?.getAttribute('data-current') === null,
  pick('idle', 5)?.attrs,
)

// ★ 再挑一种流光：高亮要走到它身上，且**不能串到自动关闭那一组**
const aurora = findMenu().children.find((it) => it.getAttribute('data-value') === 'aurora')
aurora.fire('click', { stopPropagation() {}, target: aurora })
await settle()
seatClick({ target: menuSeat })
const menu4 = findMenu()
const currentOf = (kind) =>
  menu4.children.filter(
    (it) => it.getAttribute('data-kind') === kind && it.getAttribute('data-current') !== null,
  )
check(
  '★ 选过流光后高亮走到「极光幻彩」，流星不再亮',
  currentOf('flow').length === 1 && currentOf('flow')[0].getAttribute('data-value') === 'aurora',
  currentOf('flow').map((it) => it.getAttribute('data-value')),
)
check(
  '★ 生图动画的选择没有串到自动关闭那一组（仍停在 10 分钟）',
  currentOf('idle').length === 1 && currentOf('idle')[0].getAttribute('data-value') === '10',
  currentOf('idle').map((it) => it.getAttribute('data-value')),
)

// ★★ 菜单位置（主人 2026-10-08：「新会话里这个界面会被上面的 UI 挡住」→「还是一样」）
//   真根因是**被祖先裁掉**（菜单原来是座位的子元素 + absolute），所以定案是挂到 body + fixed。
//   场景 A：新会话（composer 在屏幕上方）→ 上面塞不下 → 往下弹，并按下方空间限高
seatClick({ target: menuSeat }) // 先收起
menuSeat.rect = { top: 200, bottom: 230, right: 340, width: 0, height: 0 }
fakeWindow.innerHeight = 500
fakeWindow.innerWidth = 800
seatClick({ target: menuSeat }) // 再打开
const menuDown = findMenu()
check(
  '★ 菜单挂在 body 上、不在座位里（这才是被祖先裁掉的根因）',
  bodyEl.kids.includes(menuDown) && !menuSeat.kids.includes(menuDown),
)
check(
  '★ 新会话里往下弹（top 落在座位下方，不再顶到屏幕顶上被切）',
  Number.parseFloat(menuDown?.style?.top ?? '-1') >= 230,
  [menuDown?.style?.top, menuDown?.style?.maxHeight],
)
check(
  '★ 并按下方实际空间限高（500 − 230 − 8 = 262）',
  menuDown?.style?.maxHeight === '262px',
  menuDown?.style?.maxHeight,
)

//   场景 B：老会话（composer 在屏幕底部）→ 往上弹，高度回到上限
seatClick({ target: menuSeat })
menuSeat.rect = { top: 700, bottom: 730, right: 340, width: 0, height: 0 }
fakeWindow.innerHeight = 800
seatClick({ target: menuSeat })
const menuUp = findMenu()
check(
  '★ 老会话里仍然往上弹（不改原来手感）',
  Number.parseFloat(menuUp?.style?.top ?? '9999') < 700,
  [menuUp?.style?.top, menuUp?.style?.maxHeight],
)
check(
  '★ 两种情况都给了水平定位（右对齐座位，且不出界）',
  typeof menuUp?.style?.left === 'string' && menuUp.style.left.endsWith('px'),
  menuUp?.style?.left,
)

if (typeof menuCleanup === 'function') menuCleanup()
check('★ 卸载时把 document 监听一并带走（不留悬挂监听）', docListeners.length === 0, docListeners.length)

globalThis.fetch = realFetch
fakeDocument.createElement = realCreateElement

section('⑯ 自动关闭的计时起点（主人 2026-10-08 报「自动关闭失效」的回归测试）')

/* 背景：`tick()` 的第一道判断是「起点是 null 就直接返回」，
   而起点原本**只在出图成功时**才被设置 —— 于是"重启 DSH 之后一次图都没画"
   就永远不会关，主人在菜单里选「1 分钟后关闭」也没用（状态点显示"在线"而非"空闲 N 分"）。
   修法两条：① 预热确认后端在线 → 起点定在此刻；② 在菜单里改了档位 → 起点定在此刻。
   这一节盯住这两条，**故意不等到超时**（只验证"起点开了"）。 */
await new Promise((resolve) => setTimeout(resolve, 120))
const idleStart = JSON.parse(await callStatus({ host: '127.0.0.1:1' }, '127.0.0.1')).lastActivityAt
check('★ 预热确认在线后就开启计时（起点不再是 null）', typeof idleStart === 'number' && idleStart > 0, idleStart)

await new Promise((resolve) => setTimeout(resolve, 40))
// ⚠ 档位用 1440 分钟（24 小时）**而不是 1 分钟**：这条检查不能把自测挂在这儿等超时，
//   更不能让 tick 在假 ComfyUI 关掉之后跑去杀主机上真的 ComfyUI。最后再设回 0（不自动关闭）。
const picked = JSON.parse(
  await callStatus({ host: '127.0.0.1:1' }, '127.0.0.1', '/api/qwen-paint/status.json?idleMinutes=1440'),
)
check('改档位生效（1440 分钟）', picked.idleShutdownMs === 1440 * 60000, picked.idleShutdownMs)
check('★ 改档位会把计时起点推到此刻', picked.lastActivityAt >= idleStart + 30, [idleStart, picked.lastActivityAt])
check('★ 计时确实在走（idleShutdownInMs > 0）', picked.idleShutdownInMs > 0, picked.idleShutdownInMs)

// 越界值必须被忽略（不能把档位搞成负数或 NaN）
const bogus = JSON.parse(
  await callStatus({ host: '127.0.0.1:1' }, '127.0.0.1', '/api/qwen-paint/status.json?idleMinutes=abc'),
)
check('非法档位被忽略（仍是 1440 分钟）', bogus.idleShutdownMs === 1440 * 60000, bogus.idleShutdownMs)

const idleOff = JSON.parse(
  await callStatus({ host: '127.0.0.1:1' }, '127.0.0.1', '/api/qwen-paint/status.json?idleMinutes=0'),
)
check('选「不自动关闭」时档位为 0', idleOff.idleShutdownMs === 0, idleOff.idleShutdownMs)
check('选「不自动关闭」时剩余时间恒为 0（永不关）', idleOff.idleShutdownInMs === 0, idleOff.idleShutdownInMs)

section('⑰ 生图动画：落盘与白名单（host 半边）')

const uiFile = path.join(tmp, 'qwen-paint-ui.json')
const readUi = () => {
  try { return JSON.parse(readFileSync(uiFile, 'utf8')) } catch (error) { return null }
}

check('状态体带 flowStyle 字段', typeof statusJson.flowStyle === 'string', statusJson.flowStyle)
check('默认动画是流星（不动原来的观感）', statusJson.flowStyle === 'meteor', statusJson.flowStyle)
check('默认值不写盘（文件还不存在）', readUi() === null, readUi())

const setAurora = JSON.parse(
  await callStatus({ host: '127.0.0.1:1' }, '127.0.0.1', '/api/qwen-paint/status.json?flowStyle=aurora'),
)
check('★ 选了「极光幻彩」后状态体立刻回它', setAurora.flowStyle === 'aurora', setAurora.flowStyle)
check('★ 选择已落盘（重启 DSH 之后还记得住）', readUi()?.flowStyle === 'aurora', readUi())

// ⚠ 这是外部输入，而且会被拼进 class 名 —— 必须挡住
const bogusStyle = JSON.parse(
  await callStatus({ host: '127.0.0.1:1' }, '127.0.0.1', '/api/qwen-paint/status.json?flowStyle=%3Cimg%20src%3Dx%3E'),
)
check('★ 非法动画 id 被忽略（仍是 aurora）', bogusStyle.flowStyle === 'aurora', bogusStyle.flowStyle)
check('★ 非法值也不会被写进文件', readUi()?.flowStyle === 'aurora', readUi())

const setMeteor = JSON.parse(
  await callStatus({ host: '127.0.0.1:1' }, '127.0.0.1', '/api/qwen-paint/status.json?flowStyle=meteor'),
)
check('能切回流星', setMeteor.flowStyle === 'meteor', setMeteor.flowStyle)
check('切回流星同样落盘', readUi()?.flowStyle === 'meteor', readUi())

check(
  '★ 新增字段没破坏"状态体不含本地路径"这条底线',
  !/outputDir|safetensors|C:\\\\/iu.test(JSON.stringify(setAurora)),
  JSON.stringify(setAurora).slice(0, 200),
)

section('⑱ A 卡（AMD）支持 —— 0.1.1 新增，本机是 N 卡无法实测，用源码特征钉住关键点')

const setupCode = await fsp.readFile(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8')
check('setup.mjs 里有显卡检测', setupCode.includes('function detectGpu()'))
check(
  '★ 判定顺序是「有 N 卡就走 N 卡」（多显卡机器上别被 AMD 核显带偏 —— 本机实测就报了三张卡）',
  setupCode.indexOf("vendor = 'nvidia'") < setupCode.indexOf("vendor = 'amd'"),
)
check('有 gfx 型号映射表', setupCode.includes('GFX_TABLE') && setupCode.includes('function gfxOf'))
check(
  '★ gfx 表带"官方支持与否"这一列（照 AMD 官方 Windows 列表核过，不是照网友项目抄的）',
  setupCode.includes("'gfx1201', 'ok'") && setupCode.includes("'gfx1030', 'no'"),
)
check(
  '★ 官方不支持的老卡会被当场拦住（别让用户白下 3 GB 再发现跑不起来）',
  /support === 'no'[\s\S]{0,500}?return null/u.test(setupCode),
)
check(
  '★ 补上了官方支持、但之前从二手来源抄漏的 gfx1151（Ryzen AI Max 系列）',
  setupCode.includes("'gfx1151'"),
)
check(
  '★ 表里不再有官方 Windows 列表里根本没有的 gfx1010 / gfx1103',
  !setupCode.includes("'gfx1010'") && !setupCode.includes("'gfx1103'"),
)
check(
  '★ 核对链接指向 AMD 官方 **Windows** 文档（不是 Linux 那份）',
  setupCode.includes('install-on-windows'),
)
check('★ A 卡的下载源只有 AMD 官方仓库', setupCode.includes('repo.radeon.com/rocm/windows'))
check(
  '★ 没有引入任何被拉黑的第三方加速站',
  !/gh-proxy|ghfast|ghproxy|hf-mirror/iu.test(setupCode),
)
check(
  '★ 锁死在 ROCm 7.2.1（ROCm 10.0 报 HIP 7.15，实测会破坏权重）',
  setupCode.includes('rocm-rel-7.2.1') && !setupCode.includes('rocm-rel-10'),
)
check('★ 有"A 卡可能静默出错"的提示', setupCode.includes('静默出错'))
check('★ 有"禁止商用"的许可证提示', setupCode.includes('禁止商用'))
check(
  '★ 用 constraints 锁住 torch（否则 ComfyUI 的 requirements 会把它换成 CUDA 版）',
  setupCode.includes('torch-pin.txt') && setupCode.includes('requirements-no-torch.txt'),
)
check(
  '★ --check 时必须走"只打印"的分支、不执行安装',
  /if \(checkOnly\) \{[\s\S]{0,200}?return null/u.test(setupCode),
)
check('有 --force-amd（在 N 卡机器上验证 A 卡分支用）', setupCode.includes('--force-amd'))
check('有 --yes（无人值守的一键安装用）', setupCode.includes('--yes'))
check('启动参数提醒里有 --disable-dynamic-vram（A 卡上必须）', setupCode.includes('--disable-dynamic-vram'))

/* ------------------------------------------------------------------ 收尾 ---- */

server.close()
await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})

console.log(`\n${failures === 0 ? '全部通过 ✓' : `有 ${failures} 项失败 ✗`}`)
process.exit(failures === 0 ? 0 : 1)
