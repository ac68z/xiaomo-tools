# xiaomo-toolkit · 小墨的工具合集

一个仓库，顶层平级三块：**`tools/`**（能直接跑的小工具）和两个插件目录并排放，互不嵌套。
`tools/` 里再按类别分文件夹，分类下面才是具体工具。
不是框架，不装依赖管理器，每件都能单独拿走用。

> 这些都是「在本机跑」的东西：调用本地服务（ComfyUI）、读写本地文件。
> 仓库里只有代码和模板，模型权重、私人提示词、私人图片一律不放。

## 立场：押在协议上，不押在货架上

- **工具是能力，插件是分发**：工具是「要做这件事，知道该调哪一个」；插件挂在某个平台上，平台一改可能就没了。
- 标准协议（如 MCP）解决的是「**调得到**」，它不管「**调得对**」。所以真正撑住质量的，是另外三层**文本**：
  目录（三步内找到工具）、细则（参数和坑）、闸门与守则（拦手快）。这三样不是插件，平台换了文件还在。
- 插件只留**必须绑平台**的那几件（碰屏幕、收消息、发文件），其余全部走标准协议。

## 目录

```
xiaomo-toolkit/
  tools/                     ← 跟插件平级；里面按类别分，再下面是具体工具
    image/
      draw/                  一句话出图（ComfyUI）＋「先读守则才能画」的闸门
    video/                   以后放视频相关（还没加）
  dsh-memory-surface/        ← 插件：记忆浮现，每轮把相关旧记忆浮一行出来
  dsh-tool-surface/          ← 插件：工具浮现，按这句话捞工具细则
```

| 路径 | 类型 | 是什么 | 依赖 |
|---|---|---|---|
| [`tools/image/draw/`](tools/image/draw/) | 工具 | 一句话出图：提示词打包成 ComfyUI 工作流，出图落盘，带守则闸门 | ComfyUI + Node 18+ + Python 3.8+ |
| [`dsh-memory-surface/`](dsh-memory-surface/) | 插件 | 记忆浮现：按这句话去检索长期归档，命中就浮一行，不塞满上下文 | 宿主支持插件（详见该目录 README） |
| [`dsh-tool-surface/`](dsh-tool-surface/) | 插件 | 工具浮现：检索工具目录，命中就把「工具名＋细则路径」塞进本轮 | 宿主支持插件 + 本地检索服务 |

加新东西的规矩：

- 工具 → `tools/<类别>/<工具名>/`（类别比如 image / video / data）；插件 → 顶层一个 `<插件名>/`，和 tools 平级。
- 两者不互相 import；加完在上表补一行；工具目录里不放模型、不放数据。
- 插件原本各自单独一个仓库（`dsh-memory-surface`），现在并到这里；**旧仓库地址继续可用**，但新东西统一进本仓库。

---

## tools/image/draw/ · 一句话出一张图

```
node tools/image/draw/draw.mjs "1girl, solo, white long hair, red eyes" \
  "lowres, bad anatomy, bad hands" 832 1216 34 --ckpt=animagine-xl-3.1.safetensors
```

- 正向、负向、宽、高、步数、种子，顺序固定；`--ckpt=` 可放任意位置。
- 默认值：`1024x1024`、25 步、种子随机、负向带一组常见的坏手坏字。
- 环境变量（不想改代码就用这个）：

  | 变量 | 作用 | 例子 |
  |---|---|---|
  | `XIAOMO_CKPT` | 默认底模 | `animagine-xl-3.1.safetensors` |
  | `XIAOMO_CFG` | CFG 强度 | `8` |
  | `XIAOMO_SAMPLER` | 采样器 | `euler` |
  | `XIAOMO_SCHEDULER` | 调度器 | `normal` |

- 出图落到脚本顶部的 `OUT_DIR`，文件名带时间戳。

### 闸门：先读守则，再画

`draw.mjs` 第一行就 `requireDrawOpen()`：

1. 算 `rules.txt` 的 sha256，取前 8 位；
2. 跑到期的 `.draw-open.json` 里没有这个码 → 把守则全文打出来，退出，不画；
3. `python tools/image/draw/open_draw.py` 打印守则、给出那个码，输回去才写状态文件；
4. 默认 2 小时过期；**守则一改，码就变，旧的开画立刻作废**。

它拦的不是别人，是自己手快。想改时长：`open_draw.py --hours 8`，看状态 `--status`，关闸 `--close`。

> Windows 上别用 `powershell` 把码直接管进 stdin（会变 UTF-16 判成错）：
> 把码写进 UTF-8 无 BOM 文件，再 `cmd /c "python tools/image/draw/open_draw.py < code.txt"`。

### 守则是模板，请改成你自己的

`tools/image/draw/rules.txt` 写的是**我这套用法**的规矩（固定配方、改图幅度、自检四项、留档、禁止）。
它不是法律，也不该照抄——**你可以直接改**：

- 觉得哪条不合你的习惯就删；没写到的坑就加一条（比如「一次最多出三张」「某些题材不画」）。
- 只写它管的事：来历、起名理由、改版记录放 README，别往守则里塞。
- **改完必须重新开画**：守则一变，sha256 前 8 位就变，旧的开画立刻作废——这正是它想要的。

### 想改哪里

| 想改的事 | 改哪一行 |
|---|---|
| ComfyUI 端口 | `draw.mjs` 顶部 `API` |
| 输出目录 | `draw.mjs` 顶部 `OUT_DIR` |
| 加 LoRA | `workflow` 里加 `LoraLoader`，喂 model / clip 两个口 |
| 加高清放大 | 后面接 `LatentUpscale` + 第二次 `KSampler`（denoise 0.4~0.55） |
| 等结果的上限 | `for (let i = 0; i < 120; i++)` 里的 120（每次 2 秒） |
| 闸门有效期 | `open_draw.py --hours N` |
| 规矩内容 | `tools/image/draw/rules.txt`（改完必须重新开画） |

### 为什么要有笔记

同一串提示词，换种子，笔触会从软光厚涂跳到平涂硬线；写了特写会往半写实走，写了苍白肤色皮肤会发灰。
所以每张留一条：`时间 / 正词 / 负词 / 步数 / 种子 / 输出名`。
出问题先翻笔记，回到被认可的那一版重做，不在错版上叠。

## 模型从哪来

| 模型 | 仓库位置 | 放哪 |
|---|---|---|
| Animagine XL 3.1 | `https://huggingface.co/cagliostro/AnimagineXL3.1` → `AnimagineXL31.safetensors` | `ComfyUI/models/checkpoints/` |
| 控制网 canny / openpose（可选） | HF 上 `controlnet-canny-sdxl-1.0` / `controlnet-openpose-sdxl-1.0` | `ComfyUI/models/controlnet/` |
| ComfyUI 本体 | `https://github.com/comfyanonymous/ComfyUI` | 自己选目录 |

国内慢：把 `huggingface.co` 换成 `hf-mirror.com`，路径不变。
`--ckpt=` 后面写**文件名**，不是路径。

## License

MIT
