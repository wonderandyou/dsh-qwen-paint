/**
 * dsh-qwen-paint — 客户端半边
 * ============================================================================
 * 做两件事：
 *   ① 给 `draw_image` 这个工具调用注册一张**自己的卡片**，在聊天框里直接
 *      `<img>` 显示刚生成的图。运行中显示「正在画图…」，失败显示错误原文。
 *   ② 在 **composer 下方的环境条目槽**（`conversation.composer.dock`）放一个
 *      ComfyUI 后端状态指示器：绿点=在线、黄点=出图中、灰点=未启动，
 *      并提示「空闲 N 分后自动关闭」。每 5 秒问一次 host 的只读状态端点。
 *
 * ★ 为什么图非要走自定义 toolview（2026-10-07 查内核源码定案）：
 *   · 非 `read_image` 的工具往结果里返回 image block —— **没用**。客户端
 *     `imageCardModel()` 开头就是 `if (call?.name !== "read_image") return null`，
 *     然后 generic 卡片把 image block 用 `JSON.stringify` 打成文本。
 *   · `presentCall` / `presentResult` —— 客户端**完全不消费**。
 *   · `presentationMeta` —— 只有 `read_image` 那张卡片会读 `meta.path` 当标签。
 *   · `present` 的交付卡片 —— 里面**根本没有 `<img>`**。
 *   所以确定能让图显示在聊天框里的只有两条：**正文 Markdown 图片**（host 侧
 *   已用 systemPrompt 段落保证）和**这条自定义 toolview**。两条都做，互不依赖。
 *
 * ★ 契约（都是 asar 内 dsh-cordis-client-runner/lib/client.js 里查到的）：
 *   · `tool.call.toolview`（:5967）keyed/scope=session，`key` 由工具名派发，
 *     文档原文 "Any name is allowed, including tools registered by your package."
 *     本 key 未占用 → 不遮蔽任何自带 UI。owner props 带 `{phase, block, toolName, ...}`。
 *   · `conversation.composer.dock`（:2704）**list** 槽、scope=session，summary 原文
 *     "Ambient entries below the composer card."，replaceRisk: none；
 *     注册要 `id`（自定义 id 与自带 `stats` pill 并存，不替换它）。
 *
 * ★ 状态端点走**相对路径**（`api/qwen-paint/status.json`，回退 `qwen-paint/status.json`），
 *   由浏览器相对 `document.baseURI` 解析 —— 与图片用的 `api/file?...` 同一套路。
 *
 * ★ React 用法照抄 dsh-reasoning-glow：**React 只渲染"座位"，内容与轮询全在纯 DOM 里**
 *   挂（useRef + useEffect），并且注册前检查 hooks 是否存在；拿不到就安静跳过。
 *
 * 本文件是**非 ESM** 的浏览器脚本（走 window.__ModuleLoader__），与 lib/index.js 相反。
 * ============================================================================
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-qwen-paint',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      /* React 从平台模块表拿；拿不到就**不注册**（注册了组件一渲染就 TypeError，
         会污染 dsh 自己的渲染树）。见 MEMO：宁可安静降级。 */
      let React = null
      try {
        const seed = require('react')
        React = seed && seed.default ? seed.default : seed
      } catch (err) {
        React = null
      }

      const PLUGIN_ID = 'dsh-qwen-paint'
      const SLOT_KEY = 'tool.call.toolview'
      const TOOL_KEY = 'draw_image'
      const STYLE_ID = 'dsh-qwen-paint-style'
      /**
       * ★ 状态点的落点：composer **工具行右侧**（内核原文 "Compact controls before the
       * composer submit action" —— 即发送按钮前面）。list 槽、replaceRisk: none。
       *
       * 为什么不用另外两个（全是实测结论，别再改回去）：
       *  · `conversation.composer.dock`（卡片下方）—— 注册成功但界面上**看不见**：
       *    那个槽平时是空的（内核唯一住户是"文件改动统计"，多数时候不渲染），容器零高度。
       *  · `conversation.input.left`（工具行左侧）—— 能看见，但它和右侧自带图标之间
       *    隔着一大片空白（主人反馈"两物隔太远"）。右侧这个槽紧挨发送按钮，正合适。
       */
      const STATUS_SLOT = 'conversation.input.right'
      const STATUS_ID = 'qwen-paint-status'
      /**
       * 状态端点。先试 `/api/` 下的（与内核 `/api/file` 同族，桌面端的 IPC 桥接最可能
       * 覆盖它），不通再回退到根路径。第一次成功后会记住用哪条，不再每条都试。
       */
      const STATUS_PATHS = ['api/qwen-paint/status.json', 'qwen-paint/status.json']
      const POLL_MS = 5000

      /* ══════════ 出图期间的「聊天流呼吸灯」+ 隐藏思考块（DOM 手术）══════════
       * ★ 主人 2026-10-07 的需求原文：「那个生图时的彩色 RGB 呼吸灯流光是放在
       *   你的输出里的，一个 16:9 的手机壁纸大小，就像你发图片出来一样，
       *   图片一开始生成就把这个放在你输出的地方，生成完毕就立马平滑替换这个动画」。
       * 底线（照 MEMO 的教训）：① 只往聊天容器里 **insertBefore 自己的节点**，
       *   绝不删改内核节点；② 全部包 try/catch；③ 找不到容器就安静跳过。
       */
      const FLOW_ID = 'dshqp-flow'
      const DRAWING_ATTR = 'data-dshqp-drawing'
      const REASONING_ATTR = 'data-dshqp-reasoning'
      const GRAD_STYLE_ID = 'dshqp-flowgrad-css'
      let flowHideTimer = null

      /* ══════════ 生图动画方案（主人 2026-10-08：界面里可自选）══════════
       * 主人原话：「这几种流光文字的流光 css 直接填充成 9:16 手机壁纸（和之前的动画
       *   大小一样）不添加文字，只做流光，使用户生图时可以自选动画」。
       *
       * · 色值**原样照搬**主人「小肥鱼挂件」里那套跑马灯流光
       *   （whale-widget.js 的 FISH_GRAD_LIB），一个色标都没改。
       * · 每条渐变**首尾色标相同**（墨韵/靛蓝是镜像对称），所以背景位置从 0% 跑到
       *   200% 回头时**接缝无跳变** —— 这是原版就有的设计，别当冗余"优化"掉。
       * · 流光方案**只铺渐变、不加任何文字**；"感知世界中"只留在流星方案里。
       * · 这里只存 id / 名字 / 渐变串，**样式表由 flowGradCss() 生成**（单一数据源），
       *   不手写第二份 CSS —— 也就不会再踩 CARD_CSS 的反引号 / 转义那些坑。
       * ⚠ ids 必须和 host 端 lib/index.js 的 FLOW_STYLES 完全一致（自测里有一条比对）。 */
      const FLOW_GRADS = [
        { id: 'macaron', name: '马卡龙', css: 'linear-gradient(135deg,rgb(255,180,200),rgb(255,205,170),rgb(255,225,165),rgb(245,240,180),rgb(190,240,210),rgb(180,230,245),rgb(190,215,250),rgb(220,200,245),rgb(240,200,230),rgb(255,180,200))' },
        { id: 'candy', name: '糖果', css: 'linear-gradient(135deg,rgb(255,145,170),rgb(255,170,130),rgb(255,195,110),rgb(240,220,115),rgb(140,220,175),rgb(115,210,205),rgb(130,195,240),rgb(160,170,235),rgb(210,155,230),rgb(235,135,190),rgb(255,145,170))' },
        { id: 'rouge', name: '酒红', css: 'linear-gradient(135deg,rgb(140,25,45),rgb(175,35,60),rgb(120,20,55),rgb(160,40,75),rgb(190,55,80),rgb(130,30,65),rgb(140,25,45))' },
        { id: 'bamboo', name: '翠青', css: 'linear-gradient(135deg,rgb(70,180,85),rgb(95,200,105),rgb(55,165,70),rgb(110,215,120),rgb(80,190,95),rgb(60,172,78),rgb(70,180,85))' },
        { id: 'aurora', name: '极光幻彩', css: 'linear-gradient(135deg,rgb(70,240,200),rgb(90,200,255),rgb(120,140,255),rgb(180,120,255),rgb(240,140,255),rgb(70,240,200))' },
        { id: 'deepsea', name: '深海蓝调', css: 'linear-gradient(135deg,rgb(20,90,180),rgb(30,140,210),rgb(40,180,220),rgb(20,120,190),rgb(50,160,230),rgb(25,100,200),rgb(20,90,180))' },
        { id: 'sunset', name: '落日熔金', css: 'linear-gradient(135deg,rgb(255,180,80),rgb(255,130,90),rgb(255,90,110),rgb(220,90,150),rgb(160,90,190),rgb(255,180,80))' },
        { id: 'forest', name: '森林秘语', css: 'linear-gradient(135deg,rgb(30,100,60),rgb(60,140,80),rgb(90,180,90),rgb(140,200,80),rgb(180,210,90),rgb(30,100,60))' },
        { id: 'champagne', name: '香槟鎏金', css: 'linear-gradient(135deg,rgb(220,180,100),rgb(240,205,130),rgb(255,225,160),rgb(230,190,110),rgb(245,210,140),rgb(220,180,100))' },
        { id: 'lavender', name: '薰衣草梦境', css: 'linear-gradient(135deg,rgb(180,150,255),rgb(200,170,255),rgb(230,180,240),rgb(255,190,220),rgb(240,160,200),rgb(180,150,255))' },
        { id: 'mint', name: '薄荷汽水', css: 'linear-gradient(135deg,rgb(120,230,180),rgb(150,240,200),rgb(170,240,230),rgb(140,220,240),rgb(120,200,220),rgb(120,230,180))' },
        { id: 'lava', name: '岩浆熔岩', css: 'linear-gradient(135deg,rgb(255,60,40),rgb(255,110,30),rgb(255,170,40),rgb(255,210,70),rgb(255,140,50),rgb(255,60,40))' },
        { id: 'galaxy', name: '银河星紫', css: 'linear-gradient(135deg,rgb(40,30,90),rgb(70,50,130),rgb(110,70,170),rgb(160,90,190),rgb(220,120,180),rgb(40,30,90))' },
        { id: 'ink', name: '墨韵黑白', css: 'linear-gradient(135deg,rgb(20,20,20),rgb(80,80,80),rgb(140,140,140),rgb(200,200,200),rgb(250,250,250),rgb(250,250,250),rgb(200,200,200),rgb(140,140,140),rgb(80,80,80),rgb(20,20,20))' },
        { id: 'indigo', name: '靛蓝夜曲', css: 'linear-gradient(135deg,rgb(32,49,112),rgb(52,76,146),rgb(74,102,180),rgb(100,126,210),rgb(130,132,224),rgb(130,132,224),rgb(100,126,210),rgb(74,102,180),rgb(52,76,146),rgb(32,49,112))' },
      ]

      const FLOW_IDS = FLOW_GRADS.map((grad) => grad.id)

      /** 当前选中的动画 id（由状态轮询写入；null = 还没拿到 → 按默认的流星走）。 */
      let flowStyleNow = null

      /** 本轮该用哪个动画：只认白名单 —— host 已经校验过一次，这里再兜一次，
       *  因为这个值会被拼进 class 名（宁可退回流星，也不许拼出奇怪的类）。 */
      function currentFlowStyle() {
        if (flowStyleNow === 'meteor') return 'meteor'
        return FLOW_IDS.includes(flowStyleNow) ? flowStyleNow : 'meteor'
      }

      /** 流光动画的样式表（含菜单里的小色块）—— 由 FLOW_GRADS 生成，单一数据源。 */
      function flowGradCss() {
        const lines = [
          // ★★★ 流光本体 = 一个**放大 5 倍**的渐变层，沿对角线来回平移。
          //
          // 为什么不用 background-repeat 平铺（第一版就是那么写的，被主人截图打回）：
          //   **135deg 的斜纹平铺时在拼接处必然错位** —— 斜线和矩形网格对不齐，
          //   截图里那道紫/蓝竖条就是接缝。平铺只有在"渐变轴与平铺方向一致"时才无缝
          //   （原来的 90deg 可以，斜的绝对不行，这是几何问题，调参救不回来）。
          // ✓ 现在：渐变只铺一层（no-repeat）铺满一个放大层，靠 transform 平移它、
          //   露出渐变的不同段落 —— 层比容器大 5 倍，平移 38% 也露不出边，
          //   所以**结构上不可能再出现任何接缝或色块断面**。
          '.dshqp-flow-grad {',
          '  position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: hidden;',
          '}',
          '.dshqp-flow-grad::before {',
          '  content: ""; position: absolute; inset: -200%;',
          '  background-size: 100% 100%; background-repeat: no-repeat;',
          // 主人 2026-10-08：「流光从左上扫到右下，衔接处…可以做一个循环，倒放回去」——
          //   ease-in-out + alternate：在两个端点自然减速、折返，全程没有"跳回起点"那一下。
          //   平移 38% × 层尺寸 ≈ 沿渐变轴走 40% 的长度（≈ 3~4 个色标的色差），
          //   所以颜色是"缓慢流过"，不是一闪而过。7s 是单程时长。
          '  animation: dshqp-flowgrad-run 7s ease-in-out infinite alternate;',
          '}',
          '@keyframes dshqp-flowgrad-run {',
          '  from { transform: translate3d(-38%, -38%, 0); }',
          '  to   { transform: translate3d(38%, 38%, 0); }',
          '}',
          '.dshqp-menu-swatch {',
          '  width: 10px; height: 10px; border-radius: 3px; flex: none;',
          '  border: 1px solid rgba(128,128,128,.35);',
          '}',
        ]
        for (const grad of FLOW_GRADS) {
          // 渐变落在 ::before 上（真正的动画层）；菜单小色块静态铺满即可。
          lines.push(`.dshqp-flow-grad-${grad.id}::before { background-image: ${grad.css}; }`)
          lines.push(`.dshqp-menu-swatch-${grad.id} { background-image: ${grad.css}; }`)
        }
        return lines.join('\n')
      }

      /** composer 卡片及其父级（兜底用）。 */
      function flowHost() {
        const card = document.querySelector('[data-composer-card]')
        return card !== null && card.parentElement !== null ? { card, host: card.parentElement } : null
      }

      /**
       * ★★ 2026-10-08：**消息列表容器**。
       * 主人 F12 诊断给出的真实结构（关键在于这个）：
       *   Dc7zOa_root
       *     ├─ …→ Dc7zOa_viewArea → xz4KEq_frame → xz4KEq_scroll → xz4KEq_column(13933px)
       *     │                                                      └─ xz4KEq_flowItem ← 每条消息
       *     └─ Dc7zOa_body → Dc7zOa_scrollBody → Dc7zOa_composerSeat ← composer
       * 即：**消息列表和 composer 是两棵独立子树**，共同祖先下只有 composer 座位 ——
       * 所以之前插进 composer 那一侧，周围注定是一片空白（主人截图正是如此）。
       * 定位方式：消息条目的类名是 `<hash>_flowItem` —— 哈希前缀会变，**本地名 flowItem 不会**
       * （MEMO 里记的锚点法）。取它的父级就是消息列表。
       */
      function messageHost() {
        try {
          const item = document.querySelector('[class*="flowItem"]')
          if (item !== null && item.parentElement !== null) return item.parentElement
        } catch (error) { /* 选择器不被支持就算了，走兜底 */ }
        return null
      }

      /** 往上找最近的"真滚动容器"（保存/恢复滚动位置要用它，消息列表本身不一定滚）。 */
      function scrollAncestor(el) {
        let node = el
        for (let depth = 0; depth < 6 && node !== null; depth += 1) {
          try {
            if (node.scrollHeight > node.clientHeight + 20) return node
          } catch (error) { /* 拿不到尺寸就继续往上 */ }
          node = node.parentElement
        }
        return el
      }

      /**
       * ★★★ 2026-10-08 六次修正 —— **重新启用"往消息列表末尾插动画"**，
       * 并且这次把上次失败的原因彻底查清了。
       *
       * 上一版把它整个删掉，理由是"主人界面整片空白、消息全没了"。
       * **但那个归因是错的**：主人重启后说"能翻看消息了"，167 条消息一条没少，
       * 证明**消息从未被删**。真正的元凶是同一段代码里的
       *     scroller.scrollTop = top
       * —— top 取到了 0，把视图设到了列表顶部那片空白上，看起来就像消息全没了。
       *
       * 所以结论**反转**：往消息列表里 append 自己的节点是**安全**的，只要做到三件事：
       *   ① **绝不碰 scrollTop / scrollIntoView**（上次唯一的错就在这一行）；
       *   ② 只 **append 到列表末尾**，绝不 insertBefore 到内核节点之间；
       *   ③ 挂 observer 守护自己的节点，被重渲染删掉就补回来。
       *
       * 位置上它是消息列表的最后一个子节点 =「我那条回复的下方」，
       * 因此**随消息流一起滚动** —— 往上翻历史时它像聊天记录一样跟着下去。
       */
      /** 出图标记的兜底定时器：到点无条件撤销标记（正常情况下永远用不到）。 */
      let drawingSafetyTimer = null

      function flowStart() {
        try {
          if (document.body) document.body.setAttribute(DRAWING_ATTR, '1')

          // ★★★ 三十次修正 —— **出图一开始就立刻隐藏一次，不等轮询那一拍**。
          //   主人明确要求「生图过程中不要思考过程」—— 连那 1.5 秒的轮询间隔也算"过程中"，
          //   所以这里立即执行一次，把此刻已存在的思考块 / 工具调用条目**当场藏掉**。
          //   （隐藏方式见 markReasoningBlocks：直接设内联 `display:none`，不走 CSS 规则。）
          // ★★★ 三十五次修正（配套）—— **先把"出图前就存在的条目"全部标记为旧**，
          //   之后 markReasoningBlocks 只处理"出图开始后新出现的"。
          //   为什么必须这样：在**上面**隐藏历史思考块会让**页面总高度骤减**，
          //   新对话里可滚动高度本就不多，一藏就**滚不动、翻不了聊天记录**
          //   （主人 2026-10-08 在新对话里复现的正是这个）。
          try {
            for (const it of document.querySelectorAll('[class*="flowItem"]')) it.__dshqpOld = true
          } catch (error) { /* 标记失败最多是多藏几条，不影响出图 */ }

          try { markReasoningBlocks() } catch (error) { /* 藏不了不影响出图 */ }

          // ★★★ 2026-10-08 二十三次修正（配套）—— **出图标记加超时兜底**。
          //   主人要求：「生图时才隐藏思考和调用工具过程，正常工程和对话不隐藏」。
          //   而这个标记只是 body 上的一个属性 —— 只要 flowFinish 没被调用就会一直留着，
          //   而 flowFinish 依赖"卡片确实渲染出了结果"，会话切走、工具被中断、
          //   进程卡住等情况都可能让它跑不到，标记于是永久生效 → 平时也隐藏思考。
          //   ✓ 兜底：**到点无条件撤销**（12 分钟，比后端的 10 分钟超时更宽裕）。
          //     正常情况下 flowFinish 早就撤掉了，这个定时器只是"永远用不到的保险"。
          if (drawingSafetyTimer !== null) clearTimeout(drawingSafetyTimer)
          drawingSafetyTimer = setTimeout(() => {
            drawingSafetyTimer = null
            try {
              if (document.body) document.body.removeAttribute(DRAWING_ATTR)
              stopReasoningWatch()
              const stale = document.getElementById(FLOW_ID)
              if (stale !== null) stale.remove()
            } catch (error) { /* 忽略 */ }
          }, 12 * 60 * 1000)

          const host = messageHost()
          if (host === null) return

          // ★★★ 三十九次修正
          //   （主人：「那个动画会播放两次，第一次稍微大一些播完马上又跳到小的去」）——
          //   **已经有健康节点就直接复用，绝不删了重建。**
          //
          //   旧写法是"先全局清干净、再插一个新的"，本意是防重复；但它带出一个新问题：
          //   `flowStart` 会被调用不止一次（卡片重渲染会重跑），于是节点被**删掉又新建**，
          //   **呼吸动画随之从头开始** —— 看起来就是"播了两次"。
          //   ✓ 现在：只要页面上已经存在一个 `#FLOW_ID` 节点，就**原样留着**，
          //     只确保它挂在正确的 host 里。重复调用变成"什么都不做"，动画不会被重置。
          let reused = null
          try { reused = document.getElementById(FLOW_ID) } catch (error) { reused = null }
          if (reused !== null) {
            if (reused.parentElement !== host) {
              try { host.appendChild(reused) } catch (error) { /* 挂不过去就当没有，下面会重建 */ }
            }
            if (reused.parentElement === host) {
              watchFlowNode(host)
              watchReasoning()
              return
            }
          }

          // 真没有节点时，才清理残留（正常情况这里已经没有东西可删）并新建
          try {
            for (const stale of document.querySelectorAll(`#${FLOW_ID}`)) {
              try { stale.remove() } catch (error) { /* 已经被移走 */ }
            }
          } catch (error) { /* 清理失败不影响后面的插入 */ }

          // ★★★ 2026-10-08 十一次修正 —— **一次都不碰滚动条**（这是最终结论）。
          //   四版滚动处理全错：① `scrollTop = 旧值` → 视图钉死 → 假空白；
          //   ② 什么都不做 → 视图停原处 → 也像空白；③ `if (atBottom) 跟到底部`
          //   → 出图后正常但**生成中滚不动**；④ 把 ③ 补到移除时 → 同样卡住。
          //   主人一句话定案：「往上滚有消息，但是生图时往上滚不了」——
          //   **DSH 在生成中本来就会跟随底部**，我的主动滚动与它叠加，
          //   破坏了"用户上滚则暂停跟随"的正常机制。
          //   ✓ 最终做法：**只 append 一个节点，滚动完全交给 DSH**（插件第一原则：最小侵入）。
          host.appendChild(makeFlowNode())
          watchFlowNode(host)
          // ★ 思考块观察器**只在这段时间挂着**（出图结束由 flowFinish 摘掉）
          watchReasoning()
        } catch (error) {
          warn(`出图动画插入失败（不影响出图）：${error && error.message ? error.message : error}`)
        }
      }

      /**
       * 造出图动画节点：9:16 金属块 + 流星 canvas + 文字。
       * 样式全在 CARD_CSS 里；流星粒子在这里启动，**只在出图期间跑**。
       */
      /**
       * ★★ 判断 DSH 当前是深色还是浅色主题
       *   （主人 2026-10-08：「我现在是深色背景啊，你识别错了」）。
       *
       *   **DSH 有自己的主题开关，不跟随系统** —— 所以 `prefers-color-scheme` 会判断错。
       *   最可靠的判据是**读实际背景色的亮度**：暗 → 深色主题，亮 → 浅色主题。
       *   读不到就退回问系统；再读不到就当深色（默认那块是银白金属，在深色界面上更醒目）。
       */
      function detectDarkTheme() {
        try {
          const el = document.body || document.documentElement
          const bg = getComputedStyle(el).backgroundColor || ''
          const m = bg.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
          if (m !== null) {
            const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])
            return lum < 140
          }
        } catch (error) { /* 读不到就走兜底 */ }
        try {
          if (typeof matchMedia === 'function') return !matchMedia('(prefers-color-scheme: light)').matches
        } catch (error) { /* 忽略 */ }
        return true
      }

      function makeFlowNode() {
        const box = document.createElement('div')
        box.id = FLOW_ID
        box.className = 'dshqp-flow'
        const style = currentFlowStyle()
        // ★ 把"当前主题"写进属性，CSS 据此在「银白金属 / 黑金属」之间切换
        try { box.setAttribute('data-dshqp-theme', detectDarkTheme() ? 'dark' : 'light') } catch (error) { /* 忽略 */ }

        if (style === 'meteor') {
          // ★ 流星画布（马卡龙流星从中心爆开、带拖尾、撞边反弹）
          try {
            const cv = document.createElement('canvas')
            cv.className = 'dshqp-flow-canvas'
            box.appendChild(cv)
            startMacaronBurst(cv)
          } catch (error) { /* 画布起不来就只显示金属底 + 高光，不影响出图 */ }

          const tip = document.createElement('div')
          tip.className = 'dshqp-flow-tip'
          tip.textContent = '感知世界中'
          box.appendChild(tip)
          return box
        }

        // ★★ 流光方案：**只做流光、一个字都不加**（主人 2026-10-08 明确要求）。
        //   尺寸和流星方案**完全一致**（9:16、320 高，由 .dshqp-flow 统一给），
        //   呼吸缩放照旧 —— 那是父元素上的 transform，与这里的背景流动互不干扰。
        //   data-dshqp-grad 这个属性是给 CSS 的开关：流光块**不要**再叠那道白色高光扫过，
        //   否则就成了两层光效，不是主人要的"只做流光"。
        try { box.setAttribute('data-dshqp-grad', style) } catch (error) { /* 忽略 */ }
        try {
          const layer = document.createElement('div')
          layer.className = `dshqp-flow-grad dshqp-flow-grad-${style}`
          box.appendChild(layer)
        } catch (error) { /* 流光层起不来就只剩底色，不影响出图 */ }
        return box
      }

      /**
       * ★★★ 马卡龙流星爆发（主人 2026-10-08 指定）：
       *   生图开始时，一堆马卡龙配色的流星**带浅色拖尾**从中心爆开、飞向四面八方，
       *   **撞到边缘反弹回来**。
       *
       *   性能自律（这里踩过卡死的坑，必须守）：
       *     · **只在出图期间跑** —— 节点一从文档移除，下一帧就自己停（见 isConnected 判断）
       *     · 粒子 24 个、速度逐帧衰减，**约 4 秒后自然结束**（不是全程跑粒子）
       *     · 画布固定 270×480（9:16）由 CSS 拉伸 —— 不按 devicePixelRatio 放大，省一半开销
       */
      function startMacaronBurst(canvas) {
        const MACARON = ['#FFB3BA', '#FFDFBA', '#FFF5BA', '#BAFFC9', '#BAE1FF', '#E0BBE4', '#FFC8DD', '#C7CEEA']
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
        if (raf === null) return undefined

        const W = 270
        const H = 480
        let ctx = null
        try {
          canvas.width = W
          canvas.height = H
          ctx = canvas.getContext('2d')
        } catch (error) { return undefined }
        if (ctx === null) return undefined

        const N = 24
        const parts = []
        for (let i = 0; i < N; i += 1) {
          const a = (Math.PI * 2 * i) / N + (Math.random() - 0.5) * 0.35
          const sp = 2.6 + Math.random() * 2.2
          parts.push({
            x: W / 2,
            y: H / 2,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            c: MACARON[i % MACARON.length],
            trail: [],
          })
        }

        // ★ 主人 2026-10-08：「流星保持弹性碰撞，撞到边缘原速度返回」+
        //   「不要淡出啊，要一直存在，直到图片生成完毕」
        //   → **无衰减、无淡出、无寿命上限**：一直匀速弹下去，
        //     直到 canvas 被移出文档（出图结束那一刻）才停。
        const step = () => {
          // ★ 节点已被移出文档（出图结束）→ 自己收工，不留常驻 rAF
          if (typeof canvas.isConnected === 'boolean' && !canvas.isConnected) return
          try { ctx.clearRect(0, 0, W, H) } catch (error) { return }

          for (const p of parts) {
            p.x += p.vx
            p.y += p.vy
            // ★ 无衰减 —— 弹性碰撞，撞到边缘原速度返回
            if (p.x < 0) { p.x = 0; p.vx = -p.vx }
            if (p.x > W) { p.x = W; p.vx = -p.vx }
            if (p.y < 0) { p.y = 0; p.vy = -p.vy }
            if (p.y > H) { p.y = H; p.vy = -p.vy }

            // 拖尾：★ 主人要求"再长一些" —— 从 6 个残影增到 12 个（长度大约翻倍）
            p.trail.push({ x: p.x, y: p.y })
            if (p.trail.length > 12) p.trail.shift()

            // 浅色拖尾（越靠后越淡越细；★ 不乘 life —— 流星全程存在）
            for (let t = 0; t < p.trail.length; t += 1) {
              const q = p.trail[t]
              const k = (t + 1) / p.trail.length
              ctx.globalAlpha = k * 0.34
              ctx.fillStyle = p.c
              ctx.beginPath()
              ctx.arc(q.x, q.y, 1 + k * 2.6, 0, Math.PI * 2)
              ctx.fill()
            }
            // 流星本体（马卡龙色 + 白色小核）
            ctx.globalAlpha = 0.95
            ctx.fillStyle = p.c
            ctx.beginPath()
            ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2)
            ctx.fill()
            ctx.globalAlpha = 0.85
            ctx.fillStyle = '#ffffff'
            ctx.beginPath()
            ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.globalAlpha = 1
          raf(step)
        }
        raf(step)
        return undefined
      }

      /**
       * 守护动画节点：DSH 用 React 渲染这棵树，重渲染时有可能把我们的节点清掉，
       * 删了就补回列表末尾 —— 这正是"只 append、不改别人"能安全共存的原因。
       *
       * ★★★ 2026-10-08 二十二次修正 —— **这里也从观察器改成低频轮询**。
       *   原因和思考块那处完全一样：`MutationObserver` 会被**任何 DOM 变化唤醒**，
       *   而 (UI)MOSS 里有 21 个常驻观察器、它们自己也在改 DOM ——
       *   "它改 → 唤醒我 → 我也改 → 再唤醒它"就是主人遇到的卡死。**这是最后一个环，现在断掉。**
       *   ✓ `setInterval` 不会因 DOM 变化被唤醒，**不可能参与任何反馈环**。
       */
      let flowGuard = null
      function watchFlowNode(host) {
        try {
          if (flowGuard !== null) { clearInterval(flowGuard); flowGuard = null }
          flowGuard = setInterval(() => {
            try {
              // 出图结束或列表已卸载 → 自己收工，不留常驻定时器
              if (!document.body || !document.body.hasAttribute(DRAWING_ATTR)) {
                if (flowGuard !== null) { clearInterval(flowGuard); flowGuard = null }
                return
              }
              if (host.parentElement === null) {
                if (flowGuard !== null) { clearInterval(flowGuard); flowGuard = null }
                return
              }
              // 节点还好端端待在列表里 → **什么都不做**（绝不能删了重建，那会让动画从头播）
              const existing = document.getElementById(FLOW_ID)
              if (existing !== null && existing.parentElement === host) return
              // 确实丢了才补：先清掉可能残留的同类节点，保证页面上**永远只有一个**
              for (const stale of document.querySelectorAll(`#${FLOW_ID}`)) {
                try { stale.remove() } catch (error) { /* 已经被移走 */ }
              }
              host.appendChild(makeFlowNode())
            } catch (error) { /* 单拍失败不影响下一拍 */ }
          }, 1000)
        } catch (error) { /* 定时器装不上只意味着"节点被删后不会自动补"，不影响出图 */ }
      }

      /** 出图完成（或失败）：撤掉标记，让动画平滑淡出后移除，把位置让给正文里的图片。 */
      function flowFinish() {
        try {
          if (document.body) document.body.removeAttribute(DRAWING_ATTR)

          // ★★★ 三十一次修正（主人：「现在生好图都有了，给我回调回去」）——
          //   **恢复"出图结束就停轮询"**。上一轮我把它改成常驻，导致出图后它还在藏、
          //   思考块一直不回来。这里**第一件事就是停掉它**，然后再还原隐藏。
          stopReasoningWatch()

          // ★★★ 三十次修正（关键）—— **把被内联隐藏的条目全部还原**。
          //   从这一版起，隐藏不再依赖 CSS 规则，而是**直接设 `element.style.display = 'none'`**
          //   （内联样式优先级最高、立刻生效，不受 CSS/选择器影响）。
          //   因此这里必须**逐一把 display 恢复回原值**，否则它们会永远消失。
          //   原值在隐藏时记在 `__dshqpPrevDisplay` 上（通常是空串，即交还给 CSS），这里精确还原。
          try {
            for (const el of document.querySelectorAll(`[${REASONING_ATTR}]`)) {
              try {
                el.style.display = el.__dshqpPrevDisplay || ''
                delete el.__dshqpPrevDisplay
              } catch (error) { /* 单个还原失败不影响其它 */ }
              el.removeAttribute(REASONING_ATTR)
            }
          } catch (error) { /* 还原失败最坏是它们一直藏着；下次出图不会更糟 */ }
          // ★ 标记已撤销，兜底定时器就没必要了（不清掉它 12 分钟后会白跑一次）
          if (drawingSafetyTimer !== null) { clearTimeout(drawingSafetyTimer); drawingSafetyTimer = null }
          if (flowHideTimer !== null) clearTimeout(flowHideTimer)
          // ★ 上一版把变量从 flowObserver（观察器）改成了 flowGuard（轮询定时器），
          //   这里必须同步改 —— 否则出图结束时会因引用未定义变量而抛错。
          if (flowGuard !== null) { clearInterval(flowGuard); flowGuard = null }
          const box = document.getElementById(FLOW_ID)
          if (box === null) return
          // ★ 同样**不碰滚动**（理由见 flowStart 的十一次修正说明）：
          //   移除后由 DSH 自己跟随底部，我插手只会破坏它的正常机制。
          box.setAttribute('data-done', '1')          // CSS 里做淡出
          flowHideTimer = setTimeout(() => {
            flowHideTimer = null
            try { box.remove() } catch (error) { /* 已被移除 */ }
          }, 460)
        } catch (error) {
          /* 清理失败无所谓，下次出图会重建 */
        }
      }

      /**
       * 给"正在思考"的块打标记，供 CSS 在出图期间隐藏它。
       * ★ 用**文案**而不是哈希类名定位：类名随构建变，界面上那句「深度求索中」不会。
       *   只认"元素自己的直接文本"（长度 < 60），避免把整棵祖先树都标上。
       */
      // ★★ 2026-10-07 修正：内核实际用的文案是「已完成分析 / 正在分析」——
      //    我最初猜的「深度求索」匹配不上，所以思考块一直没被隐藏（主人截图里给了答案）。
      //    同时保留 Thinking/Reasoning 以兼容英文界面。
      // ★★ 2026-10-08 再修正（主人截图给了准确文案）：
      //    实际是「**正在分析请求**」，而且那行后面还跟着大段思考内容。
      //    所以匹配改成**行首匹配**（思考块的文案必然在开头），并补齐所有见过的写法。
      // ★★ 2026-10-08 再扩（主人要求：「所有有关你思考的内容及其图标全部隐藏」）：
      //    把「正在调用工具」那一行也纳入匹配 —— 它是工具调用的摘要行，
      //    左边那个 ⚡ 图标是同一块内的元素，隐藏整块时会跟着一起走。
      const REASONING_TEXT_RE = /^\s*(正在分析请求|正在分析|已完成分析|分析中|正在调用工具|调用工具|深度求索|正在思考|思考中|Thinking|Reasoning|Calling)/u
      function markReasoningBlocks() {
        try {
          // ★★★ 2026-10-08 十八次修正 —— **性能修复：不在出图期间就直接退出**。
          //   事故：主人开着录屏在另一个会话生图，**整个界面卡死、什么都点不了**，
          //   而性能面板显示占用并不高。
          //   根因就在这里：这套扫描原来**从 DSH 启动起就一直在跑**，而且 observer
          //   用了 `subtree: true` —— 流式输出时 DOM 每秒变化几十上百次，每次都触发
          //   一遍"全页 querySelectorAll + 逐元素遍历 childNodes"，把**渲染主线程**占满。
          //   主线程是单线程，所以界面冻住但 CPU 总量不高 —— 性能条自然看不出来
          //   （叠加录屏抓屏后，卡得更彻底）。
          //   ✓ 修法：**只有出图期间才扫描**（body 上的 DRAWING_ATTR 就是出图标记）。
          //     平时这个函数被调用也会在第一行立刻返回，开销可以忽略。
          if (!document.body || !document.body.hasAttribute(DRAWING_ATTR)) return

          const spot = flowHost()
          // ★★ 2026-10-08：扫描范围直接用 document.body —— 主人 F12 诊断显示
          //    "被标记的思考块数量 = 0"，证明之前那个"往上爬 4 层"的范围**根本扫不到消息列表里的思考块**。
          //    性能可接受：只在 DOM 变化后节流 400ms 跑一次，且只读属性。
          const root = document.body
          if (!root || typeof root.querySelectorAll !== 'function') return
          // ★★ 性能护栏（十八次修正的配套）：**全页元素上限**。
          //   消息多的会话（主人这个已有 195 条）全页上万元素，即便 400ms 一次
          //   也不该无上限遍历。超过上限就**只扫消息列表那一块**，够用且便宜。
          let all
          try {
            all = root.querySelectorAll('div,span,button,p')
          } catch (error) { all = [] }
          if (all.length > 4000) {
            const list = messageHost()
            if (list !== null) {
              try { all = list.querySelectorAll('div,span,button,p') } catch (error) { all = [] }
            }
          }
          // ★★★ 2026-10-08 二十六次修正 —— **换方向：不往上爬，直接在"条目层"判断**。
          //
          //   主人要求：「思考过程可以有，但是思考结束时的生图动画只能有一句话和一个动画」。
          //   之前几版都在做同一件事：**从"文案所在的内层元素往上爬"去找整块** ——
          //   反复失败（主人实测：被标记的 14 个**全是** `SPAN.WW4l1q_label`，只藏住一行字、
          //   图标照旧）。根因是"文字"和"图标"虽然属于同一条消息，却**在两棵很远的子树里**，
          //   爬多少层、在哪里 break，**都是在赌 DOM 嵌套**。
          //
          //   ✓ 正解：**不爬了**。直接遍历"条目"这一层（`flowItem`，实测确认存在），
          //     用**条目自身的文本**判断 —— 图标、标题、内容都在条目里，
          //     命中就整条隐藏，图标自然一起消失。**只依赖一个层级，不依赖任何嵌套细节。**
          //
          //   ★★ 二十七次修正（主人反馈「越来越严重了」—— 新版什么都没藏住）：
          //     原因是我上一版加的两条限制**自相矛盾地严**：
          //       · `txt.length >= 800 → skip`：**思考块内容往往远超 800 字**，整条被跳过；
          //       · `REASONING_TEXT_RE` 是**行首匹配**（`^\s*(…)`）：而条目的 textContent
          //         开头可能是图标字符或别的文字，**根本匹配不上**。
          //     两条叠加 → "思考块""工具调用"全都不符合条件 → **一个都没藏**。
          //
          //   ✓ 现在改成：
          //     · **只看前 200 字**（不限制总长度）—— 标题/摘要必然在这一段里；
          //     · **用"包含"匹配**（不要求出现在开头）；
          //     · 高度上限放宽到 2000 —— 文本匹配本身已经够精确
          //       （实测长正文开头是「你说得对，我该定位…」，不会误中）。
          //   ★★ 匹配自测（本地用真实文案跑过）抓到一条漏洞：
          //     思考块的条目文本开头是「**思考**⚠️ 主人说：…」——
          //     而原来的正则里只有 `正在思考` / `思考中`，**没有单独的「思考」**，
          //     所以这一条**永远匹配不上**。已补上。
          //     其余用例（"已完成分析"✓ / "正在调用工具…"✓ / "好——一只猫。"✗ /
          //     "你说得对，我该定位…"✗ / "画好了。"✗）全部符合预期。
          const ITEM_TEXT_RE = /(思考|正在分析请求|正在分析|已完成分析|分析中|正在调用工具|调用工具|深度求索|Thinking|Reasoning|Calling)/u
          const items = (() => {
            try { return document.querySelectorAll('[class*="flowItem"]') } catch (error) { return [] }
          })()
          // ★★★ 三十二次修正 —— **三个以前没试过的做法**
          //   （主人：「这两个东西真的没办法隐藏吗，能不能最后想一个以前没试过的办法」）。
          //
          //   以前反复失败的根源很清楚：**我一直在"手写循环往上爬"找条目** ——
          //   爬几层、在哪里 break 全靠猜，于是反复够不到
          //   （实测标记总是落在内层的 `SPAN.WW4l1q_label` 上，带图标的那行死活进不了范围）。
          //
          //   这次换三样**以前没用过**的：
          //     ① **`TreeWalker`（原生）** —— 只遍历**文本节点**，找到**直接含关键词的那一行**。
          //        比 `querySelectorAll('div,span,…')` 精确得多，也不会误伤正文
          //        （正文的文本节点长，一眼排除）。
          //     ② **`el.closest('[class*="flowItem"]')`（原生）** —— 浏览器自己往上找祖先。
          //        它**不存在"爬不到"**：要么返回元素、要么返回 null。
          //        **若返回 null，就证明那一行真的不在 flowItem 里** —— 那是确定结论，
          //        不是又一次"猜错了"。
          //     ③ **内联 `display:none`** —— 一环生效，不走 CSS 规则。
          //
          //   并把结果**打到 Console**：一次就能看出成没成，不用再截图猜。
          const KW = ['已完成分析', '正在分析请求', '正在分析', '正在调用工具', '调用工具', '深度求索', '思考']
          let hitText = 0
          let hitItem = 0
          let missItem = 0
          try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
            const parents = new Set()
            let tn = walker.nextNode()
            while (tn !== null) {
              const raw = (tn.nodeValue || '').trim()
              if (raw !== '' && raw.length <= 120 && KW.some((k) => raw.indexOf(k) !== -1)) {
                if (tn.parentElement !== null) parents.add(tn.parentElement)
              }
              tn = walker.nextNode()
            }
            hitText = parents.size
            //   ★★★ 三十三次修正 —— 按主人贴出的 Console 日志改，两点都定案了：
            //     日志原文：`有 23 处关键词所在元素 closest('flowItem') 返回 null`
            //       → **`closest()` 是原生 API，返回 null 就代表"往上直到 body 都没有 flowItem"**，
            //         这是**确定结论**：那两行（「已完成分析」「正在调用工具」）**根本不在条目里**。
            //         所以我之前所有"找条目"的努力注定失败 —— 方向从一开始就错了。
            //     日志还显示：**被藏掉的 30 多条全是"思考…"开头的历史条目** ——
            //         那不是主人要的（他要的是**当前这次**出图里的），说明离屏的历史节点也被动了。
            //   ✓ 两条修法：
            //     A. **只处理真正可见的元素** —— 离屏/已卸载子树的 `offsetParent` 是 null，
            //        一眼排除，**不会再动历史消息**；
            //     B. **`closest` 失败时退回"最近的合理祖先"** —— 往上找第一个
            //        "高度 0~300px 且有宽度"的容器并藏掉。不管那两行在什么结构里，都能命中。
            for (const el of parents) {
              // A. 可见性过滤：离屏节点一律不碰
              let visible = true
              try { visible = el.offsetParent !== null } catch (error) { visible = true }
              if (!visible) continue

              // ★★★ 三十五次修正
              //   （主人：「我在新对话里让画图时复现了无法翻看聊天记录的bug」）——
              //   **只处理"本次出图"产生的条目；出图之前就存在的一律不碰。**
              //
              //   根因：在**上面**把历史思考块 display:none 掉，会让**页面总高度骤减**；
              //   新对话历史本来就短，一藏就把可滚动高度吃光 → **滚不动、翻不了记录**。
              //
              //   ⚠ 注意这**不是**昨天那个 scrollTop 的 bug ——
              //     代码里已经没有任何 scrollTop 写入（昨天是因为我亲自写 scrollTop 把视图钉死）；
              //     这次是我"改了内容高度"，机制完全不同。
              //   旧条目在 flowStart 时统一打了 __dshqpOld 标记，这里直接跳过。
              let oldNode = el
              let isOld = false
              for (let d = 0; d < 8 && oldNode !== null && oldNode !== document.body; d += 1) {
                if (oldNode.__dshqpOld === true) { isOld = true; break }
                oldNode = oldNode.parentElement
              }
              if (isOld) continue

              let item = typeof el.closest === 'function' ? el.closest('[class*="flowItem"]') : null
              // ★★★ 三十六次修正 —— **删掉"退回最近合理祖先"这条退路**。
              //   事故（主人截图：聊天区整片空白，连「好 —— 一只狗」都没了）：
              //   那条退路是"往上找一个高度 <= 300px 的容器就当目标" ——
              //   而**新对话内容少，消息列表本身就不足 300px 高**，于是它被选中、
              //   **整块被藏掉**，界面看起来和昨晚那次"空白"一模一样
              //   （但机制完全不同：那次是我写 scrollTop 把视图钉死，这次是我把消息列表
              //     本身设成了 display:none）。
              //   ✓ 现在：找不到条目就**直接跳过**，绝不退而求其次。
              //     `closest` 本来就能成功（日志已证明），这条退路是纯粹的风险源。
              if (item === null) { missItem += 1; continue }

              // ★★ 硬保护：**要藏的元素里若含 2 个以上条目，它必定是消息容器** —— 放弃。
              //    这比任何"层数 / 高度"判据都可靠，直接卡死"藏掉整个聊天区"这类事故。
              let innerItems = 0
              try {
                if (typeof item.querySelectorAll === 'function') innerItems = item.querySelectorAll('[class*="flowItem"]').length
              } catch (error) { innerItems = 0 }
              if (innerItems > 1) { missItem += 1; continue }

              // ★★★ 三十八次修正 —— **最后一道保险：只对"很矮"的元素动手**。
              //   要藏的条目本来就很矮（思考块标题行、工具调用摘要行都是一行文字）；
              //   而**消息列表在任何情况下都高于 120px**（哪怕刚开的新对话也有一句话 + 输入区）。
              //   所以这条一加上，"误藏聊天区"在原理上就不可能发生。
              let itemH = 0
              try { itemH = item.getBoundingClientRect().height } catch (error) { itemH = 0 }
              if (itemH > 120) { missItem += 1; continue }

              if (item.__dshqpHidden === true) continue
              item.__dshqpHidden = true
              item.__dshqpPrevDisplay = item.style.display || ''
              item.style.display = 'none'          // ★ 内联样式，立刻生效
              item.setAttribute(REASONING_ATTR, '1')
              hitItem += 1
              if (item.__dshqpLogged !== true) {
                item.__dshqpLogged = true
                const tag = (item.className || '').toString().slice(0, 34)
                console.log(`[qwen-paint] 已隐藏: ${tag}  「${(item.textContent || '').trim().slice(0, 24)}」`)
              }
            }

            // ★★★ 三十四次修正 —— **处理"没有文本的图标"**。
            //   主人反馈：「文字都没了这是好消息，但是想想有没有办法定位并隐藏这两个图标」。
            //   根因：那两个图标是 **`<svg>`** —— **没有文本节点**，
            //   而上面的 `TreeWalker` 只遍历文本节点，**根本扫不到它们**。
            //
            //   ✓ 反过来走：**遍历可见的小图标，看它"往上几层的祖先里有没有含关键词的文本"**。
            //     关键：`display:none` **不会清掉 `textContent`** ——
            //     所以刚刚被藏起来的「已完成分析」那层，**文本仍然读得到**，
            //     于是能顺着它找到"同时罩住图标和文字"的那个祖先并藏掉。
            //   两道保护：祖先高度必须 0~300px（别藏成大容器）、必须可见。
            let hiddenIcons = 0
            const svgs = document.querySelectorAll('svg')
            for (const s of svgs) {
              let sVisible = true
              try { sVisible = s.offsetParent !== null } catch (error) { sVisible = true }
              if (!sVisible) continue
              let su = s.parentElement
              for (let d = 0; d < 6 && su !== null && su !== document.body; d += 1) {
                // ★★ 三十七次修正 —— 与上面同理的**硬保护**：
                //   候选祖先里若含 2 个以上条目，它一定是消息容器（或更外层），**放弃**。
                //   这直接卡死"藏掉整个聊天区"的事故（主人截图那次就是退路选错了层）。
                let innerItems = 0
                try {
                  if (typeof su.querySelectorAll === 'function') innerItems = su.querySelectorAll('[class*="flowItem"]').length
                } catch (error) { innerItems = 0 }
                if (innerItems > 1) break

                let st = ''
                try { st = (su.textContent || '').trim().slice(0, 60) } catch (error) { st = '' }
                if (st !== '' && KW.some((k) => st.indexOf(k) !== -1)) {
                  let r = null
                  try { r = su.getBoundingClientRect() } catch (error) { r = null }
                  // ★ 高度上限收紧到 200px —— 图标那一行本来就很矮，别给它机会选到大容器
                  const fits = r !== null && r.height >= 0 && r.height <= 200 && r.width > 0
                  if (fits && su.__dshqpHidden !== true) {
                    su.__dshqpHidden = true
                    su.__dshqpPrevDisplay = su.style.display || ''
                    su.style.display = 'none'
                    su.setAttribute(REASONING_ATTR, '1')
                    hiddenIcons += 1
                    if (su.__dshqpLogged !== true) {
                      su.__dshqpLogged = true
                      console.log(`[qwen-paint] 已隐藏图标容器: ${(su.className || '').toString().slice(0, 30)}`)
                    }
                  }
                  break
                }
                su = su.parentElement
              }
            }
            if (hiddenIcons > 0) {
              console.log(`[qwen-paint] 本轮清掉图标容器 ${hiddenIcons} 个`)
            }
          } catch (error) {
            warn(`思考块隐藏（TreeWalker 法）出错：${error && error.message ? error.message : error}`)
          }
          if (missItem > 0) {
            console.log(`[qwen-paint] 有 ${missItem} 处关键词所在元素 closest('flowItem') 返回 null —— 说明它们不在条目里`)
          }

          // ★★ 2026-10-08：把结果**写到动画块上**，不要只留在 Console。
          //   起因：朋友那台「思考根本藏不住」，而这套匹配是**依赖 DSH 界面文案 + DOM 结构**的，
          //   版本一变就可能失效 —— 可诊断信息只打在 Console 里，**用户看不到，作者也只能靠猜** ✗
          //   ✓ 现在动画块上会显示一行小字：藏了几条 / 扫到几处关键词 / 有几处不在条目里。
          //     **截一张图就能定位问题在哪个环节。**
          reportReasoningNote(
            hitItem > 0
              ? `已隐藏思考/工具条目 ${hitItem} 条（扫到 ${hitText} 处关键词）`
              : `⚠ 没找到可隐藏的思考条目（扫到 ${hitText} 处关键词`
                + (missItem > 0 ? `，其中 ${missItem} 处不在条目里` : '') + '）',
          )
        } catch (error) {
          reportReasoningNote(`⚠ 隐藏思考时出错：${error && error.message ? error.message : error}`)
        }
      }

      /**
       * 把「隐藏思考」的结果写到出图动画块上 —— Console 之外，让用户也看得见。
       * ⚠ 用内联样式，不往 CARD_CSS 里加规则（那个模板字符串里出现反引号会截断脚本）。
       */
      function reportReasoningNote(text) {
        try {
          const host = flowHost()
          if (host === null) {
            console.log(`[qwen-paint] ${text}`)
            return
          }
          let el = host.querySelector('.dshqp-reason-note')
          if (el === null) {
            el = document.createElement('div')
            el.className = 'dshqp-reason-note'
            el.style.cssText = 'margin-top:6px;font-size:11px;line-height:1.4;opacity:.75;text-align:center;'
            host.appendChild(el)
          }
          el.textContent = text
        } catch (error) {
          /* 显示不出来不影响出图 */
        }
      }

      /**
       * ★★★ 2026-10-08 二十一次修正 —— **用低频轮询取代 MutationObserver**。
       *
       *   这是"两个插件互相触发"的断环点。关键区别：
       *     · `MutationObserver` 会被**任何 DOM 变化唤醒**。而 (UI)MOSS 里有 21 个
       *       常驻观察器、并且它们自己也在改 DOM —— 于是形成**反馈环**：
       *         MOSS 改 DOM → 唤醒我 → 我也改 DOM → 再唤醒 MOSS → …
       *       这正是"单独用都没事、两个一起就卡"的典型特征。
       *     · `setInterval` **不会因为 DOM 变化而被唤醒**，所以**根本不参与这个环**。
       *
       *   ✓ 做法：**只在出图期间**每 800ms 看一次（低频、开销可忽略），
       *     出图一结束立刻 clearInterval —— 平时界面**零常驻、零监听**。
       *     即便某一拍变慢，也只是那一拍，不可能累积成雪崩。
       */
      let reasoningTimer = null
      let reasoningPoll = null

      /**
       * ★★★ 2026-10-08 二十九次修正 —— **改成常驻低频轮询（不再"出图结束就收工"）**。
       *
       *   主人一针见血：「我说的是**生图过程中**不要思考过程，你**生完图**倒是没有图标了」。
       *   原因：我把"打标记"和"隐藏"绑在了同一个时机 —— 只在出图期间才扫描，
       *   于是出图时它还没标记上，等标好了出图的窗口已经过去。
       *
       *   ✓ 现在的分工：
       *     · **打标记**：常驻、每 1500ms 一次 —— 思考块一出现就标好，
       *       出图一开始就能**瞬间**隐藏，不用等扫描跑到；
       *     · **隐藏**：仍由 CSS 的 `body[data-dshqp-drawing]` 条件控制，
       *       **只在出图那 40 秒生效**，平时照常显示。
       *
       *   ⚠ 性能：上一轮卡死是 **MutationObserver 被 DOM 变化唤醒**造成的（会互相激励成环）。
       *     这里用的是 **setInterval 固定节拍**（1.5 秒一次），与 DOM 变化无关、
       *     **不可能成环**；扫描另有 4000 元素上限。**所以常驻是安全的。**
       */
      function watchReasoning() {
        try {
          if (reasoningPoll !== null) return              // 已经在轮询，别重复挂
          markReasoningBlocks()
          reasoningPoll = setInterval(() => {
            try {
              // ★★★ 三十一次修正（主人：「现在生好图都有了，给我回调回去」）——
              //   **轮询必须只在出图期间跑，出图一结束立刻收工**。
              //   上一轮我把它改成了"常驻"，于是出图结束后它**还在继续藏**，
              //   结果"生好图"之后思考块也一直不出来 —— 这就是那句反馈的成因。
              //   ✓ 现在：出图标记一消失（flowFinish 撤掉它），下一拍就自己停；
              //     同时由 flowFinish 负责把**所有已隐藏的条目全部还原**。
              if (!document.body || !document.body.hasAttribute(DRAWING_ATTR)) {
                stopReasoningWatch()
                return
              }
              markReasoningBlocks()
            } catch (error) { /* 单拍失败不影响下一拍 */ }
          }, 1500)
        } catch (error) {
          /* 定时器装不上就退化成"不隐藏思考块"，不影响出图 */
        }
      }

      /** 出图结束：停掉轮询，界面回到"零常驻、零监听"状态。 */
      function stopReasoningWatch() {
        try {
          if (reasoningPoll !== null) { clearInterval(reasoningPoll); reasoningPoll = null }
          if (reasoningTimer !== null) { clearTimeout(reasoningTimer); reasoningTimer = null }
        } catch (error) { /* 忽略 */ }
      }

      /** 只用中性色，不猜 --dsw-alias-* 的名字；明暗主题都不会坏。 */
      const CARD_CSS = `
.dshqp-card { display: flex; flex-direction: column; gap: 6px; max-width: 380px; }
.dshqp-img { display: block; width: 100%; height: auto; border-radius: 10px; border: 1px solid rgba(128,128,128,.30); }
/* ★ 呼吸灯 → 图片的平滑过渡（主人 2026-10-07 指定："图片出来后立刻平滑转换为生成的图片"）。
   做法：图片入场时淡入 + 从略小放大，配合呼吸灯消失，读起来就是那只灯"展开"成了图。
   为什么不做呼吸灯的退场动画：它在 React 里是**被直接卸载**的、没有退场时机；
   靠"图片随即淡入"视觉上已经连贯，不值得为它加延迟卸载的复杂度。 */
.dshqp-img { animation: dshqp-reveal .45s cubic-bezier(.22,.8,.28,1) both; }
@keyframes dshqp-reveal {
  from { opacity: 0; transform: scale(.94) translateY(4px); }
  to   { opacity: 1; transform: none; }
}
.dshqp-name { font-size: 12px; line-height: 1.4; opacity: .62; word-break: break-all; }
.dshqp-pending { font-size: 13px; line-height: 1.5; opacity: .72; }
/* ★ 生成中的「RGB 呼吸灯」（主人 2026-10-07 指定）：
   正方形 + 白色流光从左上扫到右下 + 下方小字「正在生成图片」。
   纯 CSS 动画，不占 JS、不依赖 React 重渲染，卸载时随 style 一起摘掉。 */
.dshqp-loading { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px 0; }
.dshqp-lamp {
  position: relative; width: 96px; height: 96px; border-radius: 14px; overflow: hidden;
  background: conic-gradient(from 0deg, #ff5f6d, #ffc371, #46e891, #38bdf8, #a855f7, #ff5f6d);
  animation: dshqp-breathe 2.6s ease-in-out infinite;
}
@keyframes dshqp-breathe {
  0%, 100% { opacity: .55; filter: saturate(.85); }
  50%      { opacity: 1;   filter: saturate(1.3); }
}
.dshqp-lamp::after {
  content: ""; position: absolute; inset: -45%;
  background: linear-gradient(115deg, transparent 40%, rgba(255,255,255,.95) 50%, transparent 60%);
  animation: dshqp-sweep 1.8s linear infinite;
}
@keyframes dshqp-sweep {
  from { transform: translate(-58%, -58%); }
  to   { transform: translate(58%, 58%); }
}
.dshqp-loading-text { font-size: 12px; line-height: 1.3; opacity: .82; }
.dshqp-error { font-size: 13px; line-height: 1.5; color: #e5484d; white-space: pre-wrap; word-break: break-word; }
.dshqp-seat { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 1; opacity: .8; white-space: nowrap; }
.dshqp-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(128,128,128,.55); flex: none; }
.dshqp-dot[data-state="on"] { background: #30a46c; box-shadow: 0 0 5px rgba(48,164,108,.8); }
.dshqp-dot[data-state="busy"] { background: #f5a623; box-shadow: 0 0 5px rgba(245,166,35,.8); }
/* ★ 点状态点弹出的「自动关闭时长」菜单（主人 2026-10-07 新增需求：可以选择多久后关后端）。
   向上弹出，避免被 composer 下边缘裁掉。 */
.dshqp-seat[data-clickable="1"] { cursor: pointer; position: relative; }
.dshqp-menu {
  /* ★★★ 主人 2026-10-08 两次反馈后的定案：**挂到 body 上 + fixed 定位**。
     原来是 seat 的子元素 + absolute 定位，会被 composer 那一串祖先的 overflow **裁掉** ——
     新会话里 composer 被抬到屏幕顶部，菜单直接被切头，而且**滚动也救不了**
     （裁的是元素的可见区域，不是它自己的滚动内容）。
     挂到 body 就跟祖先裁剪彻底无关了；坐标由 placeMenu() 每次打开时现算。 */
  position: fixed; top: 0; left: 0; z-index: 2147483000;
  display: flex; flex-direction: column; min-width: 150px; padding: 4px;
  border-radius: 10px; background: rgba(30,30,34,.97);
  border: 1px solid rgba(128,128,128,.38); box-shadow: 0 10px 28px rgba(0,0,0,.45);
  /* ★ 主人 2026-10-08：「把这个选择界面稍微调小一点试试」——
     上限 560 → 400，字号/行距也各收一档（配合 max-height 一起看）。 */
  max-height: min(70vh, 400px); overflow-y: auto; overscroll-behavior: contain;
}
/* 分组小标题（「自动关闭」/「生图动画」） */
.dshqp-menu-head {
  font-size: 10.5px; font-weight: 700; letter-spacing: .04em; opacity: .55;
  padding: 5px 9px 2px; text-align: left; white-space: nowrap;
}
/* 非第一组的分组标题上方加一条分隔线，视觉上分得清两组 */
.dshqp-menu-head + .dshqp-menu-item { margin-top: 1px; }
.dshqp-menu-head:not(:first-child) {
  margin-top: 4px; border-top: 1px solid rgba(128,128,128,.26); padding-top: 6px;
}
/* ★ 子标题（「流光 · 抄自月匠」）：比组标题更轻，**不带**上面那条分隔线 ——
   它紧跟在「流星」那一项后面，画一条线会把"流星属于生图动画"这层关系切断。
   ⚠ 这条必须写在 .dshqp-menu-head:not(:first-child) 之后（两者特异性相同，靠顺序取胜）。 */
.dshqp-menu-head.dshqp-menu-sub {
  border-top: 0; margin-top: 1px; padding-top: 4px;
  opacity: .45; font-size: 10px;
}
/* 「流星」名字前面的小圆点（主人要求：给自制那个标个点） */
.dshqp-menu-bullet {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: linear-gradient(135deg, #ffd7a1, #ff8fb1 48%, #8fa9ff);
}
/* 名字后面的来源小标签（自制） */
.dshqp-menu-tag {
  font-size: 9.5px; line-height: 1; padding: 1px 5px; border-radius: 999px; flex: none;
  border: 1px solid rgba(128,128,128,.45); opacity: .75;
}
.dshqp-menu-item {
  display: flex; align-items: center; gap: 5px;
  text-align: left; font-size: 11.5px; line-height: 1.2; padding: 5px 9px; border: 0;
  border-radius: 6px; background: transparent; color: #e8e8ea; cursor: pointer; white-space: nowrap;
}
.dshqp-menu-item:hover { background: rgba(128,128,128,.24); }
/* ★ 2026-10-08 主人要求：把「当前选中的档位」高亮出来。
   勾位是固定 12px 宽的占位（未选中时 content 为空串，但位置照样占着），
   这样条目文字左边缘对齐，选中与不选中之间不会左右跳动。 */
.dshqp-menu-item::before { content: ""; flex: none; width: 11px; text-align: center; }
.dshqp-menu-item[data-current="1"] { background: rgba(90,160,255,.20); color: #cfe3ff; font-weight: 600; }
.dshqp-menu-item[data-current="1"]:hover { background: rgba(90,160,255,.30); }
.dshqp-menu-item[data-current="1"]::before { content: "\\2713"; }
/* ★★ 出图时**不再**换成"迷你流光灯" —— 主人 2026-10-08 要求改回**小黄点**，
   好和 README 里那张颜色表（🟡 黄 = 正在出图）对上。
   原来的 .dshqp-dot.dshqp-dot-lamp 规则、它用的 dshqp-flow-color 关键帧，
   以及 dshqp-sweep 的引用都已一并清掉 —— 那三样只有它俩互相引用，删干净不留死代码。
   现在出图就是 .dshqp-dot[data-state="busy"] 那条黄底 + 光晕，和在线/未启动同尺寸。 */
/* ★★★ 出图动画（2026-10-08 全面重做，主人指定）：
   ① 比例改成 **9:16**（手机壁纸）
   ② **跟随系统主题**：浅色系统 = 黑金属；深色系统 = 银白金属
   ③ 金属质感：多段斜向渐变 + 一道高光从左上扫到右下
   ④ 中心爆发马卡龙流星（canvas 层，见 makeFlowNode）
   位置仍是"我那条回复的下方"，随消息流滚动。
   ⚠ flex: none 必须保留 —— 消息列表是 flex 纵向容器，不加它这块会撑满剩余空间、
     把上面的消息全部挤出视口（踩过两次，界面看起来像"全空了"）。
   ⚠ 高度用 min(480px, 62vh)：竖屏比例在高窗口里也不至于顶掉半边界面。
   ⚠⚠ 本段注释里**绝对不许出现反引号** —— CARD_CSS 是 JS 模板字符串，
      反引号会把它提前截断（这个坑 MEMO 里记过两次，我这次又踩了第三次）。 */
.dshqp-flow {
  flex: none;
  position: relative; z-index: 1;
  /* ★ 主人 2026-10-08：小一些（320 高）、靠左。
     ⚠ 高度用**固定 320px**，不用 vh ——
       主人反馈「第一次稍微大一些播完马上又跳到小的去」：
       min(320px, 44vh) 那种写法里的 vh 会随**视口高度**变化（composer 展开、布局稳定后都会变），
       于是块在插入后**尺寸跳变**。固定像素值就完全不会跳。
     ⚠ align-self: flex-start 是**必须的** —— 消息列表是纵向 flex 容器，
       交叉轴默认 stretch 会把这块**横向拉满**，aspect-ratio 9/16 就失效了
       （主人截图里它变成横的，就是这个原因）。 */
  align-self: flex-start;
  height: 320px; aspect-ratio: 9 / 16;
  width: auto; max-width: 100%; margin: 10px 0 14px;
  border-radius: 16px; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  /* ★★ 深色主题（默认）= 黑金属。
     主人 2026-10-08 第二次确认：「我现在是黑色主题**应该用黑色金属**」。 */
  background: linear-gradient(135deg,
    #16171b 0%, #33363f 18%, #4a4e59 34%, #1b1d22 52%,
    #2c2f37 68%, #0e0f12 84%, #23252b 100%);
  transition: opacity .42s ease, transform .42s ease;
  /* ★ 主人 2026-10-08：整块"呼吸"——缓慢放大缩小（幅度 2.2%、周期 4 秒）。
     transform 不改变布局，所以不会挤到消息、也不影响滚动位置。 */
  animation: dshqp-flow-breathe 4s ease-in-out infinite;
}
@keyframes dshqp-flow-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.022); }
}
/* ★ 出图结束：淡出 + 轻微缩小，把位置让给正文里的图片。
   ⚠ 必须 animation: none —— 否则上面"呼吸"里的 transform 会盖住这里的 scale(.97)，
     淡出看起来就"没有缩放"。（属性选择器的权重不如 animation 内的 transform，踩过。） */
.dshqp-flow[data-done="1"] {
  animation: none;
  opacity: 0;
  transform: scale(.97);
}
/* ★★ 浅色主题 = 银白金属（与上面正好相反）。
   主题由 JS 读**实际背景色的亮度**判定后写成 data-dshqp-theme（见 detectDarkTheme），
   CSS 只认这个属性 —— DSH 有自己的主题开关、不跟随系统，所以不能用 prefers-color-scheme。
   ⚠⚠ 本段注释里绝对不许出现反引号（CARD_CSS 是 JS 模板字符串，会被提前截断 —— 已踩四次）。 */
.dshqp-flow[data-dshqp-theme="light"] {
  background: linear-gradient(135deg,
    #f2f3f7 0%, #c9ccd6 18%, #ffffff 34%, #b9bdc9 52%,
    #eef0f5 68%, #a8acb8 84%, #d8dbe3 100%);
}
/* 高光带：从左上扫到右下
   ★ 主人 2026-10-08：「流光再柔和一些」——
     峰值透明度 .90 → .38，过渡从 ±12% 拉宽到 ±20%，周期 2.4s → 3.4s。 */
.dshqp-flow::after {
  content: ""; position: absolute; inset: -60%;
  background: linear-gradient(115deg,
    transparent 30%,
    rgba(255, 255, 255, .06) 42%,
    rgba(255, 255, 255, .38) 50%,
    rgba(255, 255, 255, .06) 58%,
    transparent 70%);
  animation: dshqp-sweep 3.4s linear infinite;
}
/* ★★ 流光方案（带 data-dshqp-grad）**不再叠这道白光扫过** ——
   主人 2026-10-08 要的是"只做流光"，两层光效叠一起就花了。流星方案照旧保留。 */
.dshqp-flow[data-dshqp-grad]::after { display: none; }
/* 流星画布：铺满整块，叠在金属底色之上、文字之下 */
.dshqp-flow-canvas {
  position: absolute; inset: 0; width: 100%; height: 100%;
  z-index: 1; pointer-events: none;
}
/* 文字：银白金属底 → 深字；黑金属底 → 浅字（用媒体查询切）
   ★ 主人 2026-10-08 指定：文案改「感知世界中」、**加粗**，
     并且**放到流星和流光图层之下**（z-index 从 2 降到 0）——
     canvas 是 z-index:1、高光伪元素排在最后，所以文字会在两者之下。 */
.dshqp-flow-tip {
  position: relative; z-index: 0; font-size: 15px; letter-spacing: .1em;
  font-weight: 700;
  /* ★ 默认 = 深色主题（黑金属底）→ 用**浅色字** */
  color: #e8eaf0; text-shadow: 0 1px 6px rgba(0, 0, 0, .65);
}
/* ★ 浅色主题（银白金属底）→ 用**深色字**，与上面正好相反。
   主题由 data-dshqp-theme 驱动，不再用 prefers-color-scheme。 */
.dshqp-flow[data-dshqp-theme="light"] .dshqp-flow-tip {
  color: #2a2d34;
  text-shadow: 0 1px 2px rgba(255, 255, 255, .55);
}
/* （dshqp-flow-color 关键帧已删 —— 它只被状态点的"迷你流光灯"用，
   那个灯在 2026-10-08 按主人要求改回小黄点了，所以它成了死代码。） */
/* 出图期间把"思考中"的块收起来 —— 主人要求这时候用户要看的是图，不是分析。
   ⚠ 标记用的是**文案匹配**（见 markReasoningBlocks），不是哈希类名：类名随构建变，
   界面上那句「深度求索中」不会。平时不动它，只有 body 带出图标记时才隐藏。 */
body[data-dshqp-drawing] [data-dshqp-reasoning] { display: none !important; }
/* ★ 压缩 composer 卡片内部的多余留白（主人反馈"输入框和下方选项中间空白太大"）。
   经查内核样式，可安全压缩的是纯间距：卡片 padding-top 8px + 卡片内 gap 12px。
   输入框自身的 min-height 只是**下限**，设为 0 不影响它随内容自动增高。
   ⚠ 这是**覆盖内核样式**：DSH 升级后若属性名变了，这几条会**静默失效**
   （不报错、也不会弄坏界面，只是留白回来）。要撤销就把本段整块删掉。
   [data-composer-card] 是内核声明的稳定属性（见 MEMO），不依赖 CSS Modules 哈希类名。
   ⚠ 本段注释里**不许出现反引号**：CARD_CSS 是 JS 模板字符串，反引号会提前把它截断。
   （2026-10-07 同类问题踩过两次：glow.css 那次被 build.mjs 拦住，这次被自测拦住。） */
[data-composer-card] { padding-top: 6px !important; gap: 8px !important; }
[data-composer-card] textarea { min-height: 0 !important; }
/* ★★ 输入区的真实元素是 Lexical 的 contenteditable div（**不是 textarea**），
   所以上面那条 textarea 规则其实打空了 —— 2026-10-07 查源码确认：
   composer 的输入宿主绑定一个 shell 自有的 Lexical 编辑器，根元素带稳定属性
   data-lexical-editor="true"。用它精确命中；外层容器类名是哈希的（随版本变），
   只能用"含有编辑器"这个关系去够，并把上下内边距一起压掉。
   工具行是卡片的最后一个子级，它的上内边距也顺手压到 2px。 */
[data-composer-card] [data-lexical-editor="true"] {
  min-height: 0 !important;
  padding-top: 4px !important;
  padding-bottom: 4px !important;
}
[data-composer-card] *:has(> [data-lexical-editor="true"]) {
  min-height: 0 !important;
  padding-top: 2px !important;
  padding-bottom: 2px !important;
}
[data-composer-card] > *:last-child { padding-top: 4px !important; }
/* ★ 输入区的滚动条：内核默认给它一条细滑块（还专门定制了轨道间距）。
   我把内边距压掉之后内容刚好溢出，那条滑块就冒出来了（主人反馈"右边多出来的滑动条"）。
   这里把它隐藏 —— 滚轮与键盘滚动照常，只是不再画那条滑块。
   定位用 class 含 _scroll：CSS Modules 的名字部分是稳定的，前缀哈希才会随版本变。 */
[data-composer-card] [class*="_scroll"] { scrollbar-width: none; }
[data-composer-card] [class*="_scroll"]::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
  display: none !important;
}
/* ★ 空会话（hero）：内核默认把内容垂直居中（height:100% + justify-content:center），
   所以上下各留一大片。这里改成靠上、顶部留一小段空。
   定位刻意选得**窄**：class 含 _root，且**直接子元素**是 class 含 _stack 的容器、
   该容器里再含 composer 卡片。正常对话的容器不是这个结构（它的 root 下是 header /
   消息区 / composer 并列），所以匹配不到 —— 避免弄坏已经满意的正常布局。
   ⚠ 同样属于覆盖内核样式：类名是哈希的，DSH 升级后可能静默失效（不会弄坏界面）。
   ⚠ 本段注释不许出现反引号（CARD_CSS 是 JS 模板字符串，反引号会截断它）。 */
[class*="_root"]:has(> [class*="_stack"] [data-composer-card]) {
  justify-content: flex-start !important;
  padding-top: min(10vh, 96px) !important;
}
`.trim()

      /** 只走 console.warn，且它自己也不许抛错。 */
      function warn(message) {
        try {
          console.warn(`[qwen-paint] ${message}`)
        } catch (err) {
          /* 连 console 都没有就彻底安静 */
        }
      }

      /** 把结果块里的文本拼起来（失败时用来显示原因）。 */
      function textOf(block) {
        const parts = []
        const content = block && block.content
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
          }
        }
        return parts.join('\n').trim()
      }

      /**
       * 取图片绝对路径：优先用 host 侧 presentationMeta 落下的 `meta.path`
       * （最可靠，不依赖文案），退而解析结果文本里的「已出图：<path>」。
       *
       * ★ 2026-10-08：DSH 各版本把这个元信息放的位置不完全一样，
       *   所以 `block.meta` / `block.presentationMeta` **都认** ✓
       */
      function imagePathOf(block) {
        const meta = block && (block.meta ?? block.presentationMeta)
        if (meta && typeof meta.path === 'string' && meta.path.trim() !== '') return meta.path.trim()
        const text = textOf(block)
        const match = /已出图[：:]\s*([^\n（(]+)/u.exec(text)
        return match ? match[1].trim() : null
      }

      /** 诊断用：这个结果块到底有哪些字段（版本差异时一眼看出对不上在哪）。 */
      function keysOfBlock(block) {
        try {
          const own = Object.keys(block).join(', ')
          const meta = block && (block.meta ?? block.presentationMeta)
          const metaKeys = meta ? Object.keys(meta).join(', ') : '(没有 meta)'
          return `字段=[${own}]  meta=[${metaKeys}]`
        } catch (error) {
          return '(取不到字段)'
        }
      }

      /** ★ 渲染兜底：卡片里任何异常都不许冒出去 —— 冒出去会崩掉 dsh 的那块界面。 */
      function DrawImageCard(props) {
        try {
          return renderCard(props)
        } catch (error) {
          return React.createElement(
            'div',
            { className: 'dshqp-error' },
            `绘图卡片渲染出错：${error && error.message ? error.message : String(error)}`,
          )
        }
      }

      /** 画图卡片：有结果就渲染图，出错显示原文，运行中显示提示。 */
      function renderCard(props) {
        const phase = props && props.phase
        const block = props && props.block

        // ★ 不把 `phase` 当唯一开关：自带 toolview（如 WebRow）压根不看 phase，
        //   只吃 `block`。所以这里只要拿到 block 且能解析出图片路径就直接渲染图，
        //   万一 phase 的取值/传递方式与预期不同，图也不会被"正在画图"遮住。
        if (block !== undefined && block !== null) {
          if (block.isError) {
            const detail = textOf(block) || '未知错误'
            // ★★★ 2026-10-08 二十三次修正：**失败路径也必须收工**。
            //   主人要求「生图时才隐藏思考和调用工具过程，正常工程和对话不隐藏」。
            //   而原来 `flowFinish()` 只在"拿到图片路径"那条分支里被调用 ——
            //   一旦出图**失败 / 超时 / 被中断**，它就跑不到，
            //   `body[data-dshqp-drawing]` 标记会**一直留在 body 上**，
            //   于是"出图期间隐藏思考块"那条 CSS **永久生效** ——
            //   表现出来就是"平时也把思考隐藏了"。
            if (phase === 'result') flowFinish()
            return React.createElement('div', { className: 'dshqp-error' }, `画图失败：${detail}`)
          }
          const filePath = imagePathOf(block)
          if (filePath !== null) {
            // ★★★ 2026-10-08 十四次修正：**只在真正拿到结果时才收动画**。
            //   事故：新会话里动画"一闪而过"随即消失 —— 因为 preparing 阶段的
            //   工具参数里**可能已经带着目标路径**，imagePathOf 提前返回了非空值，
            //   flowFinish() 就被立刻调用，动画刚出来就被收掉了。
            //   ✓ 判据改为：phase 明确等于 result 才收；其余阶段（preparing/start）
            //     一律视作"还在生成"，动画继续留着。
            if (phase === 'result') flowFinish()
            const name = filePath.split(/[\\/]/u).pop() || filePath
            return React.createElement(
              'div',
              { className: 'dshqp-card' },
              React.createElement('img', {
                className: 'dshqp-img',
                // 相对 baseURI 解析 → 桌面端 dsh-app://app/api/file?...，Web 端 http://…/api/file?...
                src: `api/file?path=${encodeURIComponent(filePath)}`,
                alt: name,
                loading: 'lazy',
              }),
              React.createElement('div', { className: 'dshqp-name' }, name),
            )
          }
          // 有 block 但没解析出图片路径。
          // ★★ 2026-10-08：这里原来**静默**（只显示文本、或者干脆什么都不显示）——
          //   于是"出图了但看不到图"完全无从查起，只能靠猜 ✗
          //   ✓ 现在把**诊断信息直接摆进消息里**：
          //     · 结果块有哪些字段（`keysOfBlock`）
          //     · 结果文本是什么
          //   用户截个图，作者就能看出是哪一环对不上 —— 多半是 DSH 版本差异。
          const fallback = textOf(block)
          if (phase === 'result') {
            return React.createElement(
              'div',
              { className: 'dshqp-pending' },
              '⚠ 出图流程走完了，但没能从返回结果里取出图片路径。',
              React.createElement('br'),
              `诊断：${keysOfBlock(block)}`,
              React.createElement('br'),
              `结果文本：${fallback === '' ? '(空)' : fallback}`,
            )
          }
          if (fallback !== '') {
            return React.createElement('div', { className: 'dshqp-pending' }, fallback)
          }
        }

        // preparing / start：出图要一两分钟，这段时间必须让用户看见「在动」
        // ★ 同时在**聊天流里**放一个 16:9 的大呼吸灯（主人指定：位置就像我发图片出来那样）
        flowStart()
        // ★ 生成中的 RGB 呼吸灯（主人指定）：正方形色块呼吸 + 白色流光从左上扫到右下 + 小字
        return React.createElement(
          'div',
          { className: 'dshqp-loading' },
          React.createElement('div', { className: 'dshqp-lamp' }),
          React.createElement('div', { className: 'dshqp-loading-text' }, '正在生成图片'),
        )
      }

      /* ------------------------------------------- composer 下方的在线状态 ---- */

      /** 记住第一条能用的状态端点，之后不再每条都试。 */
      let statusPath = null

      /** 取 host 的 ComfyUI 状态。失败返回 null（显示"未知"而不是崩）。 */
      async function fetchStatus() {
        const candidates = statusPath === null ? STATUS_PATHS : [statusPath]
        for (const candidate of candidates) {
          try {
            const response = await fetch(candidate, { headers: { accept: 'application/json' } })
            if (!response.ok) continue
            const data = await response.json()
            statusPath = candidate
            return data
          } catch (error) {
            /* 换下一条候选路径 */
          }
        }
        return null
      }

      /** 把 host 的状态翻译成圆点状态 + 一句话。
       *  ★ 2026-10-07 缩短文案：原来「ComfyUI 在线 · 空闲 2 分后自动关闭」约 22 字、200px 宽，
       *    会把同排的推理流光条挤到下一排（主人反馈）。现在压到 9 字以内。 */
      function describeStatus(data) {
        // ★ 2026-10-08：文案再压一轮（主人反馈"又被挤到第二排去了"）。
        //   实测：`ComfyUI · 出图中` 12 字仍会在窄窗口里把流光条挤下去，
        //   所以去掉分隔符、再砍掉冗余字，压到 9~11 字。
        if (data === null || typeof data !== 'object') {
          return { state: 'off', label: 'ComfyUI 未知' }
        }
        if (data.online !== true) {
          return { state: 'off', label: 'ComfyUI 未启动' }
        }
        if (data.busy === true) {
          return { state: 'busy', label: 'ComfyUI 出图中' }
        }
        const left = typeof data.idleShutdownInMs === 'number' ? data.idleShutdownInMs : 0
        if (left > 0) {
          return { state: 'on', label: `ComfyUI 空闲${Math.max(1, Math.ceil(left / 60000))}分` }
        }
        // idleShutdownMs <= 0 = 选了"不自动关闭"，这时只显示在线
        return { state: 'on', label: 'ComfyUI 在线' }
      }

      /**
       * 把状态指示器挂进座位。**纯 DOM** —— 与 dsh-reasoning-glow 同一套路：
       * React 只负责渲染座位，内容与轮询都在这里，不依赖 React 的重渲染。
       * @returns 清理函数（卸载时停轮询、清空座位）
       */
      function mountStatus(seat) {
        const dot = document.createElement('span')
        dot.className = 'dshqp-dot'
        const label = document.createElement('span')
        label.textContent = 'ComfyUI 检测中…'
        seat.appendChild(dot)
        seat.appendChild(label)

        let stopped = false
        let timer = null

        // ★★ 主人 2026-10-08：「画图时 ComfyUI 生图中旁边不是一个小黄点，而你发布页说的小黄点，
        //   把插件改成小黄点」。
        //   原来出图时会把圆点换成"迷你流光灯"（18px 彩色呼吸块），和 README 里写的
        //   「🟡 黄 = 正在出图」对不上 —— 现在**就是那个黄点**：
        //   圆点始终 8px，出图时 data-state="busy" 走上面的黄底 + 光晕规则，不再换类。
        const paint = (view) => {
          if (stopped) return
          dot.setAttribute('data-state', view.state)
          label.textContent = view.label
          seat.setAttribute('title', view.label)
        }

        // ★★ 2026-10-07 新增：点状态点弹出「多久没出图就自动关掉后端」的选项。
        //   调 host 的 `?idleMinutes=N`（N = 0 表示不自动关闭），选完立刻重新拉一次状态。
        const IDLE_CHOICES = [
          { minutes: 0, text: '不自动关闭' },
          { minutes: 1, text: '1 分钟后关闭' },
          { minutes: 5, text: '5 分钟后关闭（默认）' },
          { minutes: 10, text: '10 分钟后关闭' },
          { minutes: 30, text: '30 分钟后关闭' },
        ]
        let menu = null

        /* ★ 2026-10-08：当前生效的档位（分钟）。菜单里的高亮就是拿它比对出来的。
           null = 还没拉到状态，这时菜单先不点亮，等轮询回来由 syncMenuHighlight 补上。 */
        let idleNow = null

        /* ★ 2026-10-08 主人要求：配置菜单打开后，点界面任意空白处就消失。
           为什么用**捕获阶段**：打开菜单的那一次点击同样会走到 document，
           冒泡阶段的监听会"刚打开就被自己关掉"；捕获阶段跑在 seat 的 toggleMenu 之前，
           那一刻 menu 还是 null，天然不会误关。
           为什么整个 seat 区域都放行：点状态点本身要能"再点一次收起"，
           这件事交给 toggleMenu 自己管，否则会出现"关掉又立刻打开"。 */
        const onDocClick = (event) => {
          if (menu === null) return
          const target = event.target
          // 座位区域放行（"点状态点自己 = 再点一次收起"交给 toggleMenu 管，否则会关了又立刻打开）
          if (target && seat.contains && seat.contains(target)) return
          // ★ 菜单现在挂在 body 上、**不再是座位的子元素**，所以要单独放行 ——
          //   不然点菜单项会被当成"点外面"：捕获阶段先把菜单关掉，手感就是"点一下没反应"。
          if (target && menu.contains && menu.contains(target)) return
          closeMenu()
        }
        const closeMenu = () => {
          if (menu === null) return
          try { menu.remove() } catch (error) { /* 已被移除 */ }
          menu = null
          // 菜单没了就把"点空白处消失"的监听摘掉 —— 它只在菜单活着的时候挂着。
          document.removeEventListener('click', onDocClick, true)
        }

        /** 按当前选择刷新勾选高亮（菜单没开就什么都不做）。
         *  两组各按自己的"当前值"比对：自动关闭比分钟数，生图动画比 id。 */
        const syncMenuHighlight = () => {
          if (menu === null) return
          for (const item of menu.children) {
            const kind = typeof item.getAttribute === 'function' ? item.getAttribute('data-kind') : null
            if (kind === null) continue // 分组标题没有 data-kind
            const value = item.getAttribute('data-value')
            const on = kind === 'idle' ? Number(value) === idleNow : value === flowStyleNow
            if (on) item.setAttribute('data-current', '1')
            else item.removeAttribute('data-current')
          }
        }

        const pickIdle = (minutes) => {
          const base = statusPath === null ? STATUS_PATHS[0] : statusPath
          fetch(`${base}?idleMinutes=${minutes}`, { headers: { accept: 'application/json' } })
            // ★ 只在这时才认下新档位：请求失败就保持原值，不让高亮说谎。
            .then(() => { if (!stopped) { idleNow = minutes; poll() } })
            .catch(() => { /* 失败就保持原样，下次轮询会纠正显示 */ })
        }

        /** 点「生图动画」里的一项：写进 host（host 会落盘，重启后记得住），
         *  同样只在请求成功后才认新值，并立刻重画菜单高亮。 */
        const pickFlow = (id) => {
          const base = statusPath === null ? STATUS_PATHS[0] : statusPath
          fetch(`${base}?flowStyle=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
            .then(() => { if (!stopped) { flowStyleNow = id; poll() } })
            .catch(() => { /* 失败就保持原样，下次轮询会纠正显示 */ })
        }

        /** 往菜单里添一组：一个标题 + 若干条目。
         *  sub = true 时是**子标题**（更小更淡、不带上面的分隔线，用在「流光 · 抄自月匠」）。 */
        const addGroup = (title, entries, sub) => {
          const head = document.createElement('div')
          head.className = sub === true ? 'dshqp-menu-head dshqp-menu-sub' : 'dshqp-menu-head'
          head.textContent = title
          menu.appendChild(head)
          for (const entry of entries) {
            const item = document.createElement('button')
            item.type = 'button'
            item.className = 'dshqp-menu-item'
            item.setAttribute('data-kind', entry.kind)
            item.setAttribute('data-value', String(entry.value))
            // 流光给一个预览小色块：不用真去生一张图，就能看出自己选的是什么颜色
            if (entry.swatch !== undefined) {
              const dot = document.createElement('span')
              dot.className = `dshqp-menu-swatch dshqp-menu-swatch-${entry.swatch}`
              item.appendChild(dot)
            }
            // 名字前面的小圆点（主人要求：给"流星"标一个点，表示它是自制的那个）
            if (entry.bullet === true) {
              const mark = document.createElement('span')
              mark.className = 'dshqp-menu-bullet'
              item.appendChild(mark)
            }
            const label = document.createElement('span')
            label.textContent = entry.text
            item.appendChild(label)
            // 名字后面的来源小标签（自制 / …）
            if (entry.tag !== undefined) {
              const tag = document.createElement('span')
              tag.className = 'dshqp-menu-tag'
              tag.textContent = entry.tag
              item.appendChild(tag)
            }
            item.addEventListener('click', (event) => {
              event.stopPropagation()
              closeMenu()
              if (entry.kind === 'idle') pickIdle(entry.value)
              else pickFlow(entry.value)
            })
            menu.appendChild(item)
          }
        }

        /**
         * ★★★ 给菜单算位置与高度（每次打开都算一遍）。
         *
         * 主人 2026-10-08 两次反馈的最终定案：
         *   第一次「新会话里被上面的 UI 挡住」→ 我先改成"翻方向 + 限高"，**没用**。
         *   原因：菜单原本是**座位的子元素 + absolute**，会被 composer 那一串祖先的
         *   `overflow` **裁掉** —— 裁在祖先层，翻方向、限高、滚动**统统救不了**
         *   （裁的是元素的可见区域，不是它自己的滚动内容）。
         *   ✓ 所以现在菜单**挂在 body 上 + fixed 定位**，跟祖先裁剪彻底无关，
         *     坐标和高度全部在这里现算。
         *
         * 规则：
         *   · 上面塞不下、**或** composer 落在屏幕上半区（新会话的 hero 布局）→ 往下弹
         *   · 高度取那一侧的实际空间（上限 400、保底 140），溢出的部分靠菜单内部滚动
         *   · 水平方向和座位右边缘对齐，但不许出界
         *   · 量不到尺寸就保持默认（top/left 都是 0 会被 CSS 兜住）—— 能打开比位置完美重要
         */
        const placeMenu = () => {
          try {
            if (typeof seat.getBoundingClientRect !== 'function') return
            const rect = seat.getBoundingClientRect()
            const viewport = Number(window.innerHeight) || 0
            const viewportW = Number(window.innerWidth) || 0
            if (viewport <= 0) return
            const GAP = 8
            const LIMIT = 400
            menu.style.maxHeight = `${LIMIT}px`
            // scrollHeight 是**内容总高**，不受 max-height 影响 —— 正好用来判断"需要多高"
            const need = Math.min(Number(menu.scrollHeight) || 0, LIMIT)
            const above = rect.top - GAP
            const below = viewport - rect.bottom - GAP
            const wantDown = above < need || rect.top < viewport * 0.45
            const down = wantDown && below > 140
            const room = down ? below : above
            const height = Math.max(140, Math.min(LIMIT, room))
            menu.style.maxHeight = `${height}px`
            const box = typeof menu.getBoundingClientRect === 'function' ? menu.getBoundingClientRect() : null
            const shown = Math.min(box && box.height ? box.height : height, height)
            const width = box && box.width ? box.width : 0
            menu.style.top = down
              ? `${Math.min(Math.max(GAP, viewport - GAP - height), rect.bottom + 6)}px`
              : `${Math.max(GAP, rect.top - shown - 6)}px`
            // 右对齐座位右边缘，同时不许越出视口
            const rightAligned = rect.right - width
            const maxLeft = viewportW > 0 ? viewportW - width - GAP : rightAligned
            menu.style.left = `${Math.max(GAP, Math.min(rightAligned, maxLeft))}px`
          } catch (error) {
            /* 量不到就不动它 —— 菜单能用比"位置完美"重要得多 */
          }
        }

        const toggleMenu = () => {
          if (menu !== null) { closeMenu(); return }
          menu = document.createElement('div')
          menu.className = 'dshqp-menu'
          addGroup('自动关闭', IDLE_CHOICES.map((choice) => (
            { kind: 'idle', value: choice.minutes, text: choice.text }
          )))
          // ★ 主人 2026-10-08：「把现在的三个字去掉，在流星前加个点，后面写上自制，
          //   下面的流光统一做一个大标题，标注抄自月匠」。
          //   所以：流星 = 前面一个点 + 后面「自制」标签；15 种流光收进一个子标题下。
          addGroup('生图动画', [
            { kind: 'flow', value: 'meteor', text: '流星', bullet: true, tag: '自制' },
          ])
          // ⚠ 有了这个大标题，条目名就**不再重复带「流光·」前缀**（原来是每项都带）。
          addGroup('流光 · 抄自月匠', FLOW_GRADS.map((grad) => (
            { kind: 'flow', value: grad.id, text: grad.name, swatch: grad.id }
          )), true)
          // ★★ 挂到 **body**（不是座位）—— 摆脱 composer 祖先的 overflow 裁剪。
          //   踩过：挂在座位里时，新会话的菜单会被祖先裁掉头，翻方向/限高都救不了。
          const host = document.body ?? document.documentElement
          host.appendChild(menu)
          // 必须**挂进 DOM 之后**才量得到尺寸（见 placeMenu 的说明）
          placeMenu()
          syncMenuHighlight()
          document.addEventListener('click', onDocClick, true)
        }
        seat.setAttribute('data-clickable', '1')
        // ⚠ 防御：自测用的假座位对象可能没有 addEventListener（真实 DOM 一定有）。
        //   不加这层判断会在这里抛错，把后面的 paint/poll 全带断 —— 自测抓到过一次。
        if (typeof seat.addEventListener === 'function') seat.addEventListener('click', toggleMenu)

        const poll = () => {
          fetchStatus()
            .then((data) => {
              if (stopped) return
              paint(describeStatus(data))
              // ★ 记住当前档位供菜单高亮用 —— host 的 snapshot 里本来就带 idleShutdownMs。
              //   注意它是"设定的档位"，不是 idleShutdownInMs 那个"还剩多久"。
              if (data && typeof data.idleShutdownMs === 'number') {
                idleNow = Math.round(data.idleShutdownMs / 60000)
                syncMenuHighlight()
              }
              // ★ 生图动画同理：记住当前选择 —— 菜单高亮和 makeFlowNode 都用它。
              //   只认白名单值，别的一律当没看见（默认照旧走流星）。
              if (data && typeof data.flowStyle === 'string') {
                if (data.flowStyle === 'meteor' || FLOW_IDS.includes(data.flowStyle)) {
                  flowStyleNow = data.flowStyle
                  syncMenuHighlight()
                }
              }
            })
            .catch(() => { if (!stopped) paint({ state: 'off', label: 'ComfyUI 状态未知' }) })
        }

        paint({ state: 'off', label: 'ComfyUI 检测中…' })
        poll()
        timer = setInterval(poll, POLL_MS)

        return () => {
          stopped = true
          if (timer !== null) clearInterval(timer)
          // ★ 卸载时顺手收掉菜单 —— 同时把挂在 document 上的"点空白处消失"监听摘掉，
          //   否则它会一直留在页面上（座位已经没了，菜单却还挂着监听）。
          closeMenu()
          try { seat.textContent = '' } catch (error) { /* 座位已被移除 */ }
        }
      }

      /** React 座位：只在 useEffect 里挂纯 DOM，绝不把异常抛进 dsh 的渲染树。 */
      function ComfyStatusSeat() {
        const hostRef = React.useRef(null)
        React.useEffect(() => {
          const seat = hostRef.current
          if (!seat) return undefined
          try {
            return mountStatus(seat)
          } catch (error) {
            warn(`状态指示器挂载失败：${error && error.message ? error.message : error}`)
            return undefined
          }
        }, [])
        return React.createElement('span', { className: 'dshqp-seat', ref: hostRef })
      }

      /**
       * 极轻量的「加载自报」：往 host 的状态端点打一发带理由的请求。
       * ★ 为什么需要它：`apply` 里那几处 `return` 是**安静失败**——不报错、不记日志，
       *   从外面看和"客户端代码根本没加载"完全一样。把理由写进查询串，
       *   host 端记下来，就能精确区分到底是哪一环断的。
       * 失败一律吞掉，绝不影响插件本身。
       */
      function pingHost(reason) {
        try {
          fetch(`api/qwen-paint/status.json?ping=${encodeURIComponent(reason)}`, { cache: 'no-store' }).catch(() => {})
        } catch (error) {
          /* 自报失败无所谓 */
        }
      }

      function apply(ctx) {
        // ★ 必须用 `!React` 而不是 `React === null`：require('react') 返回 undefined
        //（不抛错）时 React 会是 undefined，`=== null` 拦不住，槽照注册，
        // 组件一渲染就 TypeError 污染 dsh 自己的渲染树（MEMO 里记过这个坑）。
        pingHost('apply')
        if (!React || typeof React.createElement !== 'function') {
          pingHost('no-react')
          return
        }
        if (ctx === undefined || ctx.slots === undefined) {
          pingHost('no-slots')
          return
        }

        // ★★★ 2026-10-08 十九次修正：**这里不再启动思考块观察器**。
        //   它原来是常驻的（从 DSH 启动起就 observe 整棵聊天树），流式输出时
        //   每秒被唤醒几十上百次，叠加录屏就把渲染主线程拖垮（主人「整个界面卡住」）。
        //   ✓ 现在改成：**flowStart 时挂上、flowFinish 时摘下**（见那两个函数）。
        //     平时界面处于"零常驻监听"状态，不可能因为插件而卡。

        // 样式挂在 apply 的 effect 里，卸载时自动摘掉（不往 body 写 DOM）
        try {
          ctx.effect(() => {
            const el = document.createElement('style')
            el.id = STYLE_ID
            el.textContent = CARD_CSS
            document.head.appendChild(el)
            return () => {
              try { el.remove() } catch (err) { /* 卸载时文件已被移除也无所谓 */ }
            }
          }, 'qwen-paint:style')
        } catch (err) {
          /* 样式失败不影响卡片本身 */
        }

        // ★ 流光动画的样式表：**单独一个 style 节点**，内容由 FLOW_GRADS 生成
        //   （单一数据源 —— 不手写第二份 CSS，也就不会再踩 CARD_CSS 那种反引号 / 转义坑）。
        //   即使这一段失败，也只是"流光没有颜色"，不影响出图，也不影响流星动画。
        try {
          ctx.effect(() => {
            const el = document.createElement('style')
            el.id = GRAD_STYLE_ID
            el.textContent = flowGradCss()
            document.head.appendChild(el)
            return () => {
              try { el.remove() } catch (err) { /* 卸载时文件已被移除也无所谓 */ }
            }
          }, 'qwen-paint:grad-style')
        } catch (err) {
          /* 样式失败不影响卡片本身 */
        }

        // 只注册 key=toolName 这一个格子；key 未占用 → 不遮蔽任何自带 UI。
        // ★ 整段包 try/catch：槽不存在 / 注册冲突 / 版本差异都**不许**把 dsh 的启动拖垮
        //   （MEMO 记过：自写客户端插件挂槽把界面搞崩过）。失败只 warn，绝不外抛。
        try {
          ctx.slots.inject(SLOT_KEY, () =>
            ctx.slots.register({ name: SLOT_KEY, key: TOOL_KEY }, DrawImageCard),
          )
        } catch (error) {
          warn(`注册 ${SLOT_KEY}[${TOOL_KEY}] 失败，图片卡片不会出现（不影响 dsh 其它功能）：${error && error.message ? error.message : error}`)
        }

        // ComfyUI 在线状态点：挂在 composer **工具行右侧**（发送按钮前面），
        // 避免和左侧控件之间出现大片空白。单个 list 槽，用自定义 id，不抢自带位置。
        try {
          if (typeof React.useRef === 'function' && typeof React.useEffect === 'function') {
            ctx.slots.inject(STATUS_SLOT, () =>
              ctx.slots.register({ name: STATUS_SLOT, id: STATUS_ID, order: 40 }, ComfyStatusSeat),
            )
          } else {
            warn('React 种子缺 useRef/useEffect，跳过 ComfyUI 状态指示器')
          }
        } catch (error) {
          warn(`注册状态指示器失败，状态点不会出现（不影响 dsh 其它功能）：${error && error.message ? error.message : error}`)
        }

        // 走到这里说明两条槽都尝试注册过了 —— 自报一次，便于和上面那些提前 return 区分
        pingHost('registered')
      }

      // ★★ 必须声明 inject：客户端插件的 apply 只在依赖服务就绪后才被调用
      //（照 dsh-reasoning-glow 的写法 `exports.inject = ["slots"]`）。
      // 漏了这句的话 apply 可能在 slots 就绪前就跑，ctx.slots 还是 undefined，
      // apply 里那句守卫会**安静 return** —— 症状是"重启后图永远不显示"，而且不报错。
      exports.inject = ['slots']
      exports.name = PLUGIN_ID
      exports.apply = apply
      return module.exports
    },
  })
}
