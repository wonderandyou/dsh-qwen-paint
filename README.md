# dsh-qwen-paint　(绘图)千问

让 **DeepSeek Harness** 在对话里直接调用**本机 ComfyUI**、用**千问 Qwen-Image 2.1** 画图。
在聊天框说一句「画一只在雪地里的柴犬」，图就出来了 —— 全程 **127.0.0.1，不出网、不花钱、不需要任何 API Key**。

> **作者：@奇迹与你**　｜　MIT 许可　｜　仓库：<https://github.com/wonderandyou/dsh-qwen-paint>

---

## 它是什么

一个 **DSH 插件（host + client 两半）**，注册一个工具：

| 工具 | 作用 |
|---|---|
| `draw_image` | 按提示词调本机 ComfyUI 出图，成品落盘到「千问1生图」，并把绝对路径回给助手用于内联显示 |

- **host 半边**（`lib/index.js`）：注册工具、**空闲 5 分钟自动关停 ComfyUI**、挂**只读状态端点**。
- **client 半边**（`lib/client.js`）：给 `draw_image` 一张**自绘卡片**（图直接显示在工具行里）、
  在 **composer 下方**显示 ComfyUI 在线状态。

不改 DSH 安装目录、不改内核文件。

## 依赖

- **ComfyUI** 跑在 `127.0.0.1:8188`（本机：双击 `D:\ComfyUI\启动ComfyUI.bat`）
- 三个千问模型文件（共约 13.3 GB）：
  - `qwen_image_2.1_int8_convrot.safetensors`（UNET，放 `models\diffusion_models\`）
  - `qwen3vl_8b_w4a8.safetensors`（CLIP、`type=qwen_image`，放 `models\text_encoders\`）
  - `qwen_image_2.1_vae_bf16.safetensors`（VAE，放 `models\vae\`）
- **不需要**任何 Python 环境、不装任何第三方包 —— 插件本体是纯 Node ESM，**零外部依赖**。

## 安装

### 一键部署（推荐）：连 ComfyUI 和模型一起搞定

```powershell
node scripts/setup.mjs                 # 检测 + 缺什么补什么
node scripts/setup.mjs --check         # 只看差什么，绝不动任何东西
node scripts/setup.mjs --verify        # 已存在的模型也重算 SHA256（最稳）
node scripts/setup.mjs --comfy D:\ComfyUI     # 指定 ComfyUI 目录
```

它会：① 自动找 ComfyUI；② 把三个模型下到正确目录并**逐个 SHA256 校验**（校验不过的一律删除）；
③ 调 `install.mjs` 把插件挂进 DSH profile。

**下载渠道**：模型走 **ModelScope 官方直连**（阿里官方平台），上传者是
[Comfy Org 官方组织自己的仓库](https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1)，
期望哈希取自该仓库文件列表 API 的 `sha256`。
ComfyUI 本体在 GitHub 官方 release，**官方不公布哈希**，所以脚本**默认不自动下它**，
要下得显式加 `--download-comfy`（它会再问一次）。

断点续传：中途断了**直接重跑**，`curl -C -` 会接着下。

### 显卡：N 卡开箱即用，A 卡走 ROCm（0.1.1 新增）

脚本**先看显卡再决定怎么装**：N 卡用 ComfyUI 官方便携包；**AMD Radeon 走 ROCm 路线**
（AMD 官方 Windows wheels，装完还是 ComfyUI，**插件本身不用换**，模型也是同一套）；
Intel 核显基本跑不动。

AMD 用户先 `node scripts/setup.mjs --check` 看计划，确认后 `--yes` 执行。
⚠ 三条必读：**A 卡可能静默出错**（跑完必须人眼看图）、**别升 ROCm 10.0**
（HIP 7.15 会破坏权重，脚本锁 7.2.1）、模型**禁止商用**。

完整说明见 [INSTALL.md](INSTALL.md) 的「AMD Radeon 用户」一节。

### 只装插件本体

```powershell
node scripts/install.mjs              # 装进 desktop profile（默认）
node scripts/install.mjs --profile web
node scripts/install.mjs --uninstall
node scripts/install.mjs --dry-run
```

脚本做的事（幂等、改前备份、验证不过自动回滚）：

1. **先 import 一次插件入口**，ESM 语法错或依赖解析失败会当场暴露；
2. 备份 profile 的 `package.json` 到 `profiles\<profile>\_backup-dsh-qwen-paint-<时间戳>\`；
3. 写 `dependencies["dsh-qwen-paint"] = "link:<本目录>"`；
4. 把 `dsh-qwen-paint` 加进 `dsh.profile.bundles`；
5. 建 Junction `profiles\<profile>\node_modules\dsh-qwen-paint → 本目录`；
6. 复核三处都落了，没落就回滚。

> **官方首选路径**是 DSH 自己的 Plugin Manager（`plugin_manager` 的 `install_bundle`，target = 本包绝对目录），
> 或等价 CLI `dsh plugin --profile desktop add link:<本目录>`（**desktop profile 必须先完全退出 DSH**）。
> 本脚本是兜底路径，做的是等价的两件事。

**装完必须彻底退出 DSH 再重新打开** —— 宿主侧工具清单只在启动时装配一次。
（DSH 是桌面端 Electron 应用，**没有刷新页面这回事**。）

## 用法

装好并重启后，在聊天框直接说：

```
画一只在雪地里的柴犬，逆光，胶片颗粒，电影感
给我画一张 16:9 的赛博朋克雨夜街景，霓虹反射在积水上
用同样的种子再画一遍刚才那张
```

助手会调 `draw_image`。可传的参数：

| 参数 | 说明 |
|---|---|
| `prompt` | **必填**，画面描述（中文可以）。建议写完整一段：主体 + 细节 + 环境 + 光线 + 风格 |
| `size` | 画幅比例：`1:1`（默认）、`3:4`、`4:3`、`2:3`、`3:2`、`16:9`、`9:16` |
| `megapixels` | 总像素（百万），默认 `1.0`。要更清楚就调大 |
| `steps` | 采样步数，默认 `25`，范围 1–60 |
| `seed` | 随机种子。同提示词 + 同种子 = 同一张图；不填则每次不同 |
| `negative` | 负面提示词。⚠ 千问模型 `cfg=1`，**负面词基本不生效**，一般别填 |

尺寸按 **32 的倍数**对齐（`r32(v)=max(32, round(v/32)*32)`），与 `app.py` 的算法一致：
`1:1@1MP → 992×992`；`16:9@1MP → 1344×736`；`2:3@1MP → 832×1216`。

## 出图落在哪

`C:\Users\<你的用户名>\Desktop\千问1生图\`（遵循工作区约定；也在会话工作区「桌面」之内，
所以交付卡片和行内图片都能取到这个文件）。

命名：`<提示词前若干字>_Qwen2.1_<宽>x<高>_<序号>.png`，重名自动加 `-2`、`-3`。

## 图片是怎么显示在聊天框里的（原理，改之前务必看）

这一节是 2026-10-07 逐个查内核源码核过的，**不要凭直觉改**：

| 路径 | 能用吗 | 原因（都有内核源码依据） |
|---|---|---|
| `ImageBlock`（工具结果里返 `{type:"image", attachment}`） | ✗ | 客户端 `imageCardModel()` 开头就是 `if (call?.name !== "read_image") return null` —— **只认 `read_image`**；其他工具的 image block 会被 generic 卡片用 `JSON.stringify` 当文本打印出来 |
| `presentCall` / `presentResult` | ✗ | ui-tool README 原文："Host `presentCall` and `presentResult` values **never enter the Client**." |
| `presentationMeta` 让图显示 | ✗ | 它确实会落到 `tool/result` 的 `data.meta`，但客户端**只有** `read_image` 那张卡片读它、且只当路径标签用 |
| `present` 的交付卡片显示图 | ✗ | `dsh-client-ui-deliverables` 客户端全文**没有任何 `<img>` / `loadImage`**；交付卡片只给「用默认程序打开」的入口 |
| 助手消息直接带图片 | ✗ | 附件子系统文档明说："当前生产适配器声明只输出文本，因此只有用户内容携带图片" |
| **① 正文 Markdown 图片 `![](<绝对路径>)`** | ✓ | 官方设计：客户端 `fileMediaUrl()` 把本地绝对路径重写成 `<base>/api/file?path=…`，打到内核已认证的 `/api/file` 路由取字节，渲染成真 `<img>`。内核自带的 `FILE_REFERENCE_PROMPT` 就是这么教模型的 |
| **② 客户端自定义 toolview** | ✓ **100% 确定** | `tool.call.toolview` 是 keyed 槽，文档原文"**Any name is allowed, including tools registered by your package**"；`draw_image` 这个 key 未被占用，注册它不遮蔽任何自带 UI |

**本插件两条都做，互不依赖**：

- **①** host 侧用 `ctx.systemPrompt.section({ name: 'qwen-paint:inline-generated-image', order: 9100, text: … })`
  下一条指令，要求模型出图后在正文里内联展示（与内核 `DELIVERABLE_FILE_REFERENCES` 同一机制）。
- **②** `lib/client.js` 注册 `tool.call.toolview` 的 `draw_image` 格子：运行中显示「正在用本机千问画图…」，
  完成后自己 `<img src="api/file?path=…">` 渲染，失败时显示错误原文。

另外 host 侧仍会 append `deliverables/presented`（与官方 `present` 同一载荷）——
这不是为了显示图，而是**顺带给一个可点开/用默认程序打开的正式交付入口**，且它能让记录可回放。


## 空闲自动关停（省显存）

要求："不要让 comfyUI 一直跑着，只要五分钟不生图 comfyUI 后端自动关闭。"

- **计时只在插件出过图之后才开始**（`lastActivityAt` 初始为 `null`）。
  → 所以**绝不会误关你自己打开的、正在「小鲸鱼生图」里用的 ComfyUI**。
- 到点后还要过两关才动手：**ComfyUI 仍在线**，且 **`/queue` 为空**（有任务在跑就续期，绝不打断）。
- **只杀"监听该端口 且 命令行确实含 `comfy` 与 `main.py`"的进程**；认不出来就跳过并记日志——
  **绝不按端口盲杀**。
- 关掉后计时复位；下次出图需要重新启动 ComfyUI（`draw_image` 会明确提示怎么启动）。

配置：`idleShutdownMs`（默认 `300000` = 5 分钟）、`autoShutdown`（默认 `true`，设 `false` 就永不自动关）。

## ComfyUI 在线状态提示（composer 下方）

在 **composer 卡片下方**（`conversation.composer.dock` 槽）显示一个小指示器：

| 圆点 | 含义 |
|---|---|
| 🟢 绿 | ComfyUI 在线；若正在空闲倒计时，会写「空闲 N 分后自动关闭」 |
| 🟡 黄 | ComfyUI 正在出图（`/queue` 非空） |
| ⚪ 灰 | ComfyUI 未启动 / 状态未知 |

它每 5 秒读一次 host 的**只读**端点 `GET /api/qwen-paint/status.json`
（回退 `/qwen-paint/status.json`）。该端点：

- **只放行本机请求**（Host 与远端地址都必须是回环），其余一律 403；
- **只回事实**（`online` / `busy` / `idleShutdownInMs` / `url`），**不含任何本地路径或密钥**；
- 任何意外都回 200 + 可读原因，前端显示"未知"而不是报错。

该槽是 list 槽、`replaceRisk: none`，插件用自己的 id（`qwen-paint-status`）注册，
**与自带的 `stats` pill 并存，不替换任何自带 UI**。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 说"画个图"，助手说没有这个工具 | 插件没生效 → 确认 profile 的 `dsh.profile.bundles` 里有 `dsh-qwen-paint`，然后**彻底退出 DSH 重开** |
| 报"连不上本机 ComfyUI" | ComfyUI 没启动。双击 `D:\ComfyUI\启动ComfyUI.bat` 或先开「小鲸鱼生图」（它会自动拉起引擎），等它起来再画 |
| 报"等 ComfyUI 出图超时" | 首次出图要加载 7.26 GB UNET + 6.31 GB 文本编码器，**第一次特别慢**；本机实测 25 步 1MP 约 62–124 秒，首次更久 |
| 报 `ComfyUI 报错：...` + 节点校验详情 | 模型文件名对不上或节点不存在 → 对照上面「依赖」里的三个文件名，以及 ComfyUI 版本需支持 `TextEncodeQwenImage21` / `QwenImage21Cache`（本机 0.37.0 内置） |
| 图出来了但聊天框只有文字 | 交付卡片依赖会话工作区能取到该文件；把 `outputDir` 设在会话工作区内（默认就在桌面「千问1生图」） |
| 显存不够 / 很慢 | RTX 5060 Laptop 8 GB，三个模型共 14 GB 必然换入换出。降低 `megapixels`（如 0.5）能明显加快 |

## 自测

```powershell
node scripts/selftest.mjs
```

纯 Node，**不联网、不需要真 ComfyUI、不出图、不占显存**：起一个**假 ComfyUI HTTP 服务器**，
把插件真跑一遍（探活 → 提交 → 轮询 → 取图 → 落盘 → 交付事件），另加尺寸/文件名/workflow
结构/失败分支/**空闲关停边界**/**状态端点鉴权**/**客户端卡片渲染**的断言（**138 项**）。

## 配置

改 `cordis.patch.yml` 里那一行的 `config`（这一层升级插件也不会被覆盖）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `comfyUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `outputDir` | `C:\Users\<你的用户名>\Desktop\千问1生图` | 成品落盘目录 |
| `comfyOutputDir` | `D:\ComfyUI\ComfyUI\output` | 先在本地取文件，取不到才走 `/view` |
| `unet` / `clip` / `vae` | 三个千问文件名 | 换模型时改这里 |
| `steps` / `resolution` | `25` / `1024` | 默认步数与编码分辨率 |
| `timeoutMs` | `600000` | 单任务超时（10 分钟） |
| `idleShutdownMs` | `300000` | ★ 出图后多久没再出图就自动关掉 ComfyUI（5 分钟） |
| `autoShutdown` | `true` | 设 `false` 就永不自动关 |
| `idleCheckMs` | `30000` | 空闲检查间隔 |
| `statusCacheMs` | `3000` | 状态探测缓存（客户端每 5 秒轮询一次） |

## 设计取舍（为什么这么写）

- **零外部依赖**：不 `import @deepseek-ai/dsh-tools`。`tools.register()` 只强校验
  `output.schema` 是标准 JSON Schema，而 `parameters` 的 spec→JSON Schema 转换是
  `defineTool()` 做的、`register()` 不校验 —— 既然自己写成标准 JSON Schema 就够，
  就不引入"装进 profile 后解析不到包"的风险（插件加载失败会让 DSH 起不来）。
- **用局部 `root.inject` 等服务**，不用对象级 `inject`：对象级会把整个 `apply`
  推迟到服务就绪之后，某个服务在老宿主里不存在时插件会**永远不 apply 且不报错**。
- **workflow 照抄主人机器上已验证的那份**（`D:\ComfyUI\小鲸鱼生图\app.py` 的
  `build_workflow`），节点与连线一个字不改。
- **启动预热**：插件加载时后台探一次后端，不在线就**隐藏窗口拉起**
  （不 await、不阻塞 DSH 启动）；出图时还有一次兜底，所以预热失败也不影响出图。
- **空闲关停的计时起点有两个**：预热确认后端在线时、以及你在界面里改档位时。
  （⚠ 早先只有"出图成功"才算起点，结果**重启 DSH 后一次图都没画就永远不关** —— 已修。）
  到点还要确认它在线、`/queue` 为空（**有任务就续期，绝不打断**），
  并且**只杀命令行确实像 ComfyUI 的进程** —— 宁可留着占显存，也不误杀别人的进程。
- **状态端点只放行本机、只回事实**：`{ok, online, busy, idleShutdownInMs, url}`，
  不含任何本地路径或模型名（自测里有专门一条断言守着这条）。
- **客户端状态指示器用 React 座位 + 纯 DOM**（照 `dsh-reasoning-glow` 的做法）：
  React 只渲染一个 `<span>` 座位，圆点与文字都在 `useEffect` 里用原生 DOM 挂，
  并且注册前检查 `React.useRef`/`useEffect` 存在 —— 种子被裁剪过就安静跳过，绝不抛。

## 许可

**MIT** —— 见 [LICENSE](LICENSE)。你可以自由使用、修改、再分发（包括商用），
**只需保留版权声明与许可声明**。

## 致谢与来源

- **15 种流光的配色抄自「月匠」** —— 原样照搬、一个色标没改，仅作致敬与复用，
  相关权利归原作者；原作者若有异议，联系即删。
- **模型权重**来自 **Comfy Org 官方在 ModelScope 的仓库**
  （<https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1>）。
  本仓库**只记录官方 SHA256**，**不转存、不镜像**任何权重文件。
- **ComfyUI** 是 [comfyanonymous/ComfyUI](https://github.com/comfyanonymous/ComfyUI) 的作品，
  本插件只是通过它的 HTTP API 下任务。

## 作者

**@奇迹与你**　｜　<https://github.com/wonderandyou/dsh-qwen-paint>

