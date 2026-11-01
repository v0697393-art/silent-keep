# 缄默堡 · 第一章 —— 游戏代码（game/）

锈湖风格的点击解谜游戏，题材是克苏鲁 × 中世纪家族。手机竖屏，用原生 ES modules + Canvas/DOM 实现，不需要构建。
- 策划数据直接读 `../design/data/chapter1.json`。
- 美术素材读 `../art/`，音频读 `../audio/`。
- 本目录只放代码；`design/`、`art/`、`audio/` 由各组维护，代码不改这些目录。

## 运行

```bash
cd game
npm install                 # 只装 playwright-core（冒烟测试用）
npm run assets              # 扫描 ../art ../audio → assets-manifest.json（素材有变动就重跑）
npm run serve               # http://localhost:8090/game/  （以 rusty-game/ 为根）
npm run verify              # 数据校验 + 全状态搜索 + 03 解法链回放
node tools/smoke-test.mjs   # 390×844 触屏冒烟测试，截图到 screenshots/
npm test                    # 以上三步
```

- `?debug`：显示热区框。
- 存档在 localStorage 的 `hushwold_save_v1`。

## 目录

| 路径 | 作用 |
|---|---|
| `index.html` / `css/style.css` | 舞台 1080×1920 等比缩放。<br>竖向布局：顶部 HUD 120，游戏区 1540（y 120–1660），道具栏 220，底部安全区 260。 |
| `src/main.js` | 启动流程：<br>1. 读章节和补丁、素材清单、美术热区覆盖；<br>2. 创建 Assets / AudioManager / Renderer / Game；<br>3. 首次触摸解锁音频。 |
| `src/engine/logic.js` | **纯逻辑**（不碰 DOM）：<br>- 状态 S、热点命中、条件、效果、合成；<br>- 审讯、线索板、推理、心烛。<br>浏览器和 Node 工具共用这一份。 |
| `src/engine/chapter.js` | `normalizeChapter`：把 chapter1.json 按它自己的格式规整，再用 `data/chapter1.patch.json` 补缺；<br>`applyHotspotFile` 应用美术交付的热区坐标。 |
| `src/engine/game.js` | 场景交互、事件表现、模态栈、道具栏、对话打字机、HUD、音乐选择。 |
| `src/engine/audio.js` | WebAudio 音频管理（见下文）。 |
| `src/engine/renderer.js` / `stage.js` / `input.js` | Canvas 场景（背景、占位、转场、乌鸦、低理智特效）；<br>等比缩放与坐标换算；<br>触屏点击，并屏蔽浏览器手势。 |
| `src/engine/assets.js` / `asset-names.js` / `characters.js` | 按 id 找素材文件，找不到就用程序生成的占位图；<br>只请求清单里存在的文件，所以缺图不会 404。 |
| `src/ui/*` | 模态框、审讯、线索板、推理、手记（证据/笔记/线索板/推理/扩展页）、道具详情、菜单、过场。 |
| `src/puzzles/*` | 谜题插件：`rotate-grid`（纹章石盘）、`dial`（密码轮）。<br>在 `puzzles/index.js` 注册新类型。 |
| `src/ext/*` | 扩展槽：<br>- `familytree.js`：家谱，随 `ev_revealed_tree` 解锁；<br>- `diary.js`：日记占位。<br>用 `registerNotebookTab` 往手记里挂新页。 |
| `data/chapter1.patch.json` | 补齐策划数据里缺的东西：<br>- 文本表、房间/NPC/热点显示名；<br>- 界面音效映射 `uiSfx`、`uiBgm`、`hotspotSfx`。<br>**只补缺，不覆盖策划数据。** |
| `tools/verify.mjs` | 校验内容：<br>- 静态检查（引用、几何、标志、素材、**音频 id 必须在 audio_manifest.json 中**）；<br>- BFS 全状态搜索，确认没有死局；<br>- 回放 03 解法链。<br>完整报告写到 `tools/out/verify-report.json`。 |
| `tools/smoke-test.mjs` | 用 playwright-core 在 390×844 iPhone 触屏下按 `walkthrough-ch1.json` 真实点击到章末。<br>要求没有任何 console.error、pageerror 或 4xx。<br>同时检查音频解锁、各房间 BGM/环境声、心烛音效阶段。<br>报告写到 `tools/out/smoke-report.json`。 |
| `tools/scan-assets.mjs` | 生成 `assets-manifest.json`，内容包括：<br>- 美术文件（排除 lineup / contact_sheet / review / 评审 / style_sample / palette）；<br>- 热区文件；<br>- 音频文件 + audio_manifest。 |

## 素材约定（美术）

- **文件名**：文件名就是数据里的 id，后面可以带尺寸后缀，放在 `art/` 的任意子目录都可以。
  - 例：`art/bg/bg_r1_hall_1080x1920.png`、`art/characters/char_osbert_calm.png`。
- **自动替换占位**：图片到位后跑 `npm run assets`，占位图就会被换掉。
- **热区坐标**：放 `art/**/<房间或背景名>_hotspots.json`，格式是 `{ "room": "r1_hall", "hotspots": { "h_table": [x,y,w,h] } }`，坐标用 1080×1920 逻辑像素，会覆盖策划坐标。`verify` 会报告覆盖了哪些热点、有哪些未知 id。
- **游戏区**：热点要放在 y 120–1660 之间，超出的部分会被 HUD 或道具栏挡住，`verify` 会给出 WARN。

## 音频接入（audio/README.md）

- **只用 WebAudio**：没有 `<audio loop>`。每条音频先 fetch，再 `decodeAudioData`，然后用 `AudioBufferSourceNode` 播放。
  - 循环条目设 `loop=true`，并使用 manifest 里的 `loopStart` / `loopEnd`；不循环的条目（如 `bgm_ending_ch1`）只播一遍。
- **格式顺序**：按 `audio_manifest.json` 的 `formats_by_preference_ios_first`，即 m4a → ogg → mp3。
  - 浏览器 `canPlayType` 明确不支持的格式会排到最后，但仍保留作解码兜底；某个格式解码失败就自动试下一个。
- **解锁**：第一次 pointerdown 或 touchend 时创建并 resume AudioContext，然后补播当前想要的 BGM 和环境声。
  - 切到后台时 suspend，回来时 resume。
  - 静音状态存在 localStorage 里。
  - 没有 WebAudio 时静默降级。
- **接口统一**：`audio.sfx(id)`、`audio.bgm(id)`、`audio.amb(id)`、`audio.preload(ids)`；`playSfx` / `playBgm` / `playAmb` / `stopBgm` 是别名。
  - 构造参数是 `new AudioManager({ files, manifest, alias, muted })`，main.js 会传入 `assets-manifest.json` 的音频文件列表、`../audio/audio_manifest.json` 和补丁里的 `audioAlias`。
- **id 映射**：界面音效走补丁里的 `uiSfx`（如 `tap → sfx_tap`、`break → stinger_contradiction`）。
  - `uiBgm` 用于标题、审讯、线索板、章末。
  - `hotspotSfx` 是热点的附加音效（乌鸦、开窗风、绞盘）。
- **音量**：采用 README 的建议音量（`SUGGESTED_GAIN`）。分 bgm / amb / sfx 三条总线。
- **心烛阶段**（`SANITY_STAGE`，阶段之间 1.5–3 s 渐变，回升时反向渐变）：

  | 阶段 | 条件 | BGM/环境低通 | BGM detune | BGM 增益 | 耳语层 |
  |---|---|---|---|---|---|
  | 0 | 心烛 ≥ 85 | 20 kHz（不过滤） | 0 | 1 | — |
  | 1 | s1 且心烛 < 85 | 9 kHz | 0 | 0.94 | — |
  | 2 | s2 | 4 kHz | −10 音分 | 0.81 | `amb_whisper_low` 0.3 |
  | 3 | s3 | 1.8 kHz | −30 音分，外加 ±8 音分随机漂移 | 0.69 | low 0.3 + `amb_whisper_near` 0.7，声像左右游走 |

  - 心烛恢复时播放 `sfx_sanity_restore`。
  - 不支持 `detune` 的浏览器改用 `playbackRate` 近似。
- **校验**：`verify` 会收集数据里引用的音频 id（房间 bgm/amb、sfx 效果、心烛 fx、uiSfx、uiBgm、hotspotSfx），以及源码里的音频字面量和 `sfx('键')` 调用。
  - 音频 id 不在清单里就报错。
  - `sfx('键')` 的键既不在 `uiSfx` 里、也不是清单 id，同样报错。
