// WebAudio 音频（按 audio/README.md 的接入建议实现；不用 <audio loop>）。
//   节点图：bgmSrc → bgmFilter(lowpass) → bgmGain → bgmBus ┐
//           ambSrc → ambFilter(lowpass) → ambGain → ambBus ┤
//           whisperLow → wLowGain ─────────────────────────┤→ master → destination
//           whisperNear → wNearPan → wNearGain ────────────┤
//           sfx → sfxBus ──────────────────────────────────┘
//   循环：AudioBufferSourceNode.loop=true，loopStart/loopEnd 取 audio_manifest.json。
//   格式：manifest.formats_by_preference_ios_first（m4a → ogg → mp3），解码失败自动换下一种。
//   解锁：首次 pointerdown/touchend 时创建/resume AudioContext（unlock()）。
//   心烛：setSanityStage(0–3) → 低语层音量、BGM/环境低通、BGM detune（s3 −30 音分 + ±8 音分漂移）、BGM 让位。
// 统一接口：sfx(id)/bgm(id)/amb(id)，并保留 playSfx/playBgm/playAmb 别名（旧代码/他人代码兼容）。
// 任何失败（无 AudioContext、文件缺失、解码失败）都静默降级。
import { resolveAudio } from './asset-names.js';

const AUDIO_BASE = '../audio/';
/** audio/README.md「建议音量」 */
export const SUGGESTED_GAIN = {
  bgm_title: 0.8, bgm_r1_hall: 0.8, bgm_r2_scriptorium: 0.7, bgm_r3_crypt: 0.8, bgm_interrogation: 0.8, bgm_clueboard: 0.7, bgm_ending_ch1: 1.0,
  amb_hall_fire: 0.6, amb_tower_wind: 0.6, amb_crypt_drip: 0.6,
  stinger_contradiction: 0.9, stinger_deduction: 0.9, sfx_pickup: 0.8, sfx_combine_success: 0.9, sfx_combine_fail: 0.8, sfx_item_use: 0.9,
  sfx_stone_sink: 1.0, sfx_crest_rotate: 0.9, sfx_dial_click: 0.7, sfx_box_open: 0.9, sfx_page_turn: 0.8, sfx_charcoal_reveal: 0.9,
  sfx_crow: 0.8, sfx_window_wind: 0.9, sfx_candle_light: 0.8, sfx_candle_out: 0.8, sfx_winch_chain: 0.9, sfx_well_cover: 1.0,
  sfx_clue_connect: 0.8, sfx_clue_fail: 0.8, sfx_testimony_flip: 0.7, sfx_wrong: 0.8, sfx_tap: 0.6, sfx_sanity_restore: 0.9,
};
/** 心烛阶段参数（README 推荐值）：0 正常 / 1 轻微 / 2 不安(s2) / 3 动摇(s3) */
export const SANITY_STAGE = [
  { lowpass: 20000, cents: 0, bgmGain: 1.0, wLow: 0, wNear: 0 },
  { lowpass: 9000, cents: 0, bgmGain: 0.94, wLow: 0, wNear: 0 },
  { lowpass: 4000, cents: -10, bgmGain: 0.81, wLow: 0.30, wNear: 0 },
  { lowpass: 1800, cents: -30, bgmGain: 0.69, wLow: 0.30, wNear: 0.70 },
];
const WHISPER = { low: 'amb_whisper_low', near: 'amb_whisper_near' };
const MIME = { m4a: 'audio/mp4; codecs="mp4a.40.2"', ogg: 'audio/ogg; codecs="vorbis"', mp3: 'audio/mpeg' };
function playableFormats() {
  let probe = null;
  try { probe = typeof Audio !== 'undefined' ? new Audio() : null; } catch { /* ignore */ }
  return (f) => { const ext = f.split('.').pop().toLowerCase(); return !probe || !MIME[ext] || probe.canPlayType(MIME[ext]) !== ''; };
}
const cents = (c) => Math.pow(2, c / 1200);

export class AudioManager {
  constructor({ files = [], manifest = null, alias = {}, muted = false } = {}) {
    this.files = files; this.manifest = manifest; this.alias = alias;
    this.ctx = null; this.master = null; this.muted = muted;
    this.buffers = new Map();  // id → Promise<AudioBuffer|null>
    this.layers = { bgm: null, amb: null };       // {id, src, gain}
    this.wanted = { bgm: null, amb: null };
    this.stage = 0; this.detuneNow = 0;
    this.missing = new Set();
    this.log = [];             // 最近播放记录（测试/调试用）
  }
  get available() { return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext); }

  /** 首次手势里调用（iOS/Chrome 自动播放策略）；可重复调用 */
  unlock() {
    if (!this.available) return;
    try {
      if (!this.ctx) this._build();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch { this.ctx = null; }
  }
  _build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC());
    const gain = (v, to) => { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
    this.master = gain(this.muted ? 0 : 1, ctx.destination);
    this.bus = { bgm: gain(1, this.master), amb: gain(1, this.master), sfx: gain(1, this.master) };
    const lp = (to) => { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 20000; f.Q.value = 0.7; f.connect(to); return f; };
    this.bgmStageGain = gain(1, this.bus.bgm); this.bgmFilter = lp(this.bgmStageGain);
    this.ambStageGain = gain(1, this.bus.amb); this.ambFilter = lp(this.ambStageGain);
    this.wLowGain = gain(0, this.master);
    this.wNearGain = gain(0, this.master);
    this.wNearPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this.wNearPan) this.wNearPan.connect(this.wNearGain);
    for (const k of Object.keys(this.wanted)) if (this.wanted[k]) this._startLayer(k, this.wanted[k]);
    // 音效很小，开场一次性解码
    for (const id of Object.keys(this.manifest?.files || {})) if (/^(sfx|stinger)_/.test(id)) this._buffer(id);
    this.setSanityStage(this.stage, { immediate: true });
  }

  setMuted(m) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05);
  }
  setBusVolume(bus, v) { if (this.bus?.[bus]) this.bus[bus].gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

  resolveId(id) { return this.manifest?.files?.[id] ? id : (this.alias[id] && this.manifest?.files?.[this.alias[id]] ? this.alias[id] : id); }
  /** 候选文件：m4a → ogg → mp3；浏览器明确不支持的格式（canPlayType 为空）排到最后，仍保留作解码兜底 */
  candidates(id) {
    const list = resolveAudio(id, { manifest: this.manifest, files: this.files, alias: this.alias });
    const ok = this._playable ??= playableFormats();
    return [...list.filter((f) => ok(f)), ...list.filter((f) => !ok(f))];
  }
  has(id) { return this.candidates(id).length > 0; }
  entry(id) { return this.manifest?.files?.[this.resolveId(id)] ?? null; }

  _buffer(id) {
    if (!this.ctx) return Promise.resolve(null);
    if (this.buffers.has(id)) return this.buffers.get(id);
    const p = (async () => {
      for (const rel of this.candidates(id)) {   // m4a → ogg → mp3
        try {
          const res = await fetch(AUDIO_BASE + rel);
          if (!res.ok) continue;
          const data = await res.arrayBuffer();
          const buf = await new Promise((ok, bad) => this.ctx.decodeAudioData(data, ok, bad));
          if (buf) return buf;
        } catch { /* 换下一种格式 */ }
      }
      this.missing.add(id);
      return null;
    })();
    this.buffers.set(id, p);
    return p;
  }
  /** 预取（进房间前取 BGM/环境层；理智到 s1 下沿时预解码低语层） */
  preload(ids) { for (const id of ids) if (id) this._buffer(id); }

  sfx(id, { volume, pan = 0 } = {}) {
    if (!id) return;
    this.log.push(['sfx', id]); if (this.log.length > 50) this.log.shift();
    if (!this.ctx || this.muted) return;
    const v = volume ?? SUGGESTED_GAIN[this.resolveId(id)] ?? 0.8;
    this._buffer(id).then((buf) => {
      if (!buf || !this.ctx) return;
      try {
        const src = this.ctx.createBufferSource(); src.buffer = buf;
        let node = src;
        if (pan && this.ctx.createStereoPanner) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
        const g = this.ctx.createGain(); g.gain.value = v;
        node.connect(g).connect(this.bus.sfx); src.start();
      } catch { /* ignore */ }
    });
  }

  /** 循环层 bgm / amb：id=null 停止；同 id 不重启。非循环条目（bgm_ending_ch1）只播一次 */
  setLayer(layer, id, { volume, fade = 1.2 } = {}) {
    if (this.wanted[layer] === id) return;
    this.wanted[layer] = id;
    this.log.push([layer, id]);
    if (!this.ctx) return;
    this._stopLayer(layer, fade);
    if (id) this._startLayer(layer, id, volume, fade);
  }
  bgm(id, o) { this.setLayer('bgm', id, o); }
  amb(id, o) { this.setLayer('amb', id, o); }
  // 兼容别名
  playSfx(id, o) { this.sfx(id, o); }
  playBgm(id, o) { this.bgm(id, o); }
  playAmb(id, o) { this.amb(id, o); }
  stopBgm() { this.bgm(null); }

  _stopLayer(layer, fade = 1) {
    const L = this.layers[layer];
    if (!L) return;
    this.layers[layer] = null;
    try {
      const t = this.ctx.currentTime;
      L.gain.gain.cancelScheduledValues(t);
      L.gain.gain.setValueAtTime(L.gain.gain.value, t);
      L.gain.gain.linearRampToValueAtTime(0, t + fade);
      L.src.stop(t + fade + 0.05);
    } catch { /* ignore */ }
    // README：解码后的 PCM 很占内存，只常驻当前 BGM/环境层
    setTimeout(() => { if (this.wanted.bgm !== L.id && this.wanted.amb !== L.id) this.buffers.delete(L.id); }, (fade + 0.2) * 1000);
  }
  _loopSource(buf, id, loop = true) {
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const e = this.entry(id);
    src.loop = loop && (e ? e.loop !== false : true);
    if (src.loop && e?.loopEnd) { src.loopStart = e.loopStart || 0; src.loopEnd = Math.min(e.loopEnd, buf.duration); }
    return src;
  }
  _startLayer(layer, id, volume, fade = 1.2) {
    this._buffer(id).then((buf) => {
      if (!buf || !this.ctx || this.wanted[layer] !== id || this.layers[layer]?.id === id) return;
      try {
        const src = this._loopSource(buf, id);
        const v = volume ?? SUGGESTED_GAIN[this.resolveId(id)] ?? (layer === 'bgm' ? 0.8 : 0.6);
        const g = this.ctx.createGain(); g.gain.value = 0;
        src.connect(g).connect(layer === 'bgm' ? this.bgmFilter : this.ambFilter);
        if (layer === 'bgm') this._setDetune(src, this.detuneNow, 0);
        src.start();
        g.gain.linearRampToValueAtTime(v, this.ctx.currentTime + fade);
        this.layers[layer] = { id, src, gain: g };
      } catch { /* ignore */ }
    });
  }
  _setDetune(src, c, secs = 3) {
    const t = this.ctx.currentTime;
    const p = src.detune ?? src.playbackRate, v = src.detune ? c : cents(c);
    try { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(v, t + secs); } catch { p.value = v; }
  }
  _whisperLayer(key, gainNode, input) {
    // 两条低语循环一直挂着（gain 0），只改音量，避免重新起播的咔哒
    if (this[`_w_${key}`]) return;
    this[`_w_${key}`] = true;
    this._buffer(WHISPER[key]).then((buf) => {
      if (!buf || !this.ctx) return;
      try { const src = this._loopSource(buf, WHISPER[key]); src.connect(input ?? gainNode); src.start(); } catch { /* ignore */ }
    });
  }

  /** 心烛阶段：0 正常 / 1 轻微（s1 下半）/ 2 不安 s2 / 3 动摇 s3 */
  setSanityStage(stage, { immediate = false } = {}) {
    const prev = this.stage;
    this.stage = Math.max(0, Math.min(3, stage | 0));
    if (!this.ctx || (this.stage === prev && !immediate)) return; // 同档重复调用不重启渐变
    const P = SANITY_STAGE[this.stage], T = this.ctx.currentTime, s = immediate ? 0.01 : 1.5;
    const ramp = (p, v, secs = s) => { p.cancelScheduledValues(T); p.setValueAtTime(p.value, T); p.linearRampToValueAtTime(v, T + secs); };
    if (this.stage >= 1) this._whisperLayer('low', this.wLowGain);           // 提前解码
    if (this.stage >= 2) this._whisperLayer('near', this.wNearGain, this.wNearPan ?? this.wNearGain);
    ramp(this.wLowGain.gain, P.wLow);
    ramp(this.wNearGain.gain, P.wNear, immediate ? 0.01 : 2.5);
    for (const f of [this.bgmFilter, this.ambFilter]) {
      f.frequency.cancelScheduledValues(T); f.frequency.setValueAtTime(f.frequency.value, T);
      f.frequency.exponentialRampToValueAtTime(P.lowpass, T + (immediate ? 0.01 : 2));
    }
    ramp(this.bgmStageGain.gain, P.bgmGain);
    ramp(this.ambStageGain.gain, this.stage >= 3 ? 0.71 : 1); // 环境层同步降 3 dB
    this.detuneNow = P.cents;
    if (this.layers.bgm) this._setDetune(this.layers.bgm.src, P.cents, immediate ? 0.01 : 3);
    if (this.stage >= 3 && prev < 3) this._wander();
  }
  /** s3：近耳低语慢速左右游走 + BGM ±8 音分随机漂移（微分音） */
  _wander() {
    if (!this.ctx || this.stage < 3) return;
    const t = this.ctx.currentTime;
    this.wNearPan?.pan.setTargetAtTime(Math.random() < 0.5 ? -0.8 : 0.8, t, 0.6);
    if (this.layers.bgm) this._setDetune(this.layers.bgm.src, SANITY_STAGE[3].cents + (Math.random() * 16 - 8), 4);
    clearTimeout(this._wanderT);
    this._wanderT = setTimeout(() => this._wander(), 3000 + Math.random() * 4000);
  }
  /** 心烛恢复：播 sfx_sanity_restore，阶段由调用方按新理智值设置（反向渐变 2–3 秒） */
  restoreFx() { this.sfx('sfx_sanity_restore'); }
  /** 测试/调试：当前状态快照 */
  debugState() {
    return { unlocked: !!this.ctx, state: this.ctx?.state, stage: this.stage, bgm: this.layers.bgm?.id ?? null, amb: this.layers.amb?.id ?? null,
      wanted: { ...this.wanted }, lowpass: this.bgmFilter?.frequency.value, detune: this.layers.bgm?.src.detune?.value, missing: [...this.missing], log: this.log.slice(-12) };
  }
}
