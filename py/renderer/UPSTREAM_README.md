# Rune Keepers 广告视频流水线

schema JSON → 8 秒竖屏广告 MP4。只有两步用到模型，其余全部是确定性代码。

## 流程
1. **plans/<id>.plan.json**（LLM 写，唯一需要"创意"的文件）：两张关键帧的 prompt、角色台词（由 hook 推导，不照抄 hook）、片名/副标题、时间轴、配乐预设。
2. **src/gen_keyframes.py**（生图 API，2 次调用）：第 2 张以第 1 张为参考图，保证角色一致。默认 OpenAI `gpt-image-1`，换任何支持参考图的模型只需改 `generate/edit`。已存在则跳过。
3. **src/render.py**（确定性）：推镜、切换闪光、震屏、粒子、暗角、中文台词、片尾标题 + 脉动 CTA 按钮（文字取自 schema `layers.cta`，emoji 用 assets/emoji/<码点>.png）。静态图层只渲染一次、按包围盒合成，多进程渲染，原始帧直接管道给 ffmpeg。
   风格 `plan.style`：`rune`（月光符文，青/金圆角按钮）或 `western`（暖色风尘，铜钉木牌按钮）。
4. **src/audio.py**（确定性）：预设 `epic_strings`（弦乐+定音鼓）或 `western`（口哨+拨弦吉他+铃），节奏跟随时间轴；与渲染并行。
5. **ffmpeg** 合成音轨，响度归一到 -14 LUFS，精确裁到 schema 时长。

## 运行
```bash
pip install -r requirements.txt     # 另需 ffmpeg
./setup_fonts.sh                    # 下载 Noto Serif CJK SC Bold
export OPENAI_API_KEY=...           # 仅在需要生成新关键帧时
./make_video.sh v_041               # -> build/v_041/v_041.mp4
```
2 vCPU 上整条（关键帧已缓存）约 15 秒；v1 是 1 分 54 秒。核数越多越快。

## 新增一条变体
1. 把 schema 存为 `schemas/<id>.json`
2. 让 LLM 按 `plans/v_041.plan.json` 的格式写 `plans/<id>.plan.json`
3. `./make_video.sh <id>`

## 规则（写 plan 时遵守）
- hook 是人设/规则，不是要逐字出现的文案
- 不写环境描述字幕；文字只从角色对玩家说的那句台词开始到片尾
- CTA 是与画面风格一致的按钮；所有屏幕文字用中文
- 温暖、略带戏剧感；无血腥、无性内容；结尾必须是安装 CTA

## 已知限制
- 动作是两张关键帧的切换，不是连续动作
- 新风格需在 render.py 的 STYLES 和 audio.py 的 PRESETS 里各加一项
