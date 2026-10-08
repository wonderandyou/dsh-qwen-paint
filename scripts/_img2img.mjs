/**
 * 用参考图出「不同姿势、同一画风」—— Qwen-Image 2.1 的**参考图模式**。
 * ============================================================================
 * 连线照抄两份**已经验证过**的实现（本机 ComfyUI 生图界面的 app.py、
 * 以及本地 AI 脚本），四个要点一个都不能少：
 *   ① 加一个 LoadImage 节点读参考图（图片要先放进 ComfyUI 的 input 目录）
 *   ② TextEncodeQwenImage21 必须拿到 vae（不给 vae 就不会编码参考图）
 *   ③ 参考图走 images.image_1（源码支持到 image_16）
 *   ④ KSampler 的 latent 取自该节点的第 2 号输出（positive=0 / negative=1 / latent=2），
 *      并且**删掉 EmptyLatentImage**（不再需要空 latent）
 * resolution 用 local_ai.py 的算法（sqrt(W*H)）—— 让输出尺寸≈所选尺寸。
 * denoise 保持 1.0（该节点的设计如此，不是越低越像）。
 *
 * 用法：node scripts/_img2img.mjs "<参考图文件名>" "<姿势提示词>" [宽] [高] [seed]
 * ============================================================================
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const mod = await import(pathToFileURL(PLUGIN).href)
const { DEFAULTS } = mod.__internal

const cfg = { ...DEFAULTS, pollIntervalMs: 1500 }

const refName = process.argv[2] ?? 'ref_pink.png'
const prompt = process.argv[3] ?? ''
const width = Number(process.argv[4] ?? 864)
const height = Number(process.argv[5] ?? 1152)
const seed = Number(process.argv[6] ?? Math.floor(Math.random() * 2 ** 31))

if (prompt === '') {
  console.error('缺少提示词')
  process.exit(2)
}

/** 带超时的 fetch。 */
async function fetchWithTimeout(url, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    return await fetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    })
  } finally {
    clearTimeout(timer)
  }
}

function buildWorkflow() {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: cfg.unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: cfg.clip, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: cfg.vae } },
    4: { class_type: 'LoadImage', inputs: { image: refName } },
    5: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0],
        prompt,
        negative_prompt: '',
        resolution: Math.round(Math.sqrt(width * height)),
        vae: ['3', 0],                 // ★ 不给 vae 就不会编码参考图
        'images.image_1': ['4', 0],    // ★ 参考图进视觉塔
      },
    },
    7: { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
    8: {
      class_type: 'KSampler',
      inputs: {
        model: ['7', 0],
        seed,
        steps: 25,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['5', 0],
        negative: ['5', 1],
        latent_image: ['5', 2],        // ★ latent 取自编码节点；因此**没有** EmptyLatentImage
        denoise: 1.0,
      },
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'dsh-qwen-pose' } },
  }
}

console.log(`参考图: ${refName}   ${width}x${height}   seed=${seed}`)
console.log(`提示词: ${prompt.slice(0, 90)}${prompt.length > 90 ? '…' : ''}`)

const stamp = Date.now()
const submit = await fetchWithTimeout(`${cfg.comfyUrl}/prompt`, {
  method: 'POST',
  body: JSON.stringify({ prompt: buildWorkflow(), client_id: `dsh-pose-${stamp}` }),
  timeoutMs: 60000,
})
const submitted = await submit.json()
if (submitted.prompt_id === undefined) {
  console.error('ComfyUI 拒绝了这个工作流：', JSON.stringify(submitted).slice(0, 700))
  process.exit(3)
}
const promptId = submitted.prompt_id
console.log(`已提交 prompt_id=${promptId}，等待出图…`)

const started = Date.now()
let images = null
for (;;) {
  if (Date.now() - started > 900000) { console.error('超时'); process.exit(4) }
  await new Promise((resolve) => setTimeout(resolve, 2000))
  let history
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/history/${promptId}`, { timeoutMs: 20000 })
    history = await res.json()
  } catch { continue }
  const entry = history?.[promptId]
  if (entry === undefined) continue
  const status = entry.status ?? {}
  if (status.status_str === 'error') {
    const err = (status.messages ?? []).find((m) => Array.isArray(m) && m[0] === 'execution_error')
    console.error('ComfyUI 执行失败：', JSON.stringify(err?.[1] ?? status).slice(0, 700))
    process.exit(5)
  }
  const found = []
  for (const out of Object.values(entry.outputs ?? {})) {
    for (const img of out?.images ?? []) if (img?.filename) found.push(img)
  }
  if (found.length > 0) { images = found; break }
  if (Date.now() - started > 12000 && (Date.now() - started) % 20000 < 2200) {
    console.log(`  …已等 ${Math.round((Date.now() - started) / 1000)}s`)
  }
}

await fsp.mkdir(cfg.outputDir, { recursive: true })
const saved = []
for (const [index, image] of images.entries()) {
  const local = path.join(cfg.comfyOutputDir, image.subfolder ?? '', image.filename)
  let bytes
  try {
    bytes = await fsp.readFile(local)
  } catch {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/view?${query}`, { timeoutMs: 120000 })
    bytes = Buffer.from(await res.arrayBuffer())
  }
  const stem = prompt.replace(/[\\/:*?"<>|\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 30)
  // ★ 文件名必须带上 seed：三张姿势的提示词前缀相同，只用 stem 会互相覆盖（2026-10-07 踩过，
  //   三张只剩最后一张）。
  const target = path.join(cfg.outputDir, `${stem}_ref-${seed}_${width}x${height}_${String(index + 1).padStart(2, '0')}.png`)
  await fsp.writeFile(target, bytes)
  saved.push(target)
}

console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
for (const file of saved) console.log(`已出图：${file}`)
