# Simula Creative Loop Agent（创意闭环 Agent）

[English → README.md](README.md) · [给 AI Agent 的安装运行指南 → AGENTS.md](AGENTS.md)

为 **Rune Keepers（符文守护者）** 的短视频广告自动跑完整个闭环，共四步：

1. 把创意拆成可替换图层的 **manifest**。
2. 把第 0 代渲染成 9:16 的 MP4，中英双语，并由视频大模型校验。
3. 每一代都在 **Statsig** 上做 A/B 实验，流量来自用 `creative_performance.csv` 拟合出的**模拟用户群**。
4. 由 **LLM Agent** 读实验结果，写出下一代。

整个编排跑在 **Pi Durable** 上：崩溃或 Ctrl-C 之后可以从断点继续。

## 快速开始

```bash
npm install
npm run setup     # 交互式：检查 ffmpeg/uv，询问密钥，建 Python 环境，下载字体，拟合受众模型
npm run loop      # 第 0 轮（8 个种子变体，渲染并校验）+ 第 1..3 轮 + 最终胜出变体渲染 + trace.html
```

依赖：

- Node ≥ 22.19，直接运行 TypeScript
- `ffmpeg` / `ffprobe`
- [`uv`](https://docs.astral.sh/uv/)，会自带 Python 3.12

密钥：

- **OpenRouter：** 必需，用于 LLM、生图和视频审核。
- **Statsig：** Server Secret 与 Console API 两个 key。没有也能跑：加 `--local` 走离线平台，分组算法同样是确定性哈希。

| 命令 | 作用 |
|---|---|
| `npm run loop` | 完整闭环（默认种子轮之后再跑 3 轮）；`-- --run <id>` 可从断点续跑 |
| `npm run loop -- --local --no-render --scale 0.2 --rounds 1 --set memory.write=false` | 离线冒烟测试，几分钱 |
| `npm run round -- --round N --run <id>` | 只跑一轮（"一条命令跑一轮"） |
| `npm run render -- --run <id> --variant <vid>` | 单独（重新）渲染并校验一个 manifest |
| `npm run report -- --run <id>` | 重新生成 `trace.html` / `trajectory.md` |
| `npm run eval -- --run <id>` | 离线评估：和随机搜索、单层变异等基线比，看离目录最优解还差多少 |
| `npm run pulse -- --run <id>` | Statsig 算好 Pulse 后，挂上指标并拉取结果 |
| `npm run conclude -- --run <id>` | 把每轮结论写回 Statsig：计划时长改为模拟流量（替代默认 14 天），并记录决策（发布胜出组，理由里写明 IPM、置信区间、提升和 p 值） |
| `npm run export -- --run <id>` | 把视频、manifest、trace 拷到 `deliverables/<id>/` |
| `npm run doctor` | 检查工具、密钥、模型 ID 和 Statsig 连通性 |

常用参数：

- `--human`：每轮提案在终端人工审批；默认跳过人工审核，直接采信 AI 意见。
- `--langs en,zh`：视频语言。
- `--scale 0.25`：缩小每组流量。
- `--no-render`：跳过渲染。
- `--set key=value`：改任意配置项。

## 一次运行做了什么

| 轮次 | 谁 | 做什么 |
|---|---|---|
| 0 | 策略 Agent | 参考历史数据中各图层 × 人群的表现，设计第 0 代：8 个 manifest，至少 3 个图层有变化。对照组复刻历史投放量最大的创意 |
| 0 | 代码 | 8 个变体**并行**渲染（8 个 Pi Durable 子任务），中英双语各一版。Muse Spark 1.3 逐个核对视频与 manifest；不符合就带修改建议打回重做，最多 3 次；3 次都不过就选得分最高的一版 |
| 0..3 | 代码 | 每轮在 Statsig 建一个实验：8 组，参数 `variant_id`。模拟用户由 Statsig SDK 分组，上报曝光和事件，然后读出结果 |
| 1..3 | 策略 Agent | 读结果，冠军留作对照，再提 7 个挑战者。每个挑战者是某个已测变体的子代，只改 1–2 层，并且要引用真实的实验数字 |
| 最终 | 代码 | 渲染并校验最终冠军（如果它不是种子变体），生成 trace.html，并更新跨运行的经验库 |

按你的要求，只有第 0 代和最终胜出变体会渲染视频。A/B 实验评测的是 **manifest**，因为受众模型给图层打分，而不是给像素打分。把 `render.policy` 设成 `"all"`，就每一代都渲染。

## 关键设计

- **Manifest：**
  - 图层与 CSV 列一一对应（`background`、`subject_character`、`subject_action`、`hook_text`、`cta_text`、`audio_style`），取值限定在 CSV 词表内，所以受众模型能给任何 manifest 打分。
  - 格式锁定为 9:16、6 秒，这是数据里唯一能满足 5–10 秒 / 9:16 渲染约束的组合。
  - manifest 写入后不再修改：任何改动都生成新的 `variant_id` 并记录 `parent_id`，两个变体差在哪里就是逐层比较。
- **按图层缓存：**
  - 关键帧 1 只取决于背景 + 角色。
  - 关键帧 2 = 关键帧 1 + 动作，以关键帧 1 为参考图生成，保证角色一致。
  - 只改 hook、CTA 或音频时两张图都复用，只重做文字、音乐和合成，本地约 6 秒。
  - LLM 只写台词（英文必须逐字包含 hook）、标语和时间轴。
- **生图与审核：**
  - 生图用 OpenRouter 的 `openai/gpt-image-2.6-sunburst`（偏质量/细节的档位），`high` 质量。
  - 视频审核用 `meta/muse-spark-1.3-contributor`，直接看 MP4，逐项核对背景、角色、动作、屏幕台词原文、按钮文字、片尾和品牌安全。
  - 审核员偶尔会声称"看不到视频"，这算工具故障，不算创意问题：先重试，再退化为发三张截帧，不会因此误判打回。
- **规格闸门：** 用 ffprobe 检查 5–10 秒、9:16、≤1080×1920、H.264、有可听音轨。
- **受众模型：**
  - 两阶段岭回归 logistic：P(点击)，P(安装 | 点击)，以及按人群计的 P(安装 | 未点击)。
  - 特征是图层、人群 × 图层交互、操作系统，以及按人群分别估计的疲劳项 log(曝光次数)。
  - 正则强度用 5 折交叉验证选出。留出集 AUC：点击 0.65，安装 0.65。
- **实验：**
  - 主指标：IPM（每千次曝光安装数）。这是比率指标，以用户为随机单位，方差用 delta 方法。
  - 护栏：CTR 相对对照下降不得超过 15%。
  - 样本量：按 30% 最小可检测效应做功效分析，Bonferroni 校正，每组上限 2 万用户，并报告实际可检测的效应。
  - 停止：最多 4 次观察，用 O'Brien–Fleming 边界，满足时可提前停止。
  - 冠军：护栏合格、P(best) 最高的组；经 Holm 校正后仍显著，才标为"显著"。
  - 写回 Statsig：每轮读完结果后，把实验的计划时长改为模拟流量（`targetExposures`，替代默认的 14 天），再把结论记录为实验决策：发布胜出组，理由里写明完整读数。控制台里每一轮都会显示为已完成。
- **Agent：**
  - 策略 Agent 是整个运行共用的一个 Pi Durable 对话，所以记得自己之前的推理。
  - 工具 `submit_generation` 调用确定性校验器：取值合法、子代改动层数、不重复测试、引用的数字必须与记录一致。不通过就把所有错误退回给 Agent 修改。
  - 经验列表（learnings）是 Agent 在轮次之间的记忆；跑完后写入 `memory/playbook.json`，下次运行作为弱先验。
- **人工介入：**
  - `--human`：每轮在终端审批或带意见退回。
  - 也可以不打断流程，随时往 `runs/<id>/feedback.md` 写意见，下一轮会注入一次。
- **追踪：** `runs/<id>/trace.html` 支持中英切换。
  - 每轮包含：Agent 改了什么、为什么、实验与样本量、完整结果表、各项花费。
  - 种子与最终视频附有每次校验的记录。
  - 另有 Agent 结论和事件日志。
  - 预算守卫在花费会超过 `budget_usd`（默认 $25）时拒绝调用。

生产化方案（Goal 5）、目录结构和已知限制，见英文版 [README.md](README.md)。
