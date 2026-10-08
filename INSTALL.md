# dsh-qwen-paint —— 安装说明

> **作者：@奇迹与你**
>
> **写给 AI 助手（DSH 自己）**：这是一个 DSH 插件包。如果你被要求安装它，
> 照本文档「三、一键部署」做即可。**不要改动 DSH 的安装目录**
> （`app.asar` / `Program Files` / `%LOCALAPPDATA%\Programs`），这个包完全不需要动那些地方。

---

## ⓪ 最快路径（先看这个）

| 你是谁 | 怎么做 |
|---|---|
| **用户，不想碰命令行** | **双击根目录的 `一键安装.cmd`** —— 它会先自报版本与文件指纹，再检测、问一句、然后才装 |
| **用户，把活交给 DSH** | 打开 **`给DSH安装的话.md`**，里面两段话可以直接复制给 DSH |
| **DSH 自己** | 先跑 `node scripts/setup.mjs --check`（只打印、不下载）；AMD 卡或显卡认不出来时加 `--amd` |

> ⚠ **「装错版本」是踩过的真坑**：把新包解压到**已经存在的目录**里时，解压工具会**跳过同名文件**，
> 于是 `setup.mjs` 还是旧的 —— 而你却以为用的是新包（症状：参数不认、行为跟旧版一样）。
> **`一键安装.cmd` 一开口就打印版本号和 `setup.mjs` 的 SHA256 前 12 位**，对一下就知道是不是同一份。
> 最保险：**每次都解压到一个全新目录**。

---

## 一、这是什么

一个 DSH 插件：**在对话里说一句「画一只猫」，它调用本机 ComfyUI 用千问模型出图，
出图后直接显示在聊天框里。**

- 纯本地：只走 `127.0.0.1`，**不出网、不花钱、不需要任何 API Key**
- 出图落盘到**当前用户桌面的「千问1生图」**目录
- 生成期间在聊天流里放一个 **9:16 的动画块**，出图后平滑过渡成图片。
  动画**可选**：默认是「流星（自制）」，另有 **15 种流光**（配色抄自月匠）
- 输入框右下角有**后端状态点**（在线 / 出图中 / 未启动）。点它弹出设置：
  「自动关闭」时长 + 「生图动画」选择，**选择会自动记住**
- 后端**空闲自动关停**（默认 5 分钟，释放显存），下次出图时**自动隐藏启动**

---

## 二、⚠ 前提依赖

| 依赖 | 说明 |
|---|---|
| **ComfyUI** | 本机已装且能启动（默认端口 `8188`）。[官方仓库](https://github.com/comfyanonymous/ComfyUI) |
| **千问 Qwen-Image 2.1 模型** | 三个文件，共约 **13.3 GB**（见下表） |
| **Node.js** | DSH 自带的环境就够 |
| **curl.exe** | Windows 10 及以上**系统自带**，无需安装 |

**这三个模型可以完全自动下好**（下一节），不用你手动找。

---

## 三、一键部署（推荐）

在插件目录下：

```
node scripts/setup.mjs                 检测 + 缺什么补什么
node scripts/setup.mjs --check         只看差什么，绝不下载、绝不改动
node scripts/setup.mjs --verify        已存在的模型也重算一遍 SHA256（慢，但最稳）
node scripts/setup.mjs --comfy D:\ComfyUI     指定 ComfyUI 目录
node scripts/setup.mjs --download-comfy       顺带下载 ComfyUI 官方便携包
```

它会依次做三件事：

1. **找 ComfyUI** —— 依次看 `--comfy` 参数、`DSHQP_COMFY_DIR` / `COMFYUI_DIR` 环境变量、
   以及 `D:\ComfyUI`、`C:\ComfyUI`、用户目录下等常见位置。找不到就打印官方地址并停下
2. **下三个模型**到正确目录，逐个做 **SHA256 校验**；**校验（大小或哈希）不过的文件一律删除**
3. **把插件挂进 DSH profile**（内部调用 `scripts/install.mjs`，失败会自动回滚）

跑完**彻底退出 DSH 再重新打开**即可。

### 显卡：N 卡和 A 卡走两条路（0.1.1 新增）

脚本会**先看显卡**再决定怎么装：

| 显卡 | 走哪条路 |
|---|---|
| **NVIDIA** | ComfyUI **官方便携包**（CUDA），开箱即用 |
| **AMD Radeon** | **ROCm** 路线（见下）—— 装完**还是 ComfyUI**，插件本身不用换 |
| Intel 核显 | 基本跑不动，建议换台机器 |

⚠ 机器上同时有独显和 AMD 核显时，**有 N 卡就按 N 卡走**（那条路最成熟）。

#### AMD Radeon 用户（重点看这一段）

先看计划（**只打印，不装任何东西**）：

```
node scripts/setup.mjs --check
```

确认要装再执行（会下载约 3 GB）：

```
node scripts/setup.mjs --yes
```

装的是 **AMD 官方软件仓库** `repo.radeon.com` 上的 ROCm 版 PyTorch，
外加 ComfyUI **官方 GitHub 源码**；模型和 N 卡**完全同一套**
（Comfy-Org 官方那三个文件，哈希一模一样）—— 换显卡不用换模型。

**⚠⚠ 装完必须知道的三件事：**

1. **可能静默出错** —— 在 gfx1100 这类卡上，它跑得飞快、日志也不报错，
   出来的却可能是**噪点 / 全黑 / 颜色错**。**出第一张图后一定要人眼看一眼**，
   不能只看"跑完了"。这是 A 卡最坑的地方。
2. **别升到 ROCm 10.0 那套 wheels** —— 它报 HIP 7.15，实测会破坏权重。
   脚本锁死在 **7.2.1**。
3. 模型是 **Qwen Research License**：**仅限研究 / 评估，禁止商用**。

启动参数别省（脚本会提示）：

```
python main.py --disable-dynamic-vram --use-pytorch-cross-attention
```

`--disable-dynamic-vram` 在 A 卡上是**必须的** —— DynamicVRAM 在那上面有已知问题。

**前提**：AMD 的 Windows wheels **只支持 Python 3.12**（3.13 装不上）。
没有的话脚本会告诉你装：

```
winget install --id=Python.Python.3.12 -e
```

（装运行时属于动系统，脚本**不替你装**，只提示。）

> **本插件只用 ComfyUI 一种后端**（N 卡走官方便携包，A 卡走 ROCm），
> 不使用、也不需要任何第三方推理后端。

### 下载渠道（只走有正规资质的渠道）

| 东西 | 来源 | 哈希怎么核 |
|---|---|---|
| **三个模型** | **ModelScope 官方直连**：<https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1> | 期望值取自该仓库**文件列表 API 的 `sha256`** |
| **ComfyUI 本体** | [GitHub 官方 release](https://github.com/comfyanonymous/ComfyUI/releases) | ⚠ 官方 release **不公布哈希**，所以脚本**默认不自动下它**；显式加 `--download-comfy` 才会下，而且会**再问一次** |

**为什么模型来源可信**：该仓库的上传者是 **Comfy Org 官方组织自己**
（仓库信息里 `Organization.GithubAddress = https://comfy.org/`），
不是第三方转存；平台是**阿里官方的 ModelScope**。两者都不是"某个热心人搭的镜像"。

### 三个模型的官方指纹

| 文件（放到 `models\` 下） | 大小（字节） | SHA256 |
|---|---|---|
| `diffusion_models\qwen_image_2.1_int8_convrot.safetensors` | 7256783064 | `cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d` |
| `text_encoders\qwen3vl_8b_w4a8.safetensors` | 6312105364 | `7754425e55e7bea2bfde4dde59a4cc236cb44e5ee9c215ea66ef8d47012824eb` |
| `vae\qwen_image_2.1_vae_bf16.safetensors` | 675509688 | `bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9` |

> 这三个值**成对使用**，改版本时重新取一次上面那个 API。

### 断点续传 / 中途断了怎么办

**直接重跑同一条命令**即可 —— 下载走 `curl -C -`，会从断点接着下，不会从头再来。

### 体积与时间

约 **13.3 GB**。脚本每 3 秒打一行进度（已下字节数 + 速度），不会让你干等。

---

## 四、安装插件本身

上面的 `setup.mjs` 最后一步已经替你装好了。要单独装/重装：

### 方式 A（推荐）：交给 DSH 自己装

把这个目录（或 zip）交给 DSH，说一句：

> 照 `INSTALL.md` 把这个插件装一下

DSH 会自己完成：link 到 profile、加进 bundle 清单、验证入口能 import、失败自动回滚。

### 方式 B：手动 / 脚本

```
node scripts/install.mjs             安装到 desktop profile
node scripts/install.mjs --dry-run   只打印将要做的事
node scripts/install.mjs --uninstall 卸载
```

等价于手工编辑 `~/.dsh/profiles/<profile>/package.json`：

- `dependencies` 里加：`"dsh-qwen-paint": "link:<这个目录的绝对路径>"`
- `dsh.profile.bundles` 数组里加：`"dsh-qwen-paint"`

⚠ 目录要放在**固定位置**（例如 `~/Documents/dsh-qwen-paint`），**别放临时目录**。

---

## 五、怎么验证装好了

重启 DSH 后：

1. **输入框右下角出现状态点** —— 「ComfyUI 在线 / 未启动」
   （有这一点就说明客户端半边加载成功）
2. **点它一下** —— 应该弹出两组菜单：「自动关闭」和「生图动画」
3. **说一句「画一只橘猫」** —— 先出现动画块，最后变成图片
4. 图落在**你桌面的「千问1生图」**目录里

出图目录不写死：默认按当前用户的桌面推算。要固定在别处，在 `cordis.patch.yml` 里
放开 `outputDir` 那行并改成你的路径。

---

## 六、可调项

**界面上就能改的**（点输入框右下角状态点）：

| 项 | 选项 | 说明 |
|---|---|---|
| 自动关闭 | 不自动关闭 / 1 / 5 / 10 / 30 分钟 | 空闲多久没出图就关掉 ComfyUI |
| 生图动画 | 流星（自制）+ 15 种流光（抄自月匠） | 出图期间的动画块长什么样 |

这两项选完**会存到 `$DSH_HOME/qwen-paint-ui.json`**，重启 DSH 照样记得。

**配置文件里的**（`cordis.patch.yml`，升级插件不会覆盖这一层）：

| 项 | 默认 | 说明 |
|---|---|---|
| `comfyUrl` | `http://127.0.0.1:8188` | ComfyUI 服务地址 |
| `outputDir` | *（按用户桌面推算）* | 成品落盘目录，注释状态，要固定就放开 |
| `timeoutMs` | `600000` | 单张图超时（毫秒） |

更多可调项（步数、分辨率、空闲关停时长、模型文件名等）在 `lib/index.js` 顶部的 `DEFAULTS` 里。

---

## 七、卸载

```
node scripts/install.mjs --uninstall
```

或对 DSH 说「把这个插件卸了」。卸载**只摘链接和清单条目，不删这个目录**，
也**不会**动 ComfyUI 和模型。

---

## 八、自测

包内自带端到端自测（起一个假 ComfyUI 服务器，不需要真后端、不出图、不联网）：

```
node scripts/selftest.mjs
```

覆盖：工具形状与 JSON Schema、workflow 与已验证实现逐节点对齐、端到端出图流程、
交付事件载荷、空闲关停四种边界、状态端点鉴权与"不泄露路径"、
客户端卡片渲染、菜单两组的高亮与"点空白处消失"、生图动画的白名单与落盘、
以及**客户端动画表与宿主白名单的一致性**。

---

## 九、打包（作者自用）

```
node scripts/pack.mjs
```

产出 `dist/` 下的 zip，并在打包前做四道检查：文件白名单与必需文件、**隐私检查**
（本机用户名 / 用户目录绝对路径 / 临时目录 / 会话路径 / Key）、
每个脚本的 `node --check` 语法自检、以及**解压后逐文件核对字节数**。
