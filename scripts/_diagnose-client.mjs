/**
 * 诊断：客户端半边到底加载到哪一步了。
 * ============================================================================
 * 背景：`lib/client.js` 的 `apply` 里有几处**安静 return**（拿不到 React / 拿不到 slots），
 * 从外面看和"客户端代码根本没加载"**一模一样**——这正是 ⑦（composer 下方状态点）
 * 一直定位不下来的原因。
 *
 * 对策：客户端现在会在 `apply` 的**每个分支**往 host 的状态端点打一发带理由的自报
 * （`?ping=apply` / `no-react` / `no-slots` / `registered`），host 端去重记在
 * `visits.pings` 里；另外 `visits.api` 会累计"带 /api/ 前缀的请求数"，用来判断
 * 状态指示器有没有在**周期轮询**。
 *
 * ⚠ 自报机制要**重启 DSH** 才生效（已实测：改已有插件的 `lib/*.js` 不会热加载）。
 *
 * 用法（在插件目录下）：
 *   node scripts/_diagnose-client.mjs
 * ============================================================================
 */

const ENDPOINT = 'http://127.0.0.1:19387/qwen-paint/status.json'

async function read() {
  const response = await fetch(`${ENDPOINT}?probe=${Date.now()}`, { cache: 'no-store' })
  return response.json()
}

console.log(`探测 ${ENDPOINT}`)

let first
try {
  first = await read()
} catch (error) {
  console.log(`✗ 端点请求失败：${error?.message ?? error}`)
  console.log('  → 连 host 半边都没通。先确认 DSH 在跑、且 /qwen-paint/status.json 可访问。')
  process.exit(2)
}

if (first.visits === undefined) {
  console.log('✗ 响应里没有 visits 字段')
  console.log('  → **自报机制还没生效**：改完代码后没有重启过 DSH。')
  console.log(`  当前响应：${JSON.stringify(first)}`)
  process.exit(3)
}

const show = (label, snapshot) =>
  console.log(`${label}：api=${snapshot.visits.api} plain=${snapshot.visits.plain} pings=[${snapshot.visits.pings.join(', ')}]`)

show('第 1 次', first)
console.log('等 12 秒（客户端 5 秒一轮，足够两轮）…')
await new Promise((resolve) => setTimeout(resolve, 12000))
const second = await read()
show('第 2 次', second)

const pings = second.visits.pings
const polled = second.visits.api > first.visits.api

console.log('\n=== 判定 ===')
if (pings.length === 0) {
  console.log('客户端**从未**发过自报')
  console.log('→ lib/client.js 根本没被执行：问题出在"DSH 有没有发现并加载这个客户端 bundle"这一环。')
  console.log('  下一步查：dsh.client 声明 / exports["./client"] / DSH 启动时的 client-modules 诊断日志。')
} else if (pings.includes('registered')) {
  if (polled) {
    console.log('客户端加载**完全正常**：两个槽都注册了，而且状态指示器在周期轮询。')
    console.log('→ 那 ⑦ 纯粹是"显示位置 / 样式 / 槽容器"的问题：换槽位或改样式即可。')
  } else {
    console.log('注册成功了，但**没有周期轮询**')
    console.log('→ 组件没被渲染：槽容器把它吞了，或者 dock 槽在没有自带条目时不展开。')
  }
} else if (pings.includes('no-slots')) {
  console.log('客户端加载了，但 apply 时 ctx.slots 还没就绪 → 提前 return')
  console.log('→ 改成局部 ctx.inject(["slots"], …) 等 service 就绪再注册。')
} else if (pings.includes('no-react')) {
  console.log('客户端加载了，但拿不到 React 种子 → 提前 return')
  console.log('→ 查 require("react") 在这个部署里给的是什么（可能是裁剪过的种子）。')
} else {
  console.log(`客户端加载了，走到了这些分支：${pings.join(', ')}`)
}
