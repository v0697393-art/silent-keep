# 《缄默堡》音频包 (第一章)

全部音频由 `src/generate.py` 用 numpy 纯代码合成 (加 ffmpeg 编码)：没有采样、没有第三方素材，也没有借用任何现成旋律 (包括 Rusty Lake)，可以商用。
风格是克苏鲁 × 中世纪 × 家族：教会调式 (多利亚/弗里吉亚)、素歌、空五度，乐器有古提琴、鲁特琴、竖琴、非谐波教堂钟和共振峰人声；底下是 30–60 Hz 深海 sub，配三全音、小二度摩擦和微分音漂移；八音盒和钟摆只作点缀。目标气氛是阴郁、超现实、不可名状的不安，不靠血腥。

依据：`design/05_音乐音效清单.md` (权威清单)，参考 `01_世界观与故事.md`、`03`。

## 目录

```
audio/
  bgm/  amb/  sfx/  vo/        每个条目都有 .m4a (AAC) / .ogg (Vorbis) / .mp3 三份，44.1 kHz
  audio_manifest.json          id → 各格式路径、声道、时长、是否循环、loopStart/loopEnd
  src/generate.py              生成脚本 (python3 generate.py [--only 名字…] [--check])
  src/check_report.json        最近一次自检结果 (时长/峰值/LUFS/大小)
```

格式与码率：
- BGM/环境：ogg q3 (约 96 kbps)、m4a AAC 96 kbps、mp3 VBR V6。
- 音效/人声：ogg q4、AAC 64 kbps (单声道) / 96 kbps (立体声)、mp3 64 / 112 kbps。

合计约 35 MB；任选一种格式随包发布即可，单一格式约 11–12 MB。

响度规范：
- BGM：峰值 ≤ −3 dBFS (实际约 −4 ~ −9)，响度约 −20 ~ −22 LUFS。
- 环境层：约 −27 ~ −28 LUFS。
- 音效：峰值 ≤ −1 dBFS (实际约 −2)。
- 编码之后会再解码一遍复核峰值，超限就降增益重编。

## 文件一览 (清单条目 → 文件)

- 文件列只写到不带扩展名的 id，三种格式文件名相同。
- 大小依次是 ogg / m4a / mp3，单位 KB。
- "峰值/响度"取自 ogg 解码结果。
- "建议音量"是 GainNode 的 gain 值，假定主音量为 1。

| 文件 | 清单条目 | 内容 / 风格 | 时长 | 循环 | 大小 KB | 峰值 / 响度 | 建议音量 |
|---|---|---|---|---|---|---|---|
| `bgm/bgm_title` | 标题曲 | 男声素歌哼唱 (D 多利亚) 叠低音持续音，四句；循环末尾一个音"唱错"——滑到 G#(三全音) 并下沉 −45 音分 | 90.00 s | 是 (无缝) | 886 / 1078 / 772 | -7.9 dBFS / -21 LUFS | 0.8 |
| `bgm/bgm_r1_hall` | 房间1 大厅 | 缓慢古提琴旋律 + 鲁特琴分解和弦 + 壁炉暖意，偶尔冒出 7/11/13 次泛音的不协和亮点、远钟、八音盒、钟摆 | 120.00 s | 是 (无缝) | 1338 / 1437 / 1297 | -8.5 dBFS / -21 LUFS | 0.8 |
| `bgm/bgm_r2_scriptorium` | 房间2 抄写室 | A 多利亚竖琴空五度拨弦 + 羽毛笔沙沙节奏 (72 BPM)，细高持续音，冷而清 | 120.00 s | 是 (无缝) | 1624 / 1444 / 1638 | -5.0 dBFS / -21 LUFS | 0.7 |
| `bgm/bgm_r3_crypt` | 房间3 地窖 | E 弗里吉亚：圣咏空五度低持续 + 远处多人低声合诵听不清的名字 + 34–52 Hz 深海 sub + 水下古提琴、远钟、水滴 | 150.00 s | 是 (无缝) | 1788 / 1789 / 1619 | -7.5 dBFS / -21 LUFS | 0.8 |
| `bgm/bgm_interrogation` | 审讯 | 50 BPM 心跳般的手鼓 (lub-dub) + 持续弦簇 (小二度/三全音) | 90.00 s | 是 (无缝) | 1015 / 1075 / 1011 | -4.0 dBFS / -20 LUFS | 0.8 |
| `bgm/bgm_clueboard` | 线索板 | 极简钟琴 + 竖琴三音固定音型 + 薄垫音 (D 多利亚) | 90.00 s | 是 (无缝) | 1018 / 1075 / 920 | -9.3 dBFS / -22 LUFS | 0.7 |
| `bgm/bgm_ending_ch1` | 第一章结尾 (不循环) | 井底传来"埃德里克"的呼唤 (共振峰合成占位)，由气声渐近渐实、持续音膨胀，41.2 s 处戛然而止 | 45.00 s | 否 | 496 / 496 / 447 | -4.2 dBFS / -20 LUFS | 1.0 |
| `amb/amb_hall_fire` | 环境·大厅壁炉 | 壁炉低吼 + 嘶声 (随整周期 LFO 起伏) + 随机木柴噼啪 | 60.00 s | 是 (无缝) | 704 / 760 / 774 | -7.7 dBFS / -28 LUFS | 0.6 |
| `amb/amb_tower_wind` | 环境·塔楼风 | 塔楼窄带呼啸风 + 远处乌鸦 (约 14 s、41 s 处) | 60.00 s | 是 (无缝) | 720 / 719 / 698 | -11.1 dBFS / -27 LUFS | 0.6 |
| `amb/amb_crypt_drip` | 环境·地窖滴水 | 石窟滴水 + 铁链轻响 (约 9/33/51 s) + 井下极低的吸/呼 (约 6 s 一周期) | 60.00 s | 是 (无缝) | 700 / 716 / 588 | -11.6 dBFS / -28 LUFS | 0.6 |
| `amb/amb_whisper_low` | 心烛 s2 低语层 | 远处、模糊、无法辨词的低语层 (清单要求 s2 时 30% 音量) | 40.01 s | 是 (无缝) | 492 / 485 / 458 | -9.4 dBFS / -24 LUFS | 0.3 (s2) |
| `amb/amb_whisper_near` | 心烛 s3 近耳低语 | 贴耳低语，左右交替出现 | 40.01 s | 是 (无缝) | 345 / 371 / 319 | -4.4 dBFS / -28 LUFS | 0.5–0.8 (s3) |
| `sfx/stinger_contradiction` | 矛盾 stinger 2s | 蜡封盖印 + 低音弦重击 (D + 降A 三全音) | 2.00 s | 否 | 29 / 25 / 28 | -2.2 dBFS / -16 LUFS | 0.9 |
| `sfx/stinger_deduction` | 推理成功 stinger 3s | 上行竖琴 + 素歌和声 (D 空五度 + 小七度) | 3.20 s | 否 | 49 / 39 / 45 | -2.2 dBFS / -14 LUFS | 0.9 |
| `sfx/sfx_pickup` | 拾取 | 两声细小金属铃，第二声略走调 | 0.90 s | 否 | 8 / 8 / 8 | -1.9 dBFS / -14 LUFS | 0.8 |
| `sfx/sfx_combine_success` | 合成成功 | 金属卡合 + 木质闷击 + 空五度 (A5→E6) 小铃 | 1.00 s | 否 | 9 / 9 / 8 | -1.9 dBFS / -14 LUFS | 0.9 |
| `sfx/sfx_combine_fail` | 合成失败 | 两下无效碰撞的木质闷响，第二下更低 | 0.57 s | 否 | 6 / 6 / 5 | -1.9 dBFS / -20 LUFS | 0.8 |
| `sfx/sfx_item_use` | 使用道具 | 棘轮咔哒 + 机械闷击 + 金属余振 | 1.00 s | 否 | 10 / 9 / 8 | -2.3 dBFS / -19 LUFS | 0.9 |
| `sfx/sfx_stone_sink` | 开门 (石盘下沉) | 石磨下沉 + 尘土簌簌 + 末尾沉重落定 | 2.60 s | 否 | 26 / 22 / 21 | -2.2 dBFS / -19 LUFS | 1.0 |
| `sfx/sfx_crest_rotate` | 纹章石盘旋转 | 石面摩擦 + 四个卡位咔嗒 | 1.50 s | 否 | 17 / 13 / 12 | -2.3 dBFS / -22 LUFS | 0.9 |
| `sfx/sfx_dial_click` | 拨盘锁咔哒 | 单格拨盘机械咔哒 (连按可重复播放) | 0.12 s | 否 | 4 / 2 / 2 | -2.3 dBFS / -70 LUFS | 0.7 |
| `sfx/sfx_box_open` | 开盒 | 搭扣 + 小合页吱呀 + 盖子靠定 | 1.00 s | 否 | 12 / 9 / 8 | -1.8 dBFS / -20 LUFS | 0.9 |
| `sfx/sfx_page_turn` | 羊皮纸翻页 | 粗糙羊皮纸皱响 + 轻风声 + 落页 | 0.72 s | 否 | 10 / 7 / 6 | -3.6 dBFS / -20 LUFS | 0.8 |
| `sfx/sfx_charcoal_reveal` | 炭粉显影 | 刷子沙沙 + 渐起的低语 (立体声) | 3.20 s | 否 | 46 / 39 / 45 | -2.2 dBFS / -22 LUFS | 0.9 |
| `sfx/sfx_crow` | 乌鸦叫 + 振翅 | 乌鸦叫两声 + 扑翼 | 1.80 s | 否 | 19 / 16 / 14 | -2.8 dBFS / -21 LUFS | 0.8 |
| `sfx/sfx_window_wind` | 开窗冷风 | 插销 + 短吱呀 + 冷风灌入 (立体声) | 2.40 s | 否 | 39 / 30 / 34 | -2.3 dBFS / -14 LUFS | 0.9 |
| `sfx/sfx_candle_light` | 点蜡烛 | 火柴划擦 + 引燃“噗” + 火苗 | 1.40 s | 否 | 16 / 12 / 12 | -2.3 dBFS / -22 LUFS | 0.8 |
| `sfx/sfx_candle_out` | 熄蜡烛 | 轻吹 + 火苗抖动熄灭 + 一缕烟 | 1.10 s | 否 | 13 / 10 / 9 | -2.7 dBFS / -21 LUFS | 0.8 |
| `sfx/sfx_winch_chain` | 绞盘 + 铁链 | 绞盘吱呀 + 铁链哗啦 | 2.80 s | 否 | 35 / 25 / 22 | -2.1 dBFS / -16 LUFS | 0.9 |
| `sfx/sfx_well_cover` | 井盖滑开 | 沉重石磨滑开 + 落定 + 井口空洞回响 (立体声) | 3.40 s | 否 | 45 / 42 / 48 | -2.3 dBFS / -18 LUFS | 1.0 |
| `sfx/sfx_clue_connect` | 线索连线成功 (红线拉紧) | 图钉 + 红线绷紧上滑的拨弦 | 0.80 s | 否 | 8 / 7 / 7 | -2.1 dBFS / -17 LUFS | 0.8 |
| `sfx/sfx_clue_fail` | 线索连线失败 (线断) | 线断 (清脆断裂 + 下滑抽回) + 轻碰 | 0.60 s | 否 | 6 / 4 / 5 | -3.3 dBFS / -23 LUFS | 0.8 |
| `sfx/sfx_testimony_flip` | 证词条弹出 | 纸片弹起 + 短嗖 + 拍落 | 0.45 s | 否 | 7 / 4 / 4 | -2.8 dBFS / -21 LUFS | 0.7 |
| `sfx/sfx_wrong` | 错误提示 (低沉木声) | 两下低沉木头闷敲 + 极弱的失谐低音 | 0.60 s | 否 | 7 / 6 / 5 | -4.8 dBFS / -19 LUFS | 0.8 |
| `sfx/sfx_tap` | UI 点击 | 极短干木轻敲 (<0.1 s) | 0.08 s | 否 | 4 / 2 / 1 | -3.0 dBFS / -70 LUFS | 0.6 |
| `sfx/sfx_sanity_restore` | 心烛恢复 | 一句素歌 + 烛火趋于平稳 (立体声) | 3.60 s | 否 | 50 / 44 / 50 | -1.9 dBFS / -13 LUFS | 0.9 |
| `vo/vo_edric_hm` | 埃德里克 嗯? | 共振峰合成的疑问"嗯?" | 0.65 s | 否 | 9 / 6 / 6 | -1.9 dBFS / -11 LUFS | 1.0 |
| `vo/vo_edric_sneer` | 埃德里克 冷哼 | 鼻腔短促冷哼 (下滑) | 0.55 s | 否 | 9 / 6 / 5 | -2.0 dBFS / -17 LUFS | 1.0 |
| `vo/vo_edric_gasp` | 埃德里克 倒吸气 | 惊觉倒吸一口气 | 0.60 s | 否 | 9 / 6 / 5 | -1.8 dBFS / -16 LUFS | 1.0 |
| `vo/vo_osbert_sob` | 奥斯伯特 抽泣 | 断续抽泣 (三次哽咽) | 2.20 s | 否 | 22 / 22 / 18 | -2.0 dBFS / -18 LUFS | 1.0 |
| `vo/vo_ysolde_sneer` | 伊索德 冷笑 | 短促鼻音冷笑 | 0.70 s | 否 | 7 / 6 / 6 | -1.9 dBFS / -18 LUFS | 1.0 |
| `vo/vo_ysolde_laugh_break` | 伊索德 崩溃笑 | 几声笑逐渐失控 → 抽泣式吸气 + 颤抖哭腔 | 3.00 s | 否 | 30 / 29 / 24 | -2.7 dBFS / -21 LUFS | 1.0 |

> 超短音效 (如 sfx_tap) 太短，ebur128 测不出积分响度，所以显示 −70 LUFS，这是正常的。

## 循环说明

- 标为"循环"的文件做成了**采样级无缝**：
  - 事件尾巴折回开头；
  - LFO 和持续音都是整周期；
  - 混响做的是环形卷积。
- 循环长度取 1024 样本的整数倍，所以 AAC (m4a) 解码出来正好 N 个样本，末尾没有填充。
- 接缝放在信号最安静的位置；三种格式解码后，接缝跳变都不超过曲内 99.9 百分位的样本跳变 (自检逐个检查过)。
- `audio_manifest.json` 里循环文件的 `loopStart=0`、`loopEnd=duration`。用 WebAudio 时把这两个值设到 `AudioBufferSourceNode` 上，即使解码器多出几毫秒填充，也能保证无缝。
- **不要用 `<audio loop>`**：HTMLMediaElement 在循环点通常有几十毫秒空隙，尤其是 mp3 和 Safari。
- `bgm_ending_ch1` 不循环：45 s，在 41.2 s 处戛然而止，后面是静音。

## HTML5 / 手机加载建议

1. **用 WebAudio 解码**：`fetch → arrayBuffer → ctx.decodeAudioData`，再用 `AudioBufferSourceNode` 播放。
   - BGM 设 `loop=true`，loopStart/loopEnd 从 manifest 读。
   - 解码后的 PCM 很占内存：120 s 立体声约 42 MB (Float32)。建议只常驻当前房间的 BGM 和环境层，切房间时释放旧的 buffer。
2. **在首次触摸时解锁**：在 `pointerdown`/`touchend` 回调里创建或 `resume()` AudioContext。iOS 静音键会让 WebAudio 静音，属于系统行为。
3. **格式选择**：
   - 优先 m4a：iOS/Safari 必须用它，其他浏览器也都支持。
   - 其次 ogg：Chrome、Android、Firefox 支持；体积相近，开源格式。
   - mp3 兜底：兼容性最好，但部分解码器的 gapless 处理不一致，靠 loopEnd 保底。
   - 可用 `audio.canPlayType('audio/mp4; codecs="mp4a.40.2"')` 判断，也可以按顺序尝试解码，失败就换下一种格式。
   - manifest 里的 `formats_by_preference_ios_first` 就是这个顺序。
4. **预加载**：
   - 进入房间前预取该房间的 BGM 和环境层；
   - 音效都很小 (多数 <30 KB)，可在开场一次性解码；
   - 心烛低语层在理智降到 s1 时就提前解码。
5. **分层音量**：建立 master → bgmBus / ambBus / sfxBus 三个 GainNode，方便设置面板分别调节，也方便"闪避" (ducking)。

## 心烛 (理智) 下降：代码实现建议

清单要求：
- s2：叠加 `amb_whisper_low`，音量 30%。
- s3：叠加 `amb_whisper_near` (左右交替)，BGM 降 30 音分。
- 恢复时播 `sfx_sanity_restore`。

推荐的节点图：

```
bgmSrc ──► bgmFilter(BiquadFilter lowpass) ──► bgmGain ──► master
ambSrc ──► ambGain ──────────────────────────────────────► master
whisperLow  ──► wLowGain ────────────────────────────────► master
whisperNear ──► wNearPan(StereoPanner) ──► wNearGain ────► master
```

```js
const T = ctx.currentTime, ramp = (p, v, s = 1.5) => { p.cancelScheduledValues(T); p.setValueAtTime(p.value, T); p.linearRampToValueAtTime(v, T + s); };
const cents = c => Math.pow(2, c / 1200);

function applySanity(stage) {          // stage: 0 正常 / 1 / 2 / 3
  // 1) 低语层：两条循环一直挂着 (gain 0)，只改音量，避免重新起播时咔哒
  ramp(wLowGain.gain,  stage >= 2 ? 0.30 : 0);          // s2 起 30%
  ramp(wNearGain.gain, stage >= 3 ? 0.70 : 0, 2.5);     // s3 贴耳层
  // 2) 低通：理智越低越"闷"，像沉进水里
  const fc = [20000, 9000, 4000, 1800][stage];
  bgmFilter.frequency.cancelScheduledValues(T);
  bgmFilter.frequency.setValueAtTime(bgmFilter.frequency.value, T);
  bgmFilter.frequency.exponentialRampToValueAtTime(fc, T + 2);
  bgmFilter.Q.value = 0.7;
  // 3) 音高下沉：s3 时 BGM −30 音分。detune 更直观 (单位就是音分)；
  //    Safari 旧版本 detune 不可自动化，就改用 playbackRate = 2^(−30/1200) ≈ 0.98282
  const c = stage >= 3 ? -30 : stage === 2 ? -10 : 0;
  if (bgmSrc.detune) ramp(bgmSrc.detune, c, 3); else ramp(bgmSrc.playbackRate, cents(c), 3);
  // 4) 让出空间：低语层出现时 BGM 略降
  ramp(bgmGain.gain, [0.8, 0.75, 0.65, 0.55][stage]);
}

// s3 时让近耳低语左右交替 (文件本身已有左右交替，再加慢速自动声像更晃)
function wanderPan() { const t = ctx.currentTime; wNearPan.pan.setTargetAtTime(Math.random() < .5 ? -0.8 : 0.8, t, 0.6); setTimeout(wanderPan, 3000 + Math.random() * 4000); }

function restoreSanity() { playSfx('sfx_sanity_restore'); applySanity(0); }   // 反向渐变 2–3 秒
```

补充说明：
- 播放速率变了，循环时长也会随之变化，但 loopStart/loopEnd 用的是 buffer 时间，所以不受影响。
- 环境层可以同步降低 3 dB，并套同一个低通。
- 可以再加一点"不稳定"：s3 时用 0.1 Hz、±8 音分的随机 LFO 去晃 detune，模拟微分音漂移。
- 清单里"偶尔说出刚检视物品的名字"做不进静态文件 (见下)。建议做法：
  - 在检视物品的回调里，以低概率播放该物品的名字语音，加 StereoPanner ±0.9、混响或低通，音量 0.4；
  - 名字语音需要另行录制或用 TTS 生成。

## 自检

运行 `python3 src/generate.py --check`，逐个文件解码三种格式，检查以下项目，结果写入 `src/check_report.json`：
- 时长；
- 峰值 (BGM ≤ −3、SFX ≤ −1 dBFS)；
- NaN 和削波；
- 循环接缝跳变；
- 三种格式样本数一致，且是 1024 的整数倍；
- 非循环文件尾部归零；
- 积分响度。

当前全部通过。

## 未完成 / 只能占位的项

- **`bgm_ending_ch1` 里"主角嗓音说出『埃德里克』"**：现在用共振峰合成近似 "Ed-ric" 的音节轮廓，只是占位，听不出真实的字词，更不是主角本人的声音。正式版需要录主角配音，再按本曲时间轴替换 (呼唤点见 generate.py)。
- **`amb_whisper_near`"偶尔说出刚检视物品的名字"**：静态音频做不到动态内容。文件里是不可辨词的贴耳低语；名字要在运行时触发 (见上节)，需要录音或 TTS。
- **角色语音占位 (vo_*)**：全部是共振峰合成的非语言音 (嗯?、冷哼、倒吸气、抽泣、冷笑、崩溃笑)，辨识度有限。建议以后换成真人配音。
- **清单写的是"OGG + MP3"**：本包另外给了 m4a，因为 iOS Safari 不能解码 Vorbis。用不到可以删掉。
- **30–60 Hz sub 在手机外放上基本听不到**：已加了谐波，让外放也能"感觉到"低频；建议用耳机体验。
- **Safari 上 m4a/mp3 的 gapless 解码没有在真机验证过**：靠 manifest 的 loopEnd 保底。

## 重新生成

```
cd audio/src && python3 generate.py            # 全部 (约 3–4 分钟)，并清理清单之外的旧文件、自检
python3 generate.py --only sfx_pickup bgm_title
python3 generate.py --check
```

依赖：python3 + numpy，以及带 libvorbis/libmp3lame 的 ffmpeg。每个条目的随机种子固定，结果可以复现。
