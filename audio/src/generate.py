#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
《缄默堡》第一章 —— 原创程序化音频生成脚本 (克苏鲁 × 中世纪 × 家族)
按 design/05_音乐音效清单.md 逐项生成。只依赖 numpy + ffmpeg (libvorbis / aac / libmp3lame)。
所有声音均为代码合成，无任何采样或第三方素材，无任何既有作品旋律。

用法:
  python3 generate.py                       # 生成全部 + 自检 + 写 audio_manifest.json
  python3 generate.py --only sfx_tap bgm_r1_hall
  python3 generate.py --check               # 只自检已导出的文件
输出: ../bgm/ ../amb/ ../sfx/ ../vo/  每项 .ogg + .m4a + .mp3
"""
import argparse, json, os, subprocess, sys, tempfile
import numpy as np

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..'))

# ---- 导出参数（可调） ----
LONG_PEAK_DB = -4.0     # BGM/环境声 编码前峰值上限；有损编码后仍应 <= -3 dBFS
SFX_PEAK_DB = -2.0      # 音效编码前峰值；编码后应 <= -1 dBFS
LONG_OGG_Q = 3          # Vorbis q3 ≈ 96-112 kbps 立体声
LONG_AAC = '96k'
LONG_MP3 = ['-q:a', '6']          # LAME VBR V6 ≈ 100-120 kbps
SFX_OGG_Q = 4
SFX_AAC = {1: '64k', 2: '96k'}
SFX_MP3 = {1: ['-b:a', '64k'], 2: ['-b:a', '112k']}
FORMATS = ('ogg', 'm4a', 'mp3')

def loop_n(sec):
    """循环长度取 1024 的整数倍采样：AAC 帧对齐 → m4a 解码后无尾部填充，loop 真正无缝。"""
    return int(round(sec * SR / 1024)) * 1024

# ============================================================ 基础工具
def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)

def db(x):
    return 10 ** (x / 20.0)

def tvec(n):
    return np.arange(n) / SR

def smooth_noise(n, rate, rng, periodic=False):
    """低频随机曲线 (约 rate Hz 的控制点 + 余弦插值)，范围约 [-1,1]。"""
    k = max(2, int(n / SR * rate) + 2)
    pts = rng.uniform(-1, 1, k)
    if periodic:
        pts[-1] = pts[0]
    x = np.linspace(0, k - 1, n, endpoint=not periodic) if not periodic else np.arange(n) * (k - 1) / n
    i = np.floor(x).astype(int); i = np.minimum(i, k - 2)
    f = x - i
    f = (1 - np.cos(np.pi * f)) / 2
    return pts[i] * (1 - f) + pts[i + 1] * f

def fft_filter(x, lo=None, hi=None, order=2, circular=False):
    """零相位频域滤波 (Butterworth 型幅度)。circular=True 时首尾环绕连续 (用于循环)。"""
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[-1]
    N = n if circular else int(2 ** np.ceil(np.log2(n + SR // 4)))
    X = np.fft.rfft(x, n=N, axis=-1)
    f = np.fft.rfftfreq(N, 1 / SR)
    g = np.ones_like(f)
    if hi is not None:
        g *= 1 / np.sqrt(1 + (f / hi) ** (2 * order))
    if lo is not None:
        with np.errstate(divide='ignore'):
            g *= 1 / np.sqrt(1 + (lo / np.maximum(f, 1e-6)) ** (2 * order))
    y = np.fft.irfft(X * g, n=N, axis=-1)
    return y[..., :n]

def conv(x, ir, circular=False):
    n = x.shape[-1]
    if circular:
        assert len(ir) <= n
        return np.fft.irfft(np.fft.rfft(x, n=n) * np.fft.rfft(ir, n=n), n=n)
    N = int(2 ** np.ceil(np.log2(n + len(ir))))
    y = np.fft.irfft(np.fft.rfft(x, n=N) * np.fft.rfft(ir, n=N), n=N)
    return y[:n + len(ir) - 1]

def make_ir(rng, seconds=4.0, t60=3.0, dark=1.0, predelay=0.02, early=True):
    """合成房间/石室混响冲激响应：分频段指数衰减噪声 + 早期反射。"""
    n = int(seconds * SR); t = tvec(n)
    nz = rng.standard_normal(n)
    lo = fft_filter(nz, hi=600)
    mid = fft_filter(nz, lo=600, hi=3500)
    hi_ = fft_filter(nz, lo=3500)
    ir = (lo * np.exp(-6.9 * t / t60)
          + 0.8 * mid * np.exp(-6.9 * t / (t60 * 0.7))
          + 0.4 / dark * hi_ * np.exp(-6.9 * t / (t60 * 0.3 / dark)))
    ir *= np.minimum(1, t / 0.03)  # 柔和起始
    pd = int(predelay * SR)
    ir = np.concatenate([np.zeros(pd), ir])[:n]
    if early:
        for d, a in [(0.011, .5), (0.019, .35), (0.027, .3), (0.041, .25), (0.053, .2), (0.067, .15)]:
            k = int((d + predelay * 0.3) * SR)
            if k < n:
                ir[k] += a * rng.choice([-1, 1]) * 6
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-12
    return ir

def place(buf, start_s, sig, loop):
    """把 sig 叠加到 buf (可为 (2,L))，loop=True 时尾巴环绕回开头 = 无缝循环。"""
    L = buf.shape[-1]
    pos = int(round(start_s * SR))
    if loop:
        pos %= L
        i = 0; n = sig.shape[-1]
        while i < n:
            k = min(L - pos, n - i)
            buf[..., pos:pos + k] += sig[..., i:i + k]
            i += k; pos = 0
    else:
        if pos >= L: return
        k = min(L - pos, sig.shape[-1])
        buf[..., pos:pos + k] += sig[..., :k]

def pan2(sig, p):
    """p: -1 左 .. +1 右，等功率。"""
    a = (p + 1) * np.pi / 4
    return np.stack([sig * np.cos(a), sig * np.sin(a)])

def periodic_phase(freq):
    """对频率曲线积分得到相位，并微调使整段恰好为整数周期 (循环无缝)。"""
    ph = np.cumsum(freq) / SR
    total = ph[-1] + freq[0] / SR
    scale = max(1, round(total)) / total
    return 2 * np.pi * (ph - freq[0] / SR) * scale

def lfo(n, cycles, phase=0.0):
    """在 n 个采样内恰好 cycles 个周期的正弦 (循环安全)。"""
    return np.sin(2 * np.pi * cycles * np.arange(n) / n + phase)

def env_ar(n, att, rel, curve=2.0):
    e = np.ones(n)
    a = int(att * SR); r = int(rel * SR)
    if a > 0: e[:a] = np.linspace(0, 1, a) ** curve
    if r > 0: e[-r:] *= np.linspace(1, 0, r) ** curve
    return e

def fade_edges(x, fin=0.002, fout=0.02):
    n = x.shape[-1]
    a = int(fin * SR); b = int(fout * SR)
    if a: x[..., :a] *= np.linspace(0, 1, a)
    if b: x[..., -b:] *= (np.cos(np.linspace(0, np.pi, b)) + 1) / 2
    return x

# ============================================================ 乐器
def lute(f, dur, rng, bright=0.45, t60=2.2, pos=0.18, body_amt=0.08):
    """鲁特琴：Karplus-Strong 拨弦 (按周期块向量化) + 琴体共鸣。"""
    n = int(dur * SR)
    N = max(2, int(round(SR / f - 0.5)))
    exc = rng.uniform(-1, 1, N + 1)
    # 拨弦位置梳状 + 低通 (暗一点的羊肠弦)
    exc = exc - np.roll(exc, max(1, int(N * pos)))
    for _ in range(int(1 + (1 - bright) * 4)):
        exc = 0.5 * (exc + np.roll(exc, 1))
    exc -= exc.mean()
    y = np.zeros(n + N + 1)
    y[:N + 1] = exc
    g = 10 ** (-3 / (t60 * f))
    b = N + 1
    while b < len(y):
        e = min(b + N, len(y))
        y[b:e] = g * 0.5 * (y[b - N:e - N] + y[b - N - 1:e - N - 1])
        b = e
    y = y[N + 1:]
    # 琴体：几个低 Q 共振 (模态)
    t = tvec(int(0.25 * SR))
    body = sum(a * np.exp(-t / d) * np.sin(2 * np.pi * fr * t)
               for fr, d, a in [(115, .05, 1), (240, .035, .7), (430, .02, .5), (980, .01, .3)])
    y = y + body_amt * conv(y, body)[:n]
    y = fade_edges(y / (np.max(np.abs(y)) + 1e-9), 0.001, 0.05)
    return y

def bowed(f, dur, rng, att=0.5, rel=1.0, rough=0.25, vib_cents=7, drift=None,
          formants=((280, 1.0, .5), (900, .8, .35), (2500, .5, .3)), maxf=6000, bow_noise=0.04):
    """古大提琴 (viola da gamba 式)：加法合成锯齿 + 鼻音共振峰 + 弓噪 + 粗糙抖动。
    drift: 可选函数 t->音分，用于微分音走音。"""
    n = int(dur * SR); t = tvec(n)
    cents = (vib_cents * np.sin(2 * np.pi * rng.uniform(4.5, 5.5) * t + rng.uniform(0, 6))
             * np.minimum(1, t / 1.2) + 6 * smooth_noise(n, 1.5, rng))
    if drift is not None:
        cents = cents + drift(t)
    fr = f * 2 ** (cents / 1200)
    ph = 2 * np.pi * np.cumsum(fr) / SR
    sig = np.zeros(n)
    H = int(min(48, maxf / f))
    for h in range(1, H + 1):
        hf = h * f
        w = 0.25 + sum(a * np.exp(-0.5 * (np.log(hf / fc) / bw) ** 2) for fc, a, bw in formants)
        sig += (w / h ** 0.9) * np.sin(h * ph + rng.uniform(0, 2 * np.pi))
    sig /= np.max(np.abs(sig)) + 1e-9
    # 粗糙：弓压颤动
    sig *= 1 + rough * smooth_noise(n, 35, rng)
    nz = fft_filter(rng.standard_normal(n), lo=1200, hi=5000)
    sig += bow_noise * nz / (np.std(nz) + 1e-9) * (0.5 + 0.5 * smooth_noise(n, 8, rng) ** 2)
    e = env_ar(n, att, rel, 1.6) * (1 + 0.15 * smooth_noise(n, 0.4, rng))
    return sig * e

VOWELS = {  # 男声共振峰 (Hz) 与相对幅度
    'u': [(300, 1.0, 70), (870, .35, 90), (2240, .06, 120)],
    'o': [(500, 1.0, 80), (800, .6, 90), (2450, .08, 120)],
    'a': [(700, 1.0, 90), (1100, .7, 100), (2500, .12, 130)],
    'e': [(480, 1.0, 80), (1720, .45, 100), (2520, .15, 120)],
    'i': [(290, 1.0, 60), (2250, .3, 100), (2950, .2, 120)],
    'm': [(250, 1.0, 60), (1100, .05, 150), (2300, .02, 200)],   # 闭口鼻音哼
    'r': [(480, 1.0, 80), (1300, .4, 100), (1650, .3, 100)],
    'l': [(360, 1.0, 70), (1250, .3, 100), (2650, .1, 120)],
}

def chant(f, dur, rng, v0='u', v1='a', att=2.0, rel=3.0, voices=2, detune=7, drift=None, breath=0.03):
    """圣咏低吟：共振峰加法合成男声 'oo→ah'，多声部轻微失谐。"""
    n = int(dur * SR); t = tvec(n)
    ctrl = 512
    tc = np.arange(0, n + ctrl, ctrl) / SR
    blend = np.clip(tc / max(dur * 0.6, 0.1), 0, 1)
    blend = (1 - np.cos(np.pi * blend)) / 2
    out = np.zeros(n)
    for v in range(voices):
        cents = (rng.uniform(-detune, detune) + 9 * np.sin(2 * np.pi * rng.uniform(4.6, 5.6) * t + rng.uniform(0, 6))
                 * np.minimum(1, t / 2.5) + 8 * smooth_noise(n, 0.7, rng))
        if drift is not None:
            cents = cents + drift(t)
        fr = f * 2 ** (cents / 1200)
        ph = 2 * np.pi * np.cumsum(fr) / SR
        H = int(3600 / f)
        for h in range(1, H + 1):
            hf = h * f
            amp_c = np.zeros_like(tc)
            for (F0, A0, B0), (F1, A1, B1) in zip(VOWELS[v0], VOWELS[v1]):
                F = F0 + (F1 - F0) * blend; A = A0 + (A1 - A0) * blend; B = B0 + (B1 - B0) * blend
                amp_c += A / (1 + ((hf - F) / B) ** 2)
            amp_c *= 1 / h ** 0.6
            amp = np.interp(t, tc, amp_c)
            out += amp * np.sin(h * ph + rng.uniform(0, 2 * np.pi))
    out /= np.max(np.abs(out)) + 1e-9
    nz = fft_filter(rng.standard_normal(n), lo=600, hi=2500)
    out += breath * nz / (np.std(nz) + 1e-9)
    return out * env_ar(n, att, rel, 1.5)

def bell(f, dur, rng, bright=1.0, strike=0.3):
    """教堂钟：非和谐泛音 (hum/prime/小三度 tierce/quint/nominal...) + 拍频成对分音。"""
    n = int(dur * SR); t = tvec(n)
    parts = [(0.5, 1.0, 9.0), (1.0, .8, 6.0), (1.19, .7, 4.5), (1.505, .35, 3.0), (2.0, .6, 3.5),
             (2.51, .25, 1.8), (2.66, .3, 1.5), (3.01, .18, 1.2), (4.07, .12, .8), (5.2, .07, .5), (6.35, .05, .35)]
    y = np.zeros(n)
    for r, a, d in parts:
        if f * r > 9000: continue
        a = a * (bright if r > 2.2 else 1)
        beat = rng.uniform(0.3, 1.6)
        for s in (-1, 1):
            y += a * 0.5 * np.exp(-t / d) * np.sin(2 * np.pi * f * r * (1 + s * beat / (2 * f * r) * 0 ) * t
                                                  + s * np.pi * beat * t + rng.uniform(0, 6))
    k = int(0.02 * SR)
    hit = fft_filter(rng.standard_normal(k), lo=800, hi=5000) * np.exp(-tvec(k) / 0.004)
    y[:k] += strike * hit / (np.max(np.abs(hit)) + 1e-9)
    y /= np.max(np.abs(y)) + 1e-9
    return fade_edges(y, 0.0005, 0.3)

def music_box(f, rng, dur=3.0, detune_cents=None, sag=-25):
    """走调八音盒：梳齿非和谐泛音 + 随机失谐 + 发条疲软的下垂音高。"""
    n = int(dur * SR); t = tvec(n)
    c = rng.uniform(-35, 35) if detune_cents is None else detune_cents
    cents = c + sag * (1 - np.exp(-t / 0.8)) + 4 * np.sin(2 * np.pi * 5.5 * t)
    ph = 2 * np.pi * np.cumsum(f * 2 ** (cents / 1200)) / SR
    y = (np.exp(-t / 1.1) * np.sin(ph) + 0.25 * np.exp(-t / 0.25) * np.sin(5.4 * ph + 1)
         + 0.08 * np.exp(-t / 0.06) * np.sin(13.3 * ph + 2))
    k = int(0.004 * SR)
    y[:k] += 0.3 * rng.uniform(-1, 1, k) * np.linspace(1, 0, k)
    return fade_edges(y / np.max(np.abs(y)), 0.0005, 0.2)

def tick(rng, f=2100, dur=0.12):
    """钟摆滴答：小木块/金属擒纵的模态敲击。"""
    n = int(dur * SR); t = tvec(n)
    y = (np.exp(-t / .012) * np.sin(2 * np.pi * f * t) + .5 * np.exp(-t / .006) * np.sin(2 * np.pi * f * 2.31 * t)
         + .4 * np.exp(-t / .02) * np.sin(2 * np.pi * f * .43 * t))
    k = int(0.003 * SR)
    y[:k] += 0.6 * rng.uniform(-1, 1, k)
    return fade_edges(y / np.max(np.abs(y)), 0.0003, 0.02)

def water_drop(f, rng, dur=0.35):
    n = int(dur * SR); t = tvec(n)
    fr = f * (1 + 0.9 * (1 - np.exp(-t / 0.015)))
    y = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / 0.045) * np.minimum(1, t / 0.0015)
    y += 0.15 * np.sin(2 * np.pi * f * 0.5 * t) * np.exp(-t / 0.02)
    return fade_edges(y, 0.0005, 0.03)

# ============================================================ 混音总线
class Mix:
    def __init__(self, seconds, loop, rng, n=None):
        self.L = n if n is not None else int(round(seconds * SR)); self.loop = loop; self.rng = rng
        self.dry = np.zeros((2, self.L)); self.send = np.zeros(self.L)
        self.deep = np.zeros((2, self.L))   # 水下闷滤波组
    def add(self, t, sig, gain=1.0, pan=0.0, rev=0.3, deep=False):
        s = pan2(sig * gain, pan)
        tgt = self.deep if deep else self.dry
        place(tgt, t, s * (1 - rev * 0.5), self.loop)
        mono = np.zeros(self.L); place(mono, t, sig * gain * rev, self.loop); self.send += mono
    def render(self, irL, irR, wet=0.6, deep_lfo_cycles=2, deep_lo=280, deep_hi=1400):
        out = self.dry.copy()
        if np.any(self.deep):
            dark = fft_filter(self.deep, hi=deep_lo, order=2, circular=self.loop)
            mid = fft_filter(self.deep, hi=deep_hi, order=2, circular=self.loop)
            w = 0.5 + 0.5 * lfo(self.L, deep_lfo_cycles) if self.loop else np.linspace(0, 1, self.L)
            out += dark * w + mid * (1 - w)
            # 水下组也送混响
            self.send += 0.5 * (dark[0] + dark[1]) * 0.5
        if self.loop:
            wl = conv(self.send, irL, True); wr = conv(self.send, irR, True)
        else:
            wl = conv(self.send, irL)[:self.L]; wr = conv(self.send, irR)[:self.L]
        out += wet * np.stack([wl, wr])
        return out

# ============================================================ 人声 / 低语 / 其他音源
def _formant_env(freqs, keys_t, keys_v, tq, fscale=1.0, bw_mul=1.0):
    """在时间 tq 处、频率 freqs 上的共振峰包络 (各关键帧元音线性插值)。"""
    env = 0.0
    for i in range(3):
        F = np.interp(tq, keys_t, [VOWELS[v][i][0] for v in keys_v]) * fscale
        A = np.interp(tq, keys_t, [VOWELS[v][i][1] for v in keys_v])
        B = np.interp(tq, keys_t, [VOWELS[v][i][2] for v in keys_v]) * bw_mul
        env = env + A / (1 + ((freqs - F) / B) ** 2)
    return env

def formant_noise(n, keys, rng, fscale=1.0, bw_mul=2.5, sib=0.0):
    """噪声经随时间变化的共振峰 (STFT 重叠相加) → 气声/耳语。"""
    kt = [k[0] for k in keys]; kv = [k[1] for k in keys]
    W = 1024; hop = 512; win = np.hanning(W)
    nz = rng.standard_normal(n + W)
    out = np.zeros(n + W)
    fr = np.fft.rfftfreq(W, 1 / SR)
    sib_shape = np.exp(-0.5 * ((fr - 5500) / 1800) ** 2)
    for s0 in range(0, n, hop):
        env = _formant_env(fr, kt, kv, s0 / SR, fscale, bw_mul) + 0.02
        s = sib[min(s0, len(sib) - 1)] if np.ndim(sib) else sib
        X = np.fft.rfft(nz[s0:s0 + W] * win) * (env + s * sib_shape)
        out[s0:s0 + W] += np.fft.irfft(X, n=W) * win
    out = out[:n]
    return out / (np.std(out) + 1e-9)

def vox(n, f, keys, amp, rng, breath=0.0, voiced=1.0, fscale=1.0, hmax=4200, jitter=6):
    """共振峰加法人声：f 为每采样基频数组，keys=[(秒, 元音)]，amp 为振幅包络数组。"""
    t = tvec(n)
    f = np.asarray(f, dtype=float) * 2 ** (jitter * smooth_noise(n, 12, rng) / 1200)
    ph = 2 * np.pi * np.cumsum(f) / SR
    kt = [k[0] for k in keys]; kv = [k[1] for k in keys]
    ctrl = 256; ic = np.arange(0, n, ctrl); tc = ic / SR
    fc = f[ic]
    out = np.zeros(n)
    if voiced:
        H = int(min(70, hmax / max(np.min(f), 40)))
        for h in range(1, H + 1):
            hf = h * fc
            a = _formant_env(hf, kt, kv, tc, fscale) / h ** 0.6 * (hf < hmax)
            if np.max(a) < 1e-4: continue
            out += np.interp(t, tc, a) * np.sin(h * ph + rng.uniform(0, 6.28))
        out = out / (np.max(np.abs(out)) + 1e-9) * voiced
    if np.any(np.asarray(breath) > 0):
        out = out + 0.35 * np.asarray(breath) * formant_noise(n, keys, rng, fscale)
    return out * amp

def whisper(dur, rng, rate=7.0, fscale=1.0, sib=0.5, gap=0.25):
    """听不清的低语短句：随机元音音节 + 齿擦音，带词间停顿。"""
    n = int(dur * SR)
    keys = []; t = 0.0
    while t < dur + 0.2:
        keys.append((t, str(rng.choice(['a', 'e', 'i', 'o', 'u', 'r', 'l']))))
        t += rng.uniform(0.6, 1.4) / rate
    amp = np.zeros(n); sibc = np.zeros(n)
    t = rng.uniform(0, 0.05)
    while t < dur:
        if rng.random() < gap:
            t += rng.uniform(0.15, 0.4); continue
        w = int(rng.uniform(0.7, 1.3) / rate * SR); s0 = int(t * SR)
        if s0 + w >= n: break
        amp[s0:s0 + w] += rng.uniform(0.5, 1.0) * np.hanning(w)
        if rng.random() < 0.35:
            k = int(rng.uniform(0.05, 0.12) * SR)
            sibc[s0:s0 + k] = np.maximum(sibc[s0:s0 + k], np.hanning(k) * rng.uniform(1.5, 3))
        t += w / SR * rng.uniform(0.7, 1.0)
    y = formant_noise(n, keys, rng, fscale, bw_mul=2.2, sib=sibc + 0.05)
    y = fft_filter(y, lo=250, hi=7500) * fft_filter(amp, hi=30)
    return fade_edges(y, 0.02, 0.1)

def glock(f, rng, dur=2.5):
    n = int(dur * SR); t = tvec(n)
    y = sum(a * np.exp(-t / d) * np.sin(2 * np.pi * f * r * t + rng.uniform(0, 6))
            for r, a, d in [(1, 1, 1.4), (2.756, .35, .4), (5.404, .12, .12), (8.933, .05, .04)])
    k = int(0.003 * SR); y[:k] += 0.2 * rng.uniform(-1, 1, k)
    return fade_edges(y / np.max(np.abs(y)), 0.0005, 0.2)

def harp(f, dur, rng, bright=0.75):
    return lute(f, dur, rng, bright=bright, t60=3.5, pos=0.3, body_amt=0.03)

def frame_drum(rng, f=56, dur=0.7, skin=0.35):
    n = int(dur * SR); t = tvec(n)
    fr = f * (1 + 0.6 * np.exp(-t / 0.015))
    y = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / 0.2)
    y += 0.35 * np.sin(2 * np.pi * f * 1.59 * t) * np.exp(-t / 0.07)
    nz = fft_filter(rng.standard_normal(n), lo=60, hi=900)
    y += skin * nz / np.max(np.abs(nz)) * np.exp(-t / 0.018)
    return fade_edges(y, 0.0008, 0.05)

def modal(rng, modes, dur, noise=0.3, nz_lo=800, nz_hi=6000, nz_tau=0.003):
    """模态敲击：modes=[(Hz, 幅度, 衰减秒)]。"""
    n = int(dur * SR); t = tvec(n)
    y = sum(a * np.exp(-t / d) * np.sin(2 * np.pi * f * t + rng.uniform(0, 6)) for f, a, d in modes)
    if noise:
        nz = fft_filter(rng.standard_normal(n), lo=nz_lo, hi=nz_hi)
        y += noise * nz / (np.max(np.abs(nz)) + 1e-9) * np.exp(-t / nz_tau)
    return fade_edges(y, 0.0003, min(0.02, dur / 4))

def clink(rng, f=None, dur=0.25):
    f = f or rng.uniform(1800, 4200)
    return modal(rng, [(f, 1, .06), (f * 2.31, .5, .03), (f * 3.73, .3, .02), (f * .62, .3, .08)], dur, 0.4, 2000, 9000, 0.002)

def grind(n, rng, lo=70, hi=1400, rough=55, density=0.08):
    """石头摩擦：稠密随机碎响 + 粗糙噪声。"""
    nz = rng.standard_normal(n)
    imp = (rng.random(n) < density) * rng.standard_normal(n) * 4
    y = fft_filter(nz + imp, lo=lo, hi=hi, order=2)
    y *= 0.4 + 0.6 * np.abs(smooth_noise(n, rough, rng))
    return y / (np.max(np.abs(y)) + 1e-9)

def creak(dur, rng, rate_lo=50, rate_hi=160, modes=((380, 1, .02), (930, .8, .012), (1720, .6, .008), (2650, .35, .005)), shape=None):
    """吱呀：黏滑摩擦脉冲列激励木头模态。"""
    n = int(dur * SR); t = tvec(n)
    prof = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 1.5 if shape is None else shape(t)
    rate = rate_lo + (rate_hi - rate_lo) * prof + 20 * smooth_noise(n, 6, rng)
    ph = np.cumsum(np.maximum(rate, 15)) / SR
    imp = np.zeros(n); idx = np.nonzero(np.diff(np.floor(ph)) > 0)[0]
    imp[idx] = rng.uniform(.6, 1, len(idx))
    imp *= np.clip(np.sin(np.pi * np.clip(t / dur, 0, 1)), 0, 1) ** .6 * (0.6 + 0.4 * np.abs(smooth_noise(n, 9, rng)))
    k = int(0.06 * SR); tk = tvec(k)
    m = sum(a * np.exp(-tk / d) * np.sin(2 * np.pi * f * tk) for f, a, d in modes)
    y = conv(imp, m)[:n]
    return y / (np.max(np.abs(y)) + 1e-9)

def caw(rng, dur=0.38, f0=560):
    """乌鸦叫：粗糙浊音 + 鼻化高共振峰。"""
    n = int(dur * SR); t = tvec(n)
    f = f0 * (1 + 0.12 * np.sin(np.pi * t / dur)) * (1 - 0.15 * t / dur)
    f = f * (1 + 0.04 * smooth_noise(n, 40, rng))
    amp = env_ar(n, 0.02, 0.12, 1.2) * (1 + 0.5 * np.sin(2 * np.pi * f0 / 2 * t))  # 次谐波粗糙
    y = vox(n, f, [(0, 'a'), (dur, 'e')], amp, rng, breath=0.6, fscale=1.45, hmax=6000, jitter=25)
    return fade_edges(y / (np.max(np.abs(y)) + 1e-9), 0.002, 0.03)

def edric(rng, f0=104, whisper_only=False, scale=1.0):
    """用共振峰合成念 "Ed-ric"（占位，非真人录音）。"""
    seg = [('e', .24), ('_', .045), ('r', .07), ('i', .17), ('_', .07)]
    dur = sum(d for _, d in seg) * scale + 0.25
    n = int(dur * SR); t = tvec(n)
    keys = []; amp = np.zeros(n); tt = 0.0; bursts = []
    for ph_, d in seg:
        d *= scale; a0, a1 = int(tt * SR), int((tt + d) * SR)
        if ph_ == '_':
            bursts.append(tt + d)
        else:
            keys += [(tt + 0.02, ph_), (tt + d - 0.02, ph_)]
            amp[a0:a1] = 1
        tt += d
    keys = [(0, 'e')] + keys + [(dur, 'i')]
    amp = fft_filter(amp, hi=40)
    f = f0 * (1.06 - 0.12 * t / dur)
    if whisper_only:
        y = vox(n, f, keys, amp, rng, breath=1.0, voiced=0)
    else:
        y = vox(n, f, keys, amp, rng, breath=0.25, voiced=1.0)
    for i, b in enumerate(bursts):  # d / k 爆破
        k = int(0.035 * SR); s0 = int(b * SR)
        bz = fft_filter(rng.standard_normal(k), lo=1500 if i == 0 else 1200, hi=4500) * np.exp(-tvec(k) / (0.006 if i == 0 else 0.015))
        y[s0:s0 + k] += (0.35 if i == 0 else 0.6) * bz / np.max(np.abs(bz)) * np.max(np.abs(y))
    return fade_edges(y, 0.005, 0.05)

def drone_periodic(L, f, rng, harm=(1, .5, .3, .2, .12, .08), vib_cents=4, amp_cycles=2):
    """整段循环内严格周期的持续音 (相位整数周期)。"""
    fr = f * 2 ** (vib_cents * lfo(L, 7, rng.uniform(0, 6)) / 1200)
    ph = periodic_phase(fr)
    y = sum(a * np.sin((i + 1) * ph + rng.uniform(0, 6)) for i, a in enumerate(harm))
    return y * (0.65 + 0.35 * lfo(L, amp_cycles, rng.uniform(0, 6)))

def glint(f, dur, rng):
    """不和谐泛音的微光：缓起缓落的纯音。"""
    n = int(dur * SR); t = tvec(n)
    return np.sin(2 * np.pi * f * t * (1 + 0.002 * np.sin(2 * np.pi * 0.3 * t))) * np.sin(np.pi * t / dur) ** 2

def scratch_stroke(rng, dur):
    """羽毛笔在羊皮纸上的一笔。"""
    n = int(dur * SR)
    y = fft_filter(rng.standard_normal(n), lo=2200, hi=7500)
    y *= (0.5 + 0.5 * np.abs(smooth_noise(n, 90, rng))) * np.hanning(n) ** 0.5
    return y / (np.max(np.abs(y)) + 1e-9)

# ============================================================ 作曲辅助
D_DORIAN = {2, 4, 5, 7, 9, 11, 0}

def gen_line(rng, segs, seg_len, lo, hi, start, scale_pcs, rhythms):
    """在和弦段落上生成缓慢旋律：段首落和弦音，其余为调式内级进。返回 [(t, midi, dur)]。"""
    notes = []; cur = start
    for t0, tones in segs:
        r = rhythms[rng.integers(len(rhythms))]
        t = t0
        for i, d in enumerate(r):
            pcs = {x % 12 for x in tones} if i == 0 else scale_pcs
            cands = [p for p in range(lo, hi + 1) if p % 12 in pcs and p != cur or (i == 0 and p == cur and p % 12 in pcs)]
            cands = sorted(cands, key=lambda p: abs(p - cur) + rng.uniform(0, 2.5))
            p = cands[0] if abs(cands[0] - cur) <= 5 else cands[0]
            notes.append((t, p, d)); cur = p; t += d
    return notes

# ============================================================ BGM
def bgm_title(rng):
    """标题：单人男声素歌 + 低音持续音（D 多利亚）；结尾一个音被“念错”滑向三全音。"""
    L = loop_n(90); m = Mix(0, True, rng, n=L)
    for f, g in [(mtof(38), .10), (mtof(45), .06)]:
        d = drone_periodic(L, f, rng, harm=(1, .7, .45, .3, .2, .14, .1, .07), amp_cycles=3)
        d = fft_filter(d, hi=900, circular=True)
        m.dry += g * np.stack([d, d]); m.send += g * 0.4 * d
    sub = np.sin(periodic_phase(np.full(L, mtof(26)))) * (0.6 + 0.4 * lfo(L, 2))
    m.dry += 0.05 * np.stack([sub, sub])
    phrases = [  # 原创素歌旋律 (midi, 拍)；拍 = 0.75 秒
        (4.0, [(50, 1), (53, 1), (55, 1), (57, 2), (57, 1), (57, 1), (55, 1), (57, 1), (60, 2), (57, 1), (55, 1), (53, 1), (55, 1), (57, 3)], 'aoeuao'),
        (22.0, [(57, 1), (60, 1), (62, 2), (60, 1), (57, 1), (55, 1), (57, 2), (53, 1), (55, 1), (53, 1), (52, 1), (50, 3)], 'oaeoau'),
        (40.0, [(53, 1), (55, 1), (57, 1), (59, 1), (57, 2), (55, 1), (57, 1), (53, 1), (52, 2), (53, 1), (50, 3)], 'uoaeou'),
        (58.0, [(50, 1), (52, 1), (53, 1), (55, 1), (57, 2), (55, 1), (53, 1), (52, 1), (55, 1), (53, 1), (52, 2), (44, 5)], 'aoauoe'),
    ]
    beat = 0.75
    for pi, (t0, notes, vow) in enumerate(phrases):
        total = sum(d for _, d in notes) * beat + 0.6
        n = int(total * SR); f = np.zeros(n); keys = []; tt = 0.0
        for k, (mm, d) in enumerate(notes):
            a0 = int(tt * SR); a1 = int((tt + d * beat) * SR)
            f[a0:] = mtof(mm)
            keys.append((tt + 0.05, vow[k % len(vow)]))
            tt += d * beat
        f = np.exp(fft_filter(np.log(np.maximum(f, 50)), hi=8))   # 滑音连接
        cents = np.zeros(n)
        if pi == 3:  # “念错”的最后一音：落到 G#2 后继续微分音下滑
            s0 = int((tt - 5 * beat) * SR)
            cents[s0:] = -45 * np.clip((tvec(n - s0)) / 3.0, 0, 1)
        f *= 2 ** (cents / 1200)
        amp = env_ar(n, 0.25, 0.9, 1.3)
        y = vox(n, f, keys + [(total, vow[-1])], amp, rng, breath=0.15, jitter=5)
        m.add(t0, y, 0.30, 0.0, rev=0.55)
    m.add(48.0, fft_filter(bell(mtof(62) * 2 ** (-14 / 1200), 9, rng, bright=.5), hi=2000), 0.10, 0.5, rev=0.9)
    ir = [make_ir(rng, 5.0, 4.8, dark=1.5, predelay=0.035) for _ in range(2)]
    return m.render(*ir, wet=0.6)

def bgm_r1_hall(rng):
    """大厅：壁炉暖意下的古大提琴慢旋律 + 鲁特琴分解和弦，偶有不和谐泛音；60 BPM，约 120 秒。"""
    L = loop_n(120); m = Mix(0, True, rng, n=L)
    V = {'Dm': (38, [50, 57, 62, 65]), 'Eb': (39, [51, 58, 63, 67]), 'C': (36, [48, 55, 60, 64]),
         'Bb': (34, [46, 53, 58, 62]), 'Gm': (43, [43, 50, 55, 58]), 'A': (33, [45, 52, 57, 61]),
         'F': (41, [53, 60, 65, 69]), 'Am': (45, [45, 52, 57, 60]), 'G': (43, [43, 50, 55, 59])}
    prog = ['Dm', 'Eb', 'Dm', 'C', 'Bb', 'Gm', 'Eb', 'A', 'Dm', 'F', 'C', 'G', 'Bb', 'Eb', 'A']
    seg = L / SR / len(prog)
    patterns = [[(0, 0), (0.5, 1), (1, 2), (1.5, 3), (2, 2), (3, 1)], [(0, 0), (1, 2), (2, 3), (2.5, 1), (3.5, 2)]]
    for ci, nm in enumerate(prog):
        bass, tones = V[nm]; t0 = ci * seg
        m.add(t0 - 0.2, bowed(mtof(bass), seg + 1.2, rng, att=0.9, rel=2.5, rough=0.3), 0.30, -0.15, rev=0.35)
        if ci % 3 == 0:
            m.add(t0 + 0.3, bowed(mtof(bass + 7), seg + 0.5, rng, att=1.5, rel=2.5, rough=0.3), 0.12, 0.1, rev=0.4)
        sparse = ci in (4, 5, 11, 12)
        for b in ([0] if sparse else [0, 1]):
            for beat, idx in patterns[(ci + b) % 2]:
                if sparse and beat > 2: continue
                tt = t0 + b * 4 + beat + rng.normal(0, 0.012)
                fr = mtof(tones[idx]) * 2 ** (rng.normal(0, 4) / 1200)
                m.add(tt, lute(fr, 3.0, rng, bright=rng.uniform(.3, .5)), 0.19 * rng.uniform(.7, 1) * (1.15 if beat == 0 else 1),
                      rng.uniform(.05, .35), rev=0.3)
        if ci in (2, 9, 13):   # 小二度擦音
            m.add(t0 + 6.75, lute(mtof(tones[3] + 1) * 2 ** (-18 / 1200), 2.5, rng, bright=.3), 0.09, 0.4, rev=0.5)
    segs = [(i * seg, V[prog[i]][1]) for i in list(range(3, 8)) + list(range(10, 15))]
    line = gen_line(rng, segs, seg, 55, 69, 62, D_DORIAN | {10}, [[4, 2, 2], [2, 2, 4], [6, 2], [3, 1, 4], [8]])
    for i, (st, nn, d) in enumerate(line):
        last = (i == len(line) - 1) or (i + 1 < len(line) and line[i + 1][0] - st > d + 0.1)
        dr = (lambda tt, d=d: -35 * np.clip((tt - d * 0.5) / (d * 0.5 + 1), 0, 1)) if (last and rng.random() < 0.7) else None
        m.add(st, bowed(mtof(nn), d + 1.2, rng, att=0.35, rel=1.0, rough=0.35, vib_cents=10, drift=dr,
                        formants=((350, 1.0, .5), (1100, 1.0, .3), (2700, .6, .3))), 0.16, 0.25, rev=0.45)
    # 不和谐泛音微光：D2 的第 7/11/13 号自然泛音 (偏离平均律)
    for st, h in [(18, 11), (47, 7), (78, 13), (101, 11)]:
        m.add(st, glint(mtof(38) * h, 7.0, rng), 0.035, rng.uniform(-.6, .6), rev=0.7)
    for st, nn, g in [(4, 62, .18), (64, 62, .16), (112, 56, .13)]:
        m.add(st, fft_filter(bell(mtof(nn) * 2 ** (-12 / 1200), 9.0, rng, bright=.6), hi=2200), g, -0.5, rev=0.9)
    for st, nn in [(29.0, 86), (29.5, 89), (30.25, 85), (93.0, 81), (93.6, 80), (94.4, 74)]:
        m.add(st, music_box(mtof(nn), rng, sag=-30), 0.05, 0.6, rev=0.7)
    for i in range(int(L / SR)):
        m.add(i, tick(rng, (2050 if i % 2 == 0 else 1580) * rng.uniform(.99, 1.01)), 0.035, -0.3 if i % 2 == 0 else 0.3, rev=0.25)
    sub = np.sin(periodic_phase(mtof(26) * 2 ** (40 * lfo(L, 1) / 1200))) * (0.6 + 0.4 * lfo(L, 2, 1.0))
    m.dry += 0.05 * np.stack([sub, sub])
    out = m.render(make_ir(rng, 4.0, 2.8, dark=1.4), make_ir(rng, 4.0, 2.8, dark=1.4), wet=0.5)
    return fft_filter(out, hi=7000, circular=True)   # 暖：去掉过亮高频

def bgm_r2_scriptorium(rng):
    """缮写室：清冷竖琴拨弦 (A 多利亚、空五度) + 羽毛笔沙沙节奏；72 BPM，约 120 秒。"""
    L = loop_n(120); m = Mix(0, True, rng, n=L)
    beat = 60 / 72; bar = 4 * beat
    roots = [45, 43, 45, 40, 41, 38, 45, 40, 45, 48, 43, 45, 41, 43, 40, 38, 41, 40]
    nseg = len(roots); seg = L / SR / nseg
    for si, r in enumerate(roots):
        tones = [r, r + 7, r + 12, r + 14, r + 19, r + 24]
        t0 = si * seg
        pat = [(0, 0), (0.5, 1), (1, 2), (1.5, 4), (2, 3), (3, 1)] if si % 2 == 0 else [(0, 0), (1, 2), (1.5, 3), (2.5, 5), (3, 4)]
        for b in range(2):
            for bt, idx in pat:
                if b == 1 and bt > 2.5 and si % 3 == 2: continue
                tt = t0 + b * bar + bt * beat + rng.normal(0, 0.008)
                m.add(tt, harp(mtof(tones[idx] + 12) * 2 ** (rng.normal(0, 3) / 1200), 4.0, rng, bright=rng.uniform(.65, .85)),
                      0.15 * rng.uniform(.7, 1), rng.uniform(-.5, .5), rev=0.4)
        if si % 4 == 1:   # 高处单音，冷
            m.add(t0 + 3 * beat, harp(mtof(tones[3] + 24), 4.0, rng, bright=.9), 0.06, 0.6, rev=0.7)
    # 羽毛笔沙沙：16 分音符网格上的书写笔画，偶尔停笔蘸墨
    grid = beat / 4; t = 0.0
    pats = ['x.x.xx..x.x..x..', 'xx.x..x.x.xx....', 'x..x.x.xx..x.x..', '................']
    while t < L / SR - bar * 0.5:
        p = pats[rng.choice([0, 1, 2, 0, 1, 3])]
        for i, c in enumerate(p):
            if c == 'x':
                d = rng.uniform(0.05, 0.14)
                m.add(t + i * grid + rng.normal(0, 0.006), scratch_stroke(rng, d), 0.035 * rng.uniform(.6, 1), 0.25, rev=0.15)
        if p[0] == '.':  # 蘸墨：笔尖碰墨水瓶
            m.add(t + 1.0, clink(rng, 2600, 0.2), 0.02, 0.3, rev=0.3)
        t += bar
    for f, g in [(mtof(69), .010), (mtof(76), .006)]:   # 冷而薄的高持续音
        d = drone_periodic(L, f, rng, harm=(1, .15, .05), vib_cents=3, amp_cycles=3)
        m.dry += g * np.stack([d, d * 0.8]); m.send += g * 0.6 * d
    out = m.render(make_ir(rng, 3.5, 2.4, dark=0.9, predelay=0.015), make_ir(rng, 3.5, 2.4, dark=0.9, predelay=0.015), wet=0.5)
    return fft_filter(out, lo=60, circular=True)

def bgm_r3_crypt(rng):
    """墓穴井室：圣咏空五度低持续 + 远处多人低声合诵（听不清的名字）+ 深海 sub + 水滴；E 弗里吉亚，约 150 秒。"""
    L = loop_n(150); m = Mix(0, True, rng, n=L); LEN = L / SR
    segs = [([40, 47], 'u', 'o', None), ([41, 48], 'o', 'u', None), ([40, 47, 52], 'u', 'a', None),
            ([34, 41], 'u', 'o', -45), ([40, 47, 53], 'o', 'a', -30), ([38, 45], 'a', 'u', None),
            ([40, 47], 'u', 'u', None), ([41, 46], 'o', 'u', -25), ([40, 47, 52], 'u', 'o', None), ([38, 45], 'a', 'u', None)]
    sl = LEN / len(segs)
    for si, (notes, v0, v1, sink) in enumerate(segs):
        for k, nn in enumerate(notes):
            if sink is not None:
                dr = (lambda tt, s=sink, k=k: s * np.clip((tt - 4) / 9, 0, 1) * (1 if k % 2 == 0 else 0.5))
            else:
                dr = (lambda tt, ph=rng.uniform(0, 6): 18 * np.sin(2 * np.pi * tt / 13 + ph))
            s = chant(mtof(nn), sl + 3.5, rng, v0, v1, att=3.0, rel=4.5, voices=2, drift=dr)
            m.add(si * sl - 0.5 + k * 0.6, s, 0.18 / (1 + 0.3 * k), [-0.35, 0.35, 0.0][k % 3], rev=0.6, deep=(si % 2 == 1))
    # 远处多人低声合诵：单音诵读 (reciting tone) 的含混音节，一串串“名字”
    for t0 in [8.0, 55.0, 104.0]:
        for v in range(4):
            dur = rng.uniform(14, 18); n = int(dur * SR)
            f0 = mtof(rng.choice([47, 52, 52, 40])) * 2 ** (rng.uniform(-30, 30) / 1200)
            keys = []; amp = np.zeros(n); tt = rng.uniform(0, 1.0)
            while tt < dur - 1:
                for _ in range(rng.integers(2, 5)):   # 一个名字 2–4 音节
                    sd = rng.uniform(0.16, 0.3)
                    keys.append((tt, str(rng.choice(['a', 'e', 'i', 'o', 'u']))))
                    a0, a1 = int(tt * SR), int((tt + sd) * SR)
                    amp[a0:a1] += rng.uniform(.6, 1)
                    tt += sd
                tt += rng.uniform(0.4, 1.1)
            amp = fft_filter(amp, hi=14) * env_ar(n, 2.5, 3.0, 1.2)
            f = f0 * np.ones(n) * 2 ** (-20 * np.linspace(0, 1, n) / 1200)
            y = vox(n, f, keys + [(dur, 'u')], amp, rng, breath=0.5, hmax=3000, jitter=10)
            m.add(t0 + v * rng.uniform(0.3, 1.5), y, 0.10, [-0.7, 0.7, -0.3, 0.3][v], rev=0.85, deep=True)
    for st, nn in [(6, 40), (45, 41), (85, 34), (128, 40)]:
        m.add(st, bowed(mtof(nn), 9.0, rng, att=2.0, rel=3.0, rough=0.4, drift=lambda tt: -25 * np.clip((tt - 4) / 5, 0, 1)),
              0.2, 0.0, rev=0.4, deep=True)
    for st, nn in [(30, 48), (98, 46)]:
        m.add(st, bell(mtof(nn), 10.0, rng, bright=.4), 0.28, -0.2, rev=0.8, deep=True)
    for st, nn in [(70.0, 83), (70.7, 84), (71.5, 82)]:
        m.add(st, music_box(mtof(nn), rng, sag=-45), 0.05, 0.4, rev=0.8, deep=True)
    t = 0.5
    while t < LEN:
        f = rng.uniform(700, 2100)
        m.add(t, water_drop(f, rng), 0.09 * rng.uniform(.4, 1), rng.uniform(-.8, .8), rev=0.75)
        t += rng.uniform(2.0, 6.0)
    fr = 41.2 * 2 ** ((3.5 * lfo(L, 2) + 1.0 * lfo(L, 5, 0.7)) / 12)    # 约 34–52 Hz 起伏
    ph = periodic_phase(fr)
    sub = (np.sin(ph) + 0.35 * np.sin(2 * ph + 0.3) + 0.12 * np.sin(3 * ph)) * (0.55 + 0.45 * lfo(L, 3, -1.2))
    sub += 0.25 * np.sin(periodic_phase(fr * 1.5 * 2 ** (-0.4 / 12))) * (0.5 + 0.5 * lfo(L, 4))
    m.dry += 0.13 * np.stack([sub, sub])
    nz = rng.standard_normal((2, L))
    rum = fft_filter(nz, lo=25, hi=160, circular=True); rum /= np.std(rum)
    m.dry += 0.03 * rum * (0.6 + 0.4 * lfo(L, 5))
    ir = [make_ir(rng, 5.0, 4.5, dark=1.8, predelay=0.04) for _ in range(2)]
    return m.render(*ir, wet=0.6, deep_lfo_cycles=4)

def bgm_interrogation(rng):
    """审讯：低速心跳般的手鼓 (50 BPM 的 lub-dub) + 持续弦簇 (小二度/三全音)，约 90 秒。"""
    L = loop_n(90); m = Mix(0, True, rng, n=L); LEN = L / SR
    beat = LEN / 75   # 约 50 BPM，整数拍
    for i in range(75):
        t0 = i * beat
        acc = 0.7 + 0.3 * np.sin(np.pi * ((i / 75) * 2 % 1)) ** 2
        m.add(t0, frame_drum(rng, 54 * rng.uniform(.98, 1.02)), 0.42 * acc, -0.05, rev=0.25)
        m.add(t0 + 0.27, frame_drum(rng, 60 * rng.uniform(.98, 1.02), skin=0.2), 0.25 * acc, 0.05, rev=0.25)
    for st, nn, g, p in [(0, 38, .26, -.3), (2, 45, .17, .3), (12, 51, .10, .1), (30, 39, .2, -.2), (34, 44, .12, .4),
                         (45, 38, .26, -.3), (47, 45, .17, .3), (60, 50, .11, 0), (62, 51, .09, .2), (75, 44, .14, -.4)]:
        s = bowed(mtof(nn), 16.0, rng, att=4.0, rel=5.0, rough=0.35, vib_cents=4,
                  drift=lambda tt, ph=rng.uniform(0, 6): 12 * np.sin(2 * np.pi * tt / 11 + ph))
        m.add(st, s, g, p, rev=0.4)
    for st in [20, 66]:   # 高处颤音弦
        n = int(9 * SR); t = tvec(n)
        s = bowed(mtof(74) * 2 ** (-25 / 1200), 9.0, rng, att=3, rel=3, rough=0.2, vib_cents=3) * (0.6 + 0.4 * np.sin(2 * np.pi * 6.5 * t))
        m.add(st, s, 0.05, 0.5, rev=0.6)
    sub = np.sin(periodic_phase(np.full(L, mtof(26)))) * (0.5 + 0.5 * lfo(L, 2))
    m.dry += 0.07 * np.stack([sub, sub])
    out = m.render(make_ir(rng, 3.0, 2.0, dark=1.5), make_ir(rng, 3.0, 2.0, dark=1.5), wet=0.45)
    return out

def bgm_clueboard(rng):
    """线索板/推理：极简钟琴 + 竖琴三音固定音型，思考感 (D 多利亚)，约 90 秒。"""
    L = loop_n(90); m = Mix(0, True, rng, n=L); LEN = L / SR
    beat = LEN / 96   # 约 64 BPM
    ost = [[50, 57, 64], [50, 57, 65], [48, 55, 64], [46, 53, 62]]
    for bar in range(24):
        tones = ost[(bar // 2) % 4]
        for k, bt in enumerate([0, 1, 2, 3]):
            nn = tones[[0, 1, 2, 1][k]]
            if bar % 4 == 3 and k == 3: continue
            m.add((bar * 4 + bt) * beat + rng.normal(0, 0.006), harp(mtof(nn), 3.0, rng, bright=.6), 0.14 * (1.1 if k == 0 else .85), -0.2, rev=0.35)
    mel = [(4, 74), (6, 76), (7, 77), (12, 74), (20, 81), (22, 79), (23, 77), (28, 76), (36, 74), (38, 72), (44, 69),
           (52, 74), (54, 76), (55, 77), (60, 79), (68, 81), (70, 80), (71, 76), (76, 74), (84, 77), (86, 76), (88, 74)]
    for bt, nn in mel:
        m.add(bt * beat, glock(mtof(nn) * 2 ** (rng.normal(0, 3) / 1200), rng), 0.08, 0.35, rev=0.5)
    pad = sum(drone_periodic(L, mtof(nn), rng, harm=(1, .2, .08), amp_cycles=3) for nn in [50, 57])
    pad = fft_filter(pad, hi=700, circular=True)
    m.dry += 0.03 * np.stack([pad, pad]); m.send += 0.03 * pad
    return m.render(make_ir(rng, 3.0, 2.2), make_ir(rng, 3.0, 2.2), wet=0.45)

def bgm_ending_ch1(rng):
    """章末 (0:45，不循环)：井下用主角嗓音念“埃德里克”(Edric)，渐强又骤停。"""
    dur = 45.0; m = Mix(dur, False, rng); n = m.L; t = tvec(n)
    cut = 41.2
    swell = np.clip(t / cut, 0, 1) ** 1.8 * (t < cut)
    for nn, g in [(40, .5), (47, .35), (41, .25), (34, .3)]:
        fr = mtof(nn) * 2 ** (-60 * np.clip(t / cut, 0, 1) / 1200)
        ph = 2 * np.pi * np.cumsum(fr) / SR
        y = sum(a * np.sin((h + 1) * ph) for h, a in enumerate([1, .5, .35, .2, .12]))
        m.add(0, y * swell, g * 0.25, rng.uniform(-.4, .4), rev=0.5, deep=True)
    sub = np.sin(2 * np.pi * np.cumsum(40 - 8 * t / dur) / SR) * swell
    m.dry += 0.25 * np.stack([sub, sub])
    times = [3.0, 9.5, 15.0, 20.0, 24.0, 27.5, 30.5, 33.0, 35.0, 36.8, 38.3, 39.6, 40.6]
    for i, st in enumerate(times):
        close = i / (len(times) - 1)
        w = edric(rng, f0=104 * 2 ** (rng.uniform(-40, 10) / 1200), whisper_only=close < 0.55, scale=rng.uniform(0.9, 1.25))
        m.add(st, w, 0.12 + 0.35 * close, rng.uniform(-.8, .8) * (1 - close), rev=0.9 - 0.6 * close)
        if i < len(times) - 2:
            m.add(st + rng.uniform(0.5, 2.0), whisper(rng.uniform(1.0, 2.0), rng), 0.05 + 0.1 * close, rng.uniform(-1, 1), rev=0.8)
    out = m.render(make_ir(rng, 5.0, 4.5, dark=1.6, predelay=0.05), make_ir(rng, 5.0, 4.5, dark=1.6, predelay=0.05), wet=0.6)
    gate = np.ones(n); c = int(cut * SR); k = int(0.012 * SR)
    gate[c:c + k] = np.linspace(1, 0, k); gate[c + k:] = 0   # 骤停（含混响一起切断）
    return fade_edges(out * gate, 0.5, 0.01)

# ============================================================ 环境声 (循环)
def amb_hall_fire(rng):
    L = loop_n(60); m = Mix(0, True, rng, n=L); LEN = L / SR
    nz = rng.standard_normal((4, L))
    roar = fft_filter(nz[0], lo=40, hi=220, circular=True); roar /= np.std(roar)
    hiss = fft_filter(nz[1], lo=400, hi=2500, circular=True); hiss /= np.std(hiss)
    breath = 0.6 + 0.25 * lfo(L, 11, 1) + 0.15 * lfo(L, 23, 2)
    m.dry += np.stack([0.05 * roar * breath + 0.012 * hiss * breath, 0.04 * roar * breath + 0.009 * hiss * breath])
    t = 0.0
    while t < LEN:
        if rng.random() < 0.08:
            k = int(rng.uniform(.01, .03) * SR)
            pop = modal(rng, [(rng.uniform(300, 1200), 1, .008), (rng.uniform(1500, 3000), .5, .004)], k / SR, 0.8, 500, 4000, 0.004)
            m.add(t, pop, rng.uniform(.15, .35), rng.uniform(-.5, .1), rev=0.2)
        else:
            k = max(30, int(rng.uniform(.0008, .004) * SR))
            c = fft_filter(rng.standard_normal(k), lo=rng.uniform(1000, 3000), hi=rng.uniform(4000, 9000)) * np.exp(-tvec(k) / (k / SR / 3))
            m.add(t, c / (np.max(np.abs(c)) + 1e-9), rng.uniform(.03, .12), rng.uniform(-.5, .1), rev=0.1)
        t += rng.exponential(0.12)
    for fc, g, p in [(620, .012, .7), (845, .008, .8), (1180, .004, .6)]:   # 门缝风哨
        b = fft_filter(nz[2], lo=fc * 0.97, hi=fc * 1.03, order=4, circular=True); b /= np.std(b)
        gust = np.clip(0.3 + 0.5 * lfo(L, 3, rng.uniform(0, 6)) + 0.3 * lfo(L, 7, rng.uniform(0, 6)), 0, None)
        m.dry += pan2(g * b * gust, p)
    w = fft_filter(nz[3], lo=150, hi=900, circular=True); w /= np.std(w)
    m.dry += pan2(0.008 * w * (0.5 + 0.5 * lfo(L, 3)), 0.6)
    return m.render(make_ir(rng, 2.0, 1.2, dark=1.4), make_ir(rng, 2.0, 1.2, dark=1.4), wet=0.25)

def amb_tower_wind(rng):
    L = loop_n(60); m = Mix(0, True, rng, n=L)
    nz = rng.standard_normal((4, L))
    gust = np.clip(0.55 + 0.3 * lfo(L, 3, 0.4) + 0.2 * lfo(L, 7, 2.1) + 0.1 * lfo(L, 13, 4), 0.05, None)
    for ch, p in [(0, -0.6), (1, 0.6)]:
        w = fft_filter(nz[ch], lo=60, hi=1100, circular=True); w /= np.std(w)
        m.dry += pan2(0.05 * w * gust, p)
    for fc, g in [(310, .025), (470, .02), (720, .012)]:
        bs = []
        for k, mul in enumerate([1.0, 1.06, 1.12]):
            b = fft_filter(nz[2 + k % 2], lo=fc * mul * 0.98, hi=fc * mul * 1.02, order=4, circular=True); bs.append(b / np.std(b))
        sw = 0.5 + 0.5 * lfo(L, 5, rng.uniform(0, 6))
        howl = bs[0] * (1 - sw) + bs[1] * sw * 0.8 + bs[2] * sw ** 3 * 0.6
        m.dry += pan2(g * howl * gust ** 2, rng.uniform(-.5, .5))
    for st, cnt in [(14.0, 3), (41.0, 2)]:   # 远处乌鸦
        for i in range(cnt):
            c = fft_filter(caw(rng, f0=rng.uniform(480, 600)), hi=3000)
            m.add(st + i * rng.uniform(0.45, 0.6), c, 0.07, 0.7 if st < 30 else -0.7, rev=0.8)
    return m.render(make_ir(rng, 3.0, 2.0, dark=1.5), make_ir(rng, 3.0, 2.0, dark=1.5), wet=0.35)

def amb_crypt_drip(rng):
    L = loop_n(60); m = Mix(0, True, rng, n=L); LEN = L / SR
    t = 0.3
    while t < LEN:
        f = rng.uniform(800, 2300)
        m.add(t, water_drop(f, rng), 0.12 * rng.uniform(.4, 1), rng.uniform(-.8, .8), rev=0.8)
        t += rng.uniform(1.0, 4.5)
    for st in [9.0, 33.0, 51.0]:   # 链条轻响
        tt = st
        for _ in range(rng.integers(2, 5)):
            m.add(tt, clink(rng, rng.uniform(2200, 3800)), 0.05 * rng.uniform(.5, 1), 0.5, rev=0.6)
            tt += rng.uniform(0.06, 0.25)
    # 井下极低的呼吸：吸/呼交替，约 6 秒一周期 (整数周期)
    s = lfo(L, 10)
    nz = rng.standard_normal((2, L))
    inh = fft_filter(nz[0], lo=250, hi=1300, circular=True); inh /= np.std(inh)
    exh = fft_filter(nz[1], lo=70, hi=500, circular=True); exh /= np.std(exh)
    br = 0.012 * inh * np.clip(s, 0, None) ** 1.5 + 0.03 * exh * np.clip(-s, 0, None) ** 1.5
    m.add(0, br, 1.0, 0.0, rev=0.6, deep=True)
    sub = np.sin(periodic_phase(np.full(L, 33.0))) * (0.3 + 0.7 * np.clip(-s, 0, None))
    m.dry += 0.05 * np.stack([sub, sub])
    rum = fft_filter(rng.standard_normal(L), lo=25, hi=120, circular=True); rum /= np.std(rum)
    m.dry += 0.012 * np.stack([rum, rum])
    return m.render(make_ir(rng, 5.0, 4.0, dark=1.8, predelay=0.04), make_ir(rng, 5.0, 4.0, dark=1.8, predelay=0.04), wet=0.55)

def amb_whisper_low(rng):
    """心烛 s2：弥散、远、低的耳语层 (按清单以 30% 音量叠加)。"""
    L = loop_n(40); m = Mix(0, True, rng, n=L); LEN = L / SR
    t = 0.0
    while t < LEN:
        d = rng.uniform(1.5, 3.5)
        m.add(t, whisper(d, rng, rate=rng.uniform(6, 9), fscale=rng.uniform(.9, 1.15)), 0.12, rng.uniform(-.9, .9), rev=0.8)
        t += rng.uniform(0.4, 1.4)
    out = m.render(make_ir(rng, 4.0, 3.0, dark=1.6), make_ir(rng, 4.0, 3.0, dark=1.6), wet=0.7)
    return fft_filter(out, lo=200, hi=3500, circular=True)

def amb_whisper_near(rng):
    """心烛 s3：贴耳、左右交替的耳语 (较干)。"""
    L = loop_n(40); m = Mix(0, True, rng, n=L); LEN = L / SR
    t = 0.5; side = 1
    while t < LEN:
        d = rng.uniform(1.2, 2.8)
        m.add(t, whisper(d, rng, rate=rng.uniform(6.5, 9), fscale=rng.uniform(.95, 1.1), sib=0.8), 0.25, 0.85 * side, rev=0.15)
        if rng.random() < 0.4:   # 吸气
            k = int(0.35 * SR)
            br = formant_noise(k, [(0, 'i'), (0.35, 'a')], rng) * np.hanning(k)
            m.add(t + d + 0.05, br, 0.05, 0.85 * side, rev=0.1)
        t += d + rng.uniform(0.6, 1.8); side = -side
    return m.render(make_ir(rng, 1.5, 0.8), make_ir(rng, 1.5, 0.8), wet=0.3)

# ============================================================ Stinger
def stinger_contradiction(rng):
    """拆穿谎言 (2 秒)：蜡封盖印 + 低音弦重击 (D + 降 A 三全音)。"""
    dur = 2.0; m = Mix(dur, False, rng); n = m.L
    k = int(0.25 * SR); tt = tvec(k)
    press = fft_filter(rng.standard_normal(k), lo=150, hi=1800) * np.exp(-tt / 0.05) * (1 + 0.7 * np.sin(2 * np.pi * 37 * tt))
    thump = np.sin(2 * np.pi * np.cumsum(90 * (1 + np.exp(-tt / 0.01))) / SR) * np.exp(-tt / 0.07)
    seal = press / np.max(np.abs(press)) * 0.6 + thump
    m.add(0.0, seal, 0.5, 0.0, rev=0.2)
    for nn, g, p in [(26, .5, 0), (38, .45, -.3), (44, .3, .3), (32, .25, 0)]:
        s = bowed(mtof(nn), 1.9, rng, att=0.015, rel=1.4, rough=0.5, bow_noise=0.12, vib_cents=3)
        s *= np.exp(-tvec(len(s)) / 0.6) * 0.7 + 0.3
        m.add(0.06, s, g, p, rev=0.4)
    sub = np.sin(2 * np.pi * np.cumsum(np.full(n, 36.7)) / SR) * np.exp(-tvec(n) / 0.5)
    m.dry += 0.25 * np.stack([sub, sub])
    return fade_edges(m.render(make_ir(rng, 2.0, 1.6), make_ir(rng, 2.0, 1.6), wet=0.4), 0.0005, 0.3)

def stinger_deduction(rng):
    """推理成功 (3 秒)：上行竖琴 + 素歌和声 (D 空五度 + 小七度)。"""
    dur = 3.2; m = Mix(dur, False, rng)
    for i, nn in enumerate([50, 57, 62, 64, 65, 69, 74, 76]):
        m.add(i * 0.065, harp(mtof(nn), 2.8, rng, bright=.75), 0.25, -0.5 + i * 0.14, rev=0.4)
    for k, nn in enumerate([38, 45, 50, 57, 60]):
        s = chant(mtof(nn), dur - 0.5, rng, 'u', 'a', att=0.8, rel=1.4, voices=2, detune=6)
        m.add(0.45 + 0.04 * k, s, 0.26 / (1 + 0.25 * k), [-0.4, 0.4, -0.15, 0.15, 0.0][k], rev=0.5)
    out = m.render(make_ir(rng, 2.5, 2.2, dark=1.2), make_ir(rng, 2.5, 2.2, dark=1.2), wet=0.5)
    return fade_edges(out, 0.001, 0.4)

# ============================================================ 音效
def sfx_tap(rng):
    """UI 点击：干木轻敲 (<100ms)。"""
    n = int(0.085 * SR); t = tvec(n)
    y = (np.exp(-t / .010) * np.sin(2 * np.pi * 1750 * t) + .6 * np.exp(-t / .006) * np.sin(2 * np.pi * 3050 * t)
         + .7 * np.exp(-t / .018) * np.sin(2 * np.pi * 520 * t + 1))
    k = int(0.003 * SR)
    y[:k] += fft_filter(rng.uniform(-1, 1, k), lo=1500) * 1.2
    return fade_edges(y, 0.0003, 0.015)

def sfx_pickup(rng):
    """拾取：细小金属铃 (两声，第二声略走调)。"""
    n = int(0.9 * SR); t = tvec(n); y = np.zeros(n)
    for f0, st, g in [(1480, 0.0, 1.0), (2093 * 2 ** (-20 / 1200), 0.075, 0.7)]:
        tt = np.maximum(t - st, 0); on = t >= st
        for r, a, d in [(1, 1, .35), (2.76, .5, .15), (5.40, .25, .07), (8.93, .1, .03)]:
            y += on * g * a * np.exp(-tt / d) * np.sin(2 * np.pi * f0 * r * tt)
    k = int(0.002 * SR); y[:k] += 0.3 * rng.uniform(-1, 1, k)
    y = y + 0.25 * conv(y, make_ir(rng, 1.0, 0.6, dark=1.0, predelay=0.005))[:n]
    return fade_edges(y, 0.0005, 0.1)

def sfx_item_use(rng):
    """使用道具：棘轮咔哒 + 机械闷击 + 金属余振。"""
    dur = 1.0; n = int(dur * SR); t = tvec(n); y = np.zeros(n)
    for i, st in enumerate([0.0, 0.05, 0.095, 0.135]):
        place(y, st, tick(rng, 2600 * rng.uniform(.95, 1.05), 0.05) * (0.45 + 0.1 * i), False)
    st = 0.2; tt = np.maximum(t - st, 0); on = t >= st
    clunk = sum(a * np.exp(-tt / d) * np.sin(2 * np.pi * f * tt) for f, a, d in [(140, 1, .06), (330, .7, .04), (710, .4, .025)])
    metal = sum(a * np.exp(-tt / d) * np.sin(2 * np.pi * f * tt + p)
                for f, a, d, p in [(823, .35, .35, 0), (1291, .25, .28, 1), (2207, .15, .2, 2), (3110, .07, .12, 3)])
    y += on * (clunk + metal) * np.minimum(1, tt / 0.001)
    y = y + 0.25 * conv(y, make_ir(rng, 1.2, 0.8, dark=1.2, predelay=0.006))[:n]
    return fade_edges(y, 0.0005, 0.1)

def sfx_wrong(rng):
    """错误提示：低沉木声 (两下闷敲) + 极弱的失谐低音。"""
    dur = 0.6; n = int(dur * SR); y = np.zeros(n)
    for st, g in [(0.0, 1.0), (0.13, 0.75)]:
        k = modal(rng, [(150, 1, .05), (330, .6, .03), (610, .35, .02), (1040, .15, .012)], 0.3, 0.5, 200, 2500, 0.004)
        place(y, st, g * k, False)
    t = tvec(n)
    y += 0.12 * (np.sin(2 * np.pi * 98 * t) + np.sin(2 * np.pi * 103.8 * t)) * np.exp(-t / 0.15) * np.minimum(1, t / 0.01)
    return fade_edges(fft_filter(np.tanh(1.3 * y), lo=50, hi=3000), 0.0005, 0.05)

def sfx_combine_success(rng):
    dur = 1.0; n = int(dur * SR); y = np.zeros(n)
    place(y, 0.0, 0.6 * modal(rng, [(900, 1, .02), (2100, .5, .01)], 0.1, 0.5), False)
    place(y, 0.06, 0.8 * modal(rng, [(240, 1, .04), (520, .5, .03)], 0.15, 0.3, 300, 3000), False)
    for st, nn in [(0.12, 81), (0.22, 88)]:   # A5 → E6 空五度
        place(y, st, 0.45 * glock(mtof(nn), rng, 0.8), False)
    y = y + 0.2 * conv(y, make_ir(rng, 0.8, 0.5))[:n]
    return fade_edges(y, 0.0005, 0.1)

def sfx_combine_fail(rng):
    dur = 0.55; n = int(dur * SR); y = np.zeros(n)
    place(y, 0.0, modal(rng, [(200, 1, .04), (470, .5, .02)], 0.2, 0.5, 200, 2000), False)
    place(y, 0.09, 0.8 * modal(rng, [(170, 1, .05), (390, .4, .025)], 0.25, 0.5, 200, 2000), False)
    t = tvec(n)
    fr = 140 * (1 - 0.15 * t / dur)
    y += 0.15 * np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / 0.15) * (t > 0.09)
    return fade_edges(fft_filter(y, hi=2500), 0.0005, 0.05)

def sfx_stone_sink(rng):
    """门开（石盘下沉）：石磨下沉 + 尘土簌簌 + 末尾沉重落定。"""
    dur = 2.6; n = int(dur * SR); t = tvec(n)
    g = grind(n, rng, 60, 1300, 45)
    g *= np.clip(np.sin(np.pi * np.clip((t - 0.05) / 1.9, 0, 1)), 0, None) ** 0.6
    pitch = fft_filter(rng.standard_normal(n), lo=50, hi=160) * np.clip(1 - t / 2.0, 0, 1)
    y = 0.7 * g + 0.5 * pitch / np.max(np.abs(pitch))
    thud = modal(rng, [(55, 1, .25), (95, .6, .15), (180, .3, .08)], 0.8, 0.6, 80, 800, 0.02)
    place(y, 1.95, 1.4 * thud, False)
    dust = fft_filter(rng.standard_normal(n), lo=3000, hi=9000) * ((rng.random(n) < 0.02) * 1.0)
    y += 0.3 * dust * np.clip((t - 1.95) / 0.1, 0, 1) * np.exp(-np.maximum(t - 1.95, 0) / 0.3)
    y = y + 0.35 * conv(y, make_ir(rng, 2.0, 1.6, dark=1.4))[:n]
    return fade_edges(y, 0.005, 0.2)

def sfx_crest_rotate(rng):
    """家徽石盘转动：石面摩擦 + 四个卡位咔嗒。"""
    dur = 1.5; n = int(dur * SR); t = tvec(n)
    g = grind(n, rng, 90, 2000, 70) * np.clip(np.sin(np.pi * np.clip(t / 1.3, 0, 1)), 0, None) ** 0.5
    y = 0.5 * g
    for st in [0.25, 0.55, 0.85, 1.2]:
        place(y, st, 0.7 * modal(rng, [(420, 1, .03), (980, .5, .015), (2300, .3, .006)], 0.12, 0.5), False)
    y = y + 0.25 * conv(y, make_ir(rng, 1.2, 0.9))[:n]
    return fade_edges(y, 0.003, 0.1)

def sfx_dial_click(rng):
    """转盘锁咔嗒。"""
    y = modal(rng, [(1900, 1, .006), (3700, .6, .004), (620, .5, .02), (240, .4, .03)], 0.12, 0.7, 2000, 9000, 0.0015)
    return fade_edges(y, 0.0002, 0.02)

def sfx_box_open(rng):
    """匣子打开：搭扣 + 小合页吱呀 + 盖子靠定。"""
    dur = 1.0; n = int(dur * SR); y = np.zeros(n)
    place(y, 0.0, 0.7 * modal(rng, [(2400, 1, .01), (5100, .5, .005), (900, .4, .015)], 0.08, 0.6), False)
    c = creak(0.55, rng, 120, 340, modes=((700, 1, .01), (1500, .8, .006), (2900, .5, .004)))
    place(y, 0.12, 0.45 * c, False)
    place(y, 0.72, 0.8 * modal(rng, [(260, 1, .04), (610, .6, .025), (1300, .3, .01)], 0.25, 0.4, 300, 3000), False)
    y = y + 0.2 * conv(y, make_ir(rng, 0.8, 0.5))[:n]
    return fade_edges(y, 0.0005, 0.08)

def sfx_page_turn(rng):
    """羊皮纸翻页：粗糙的皱响 + 轻风声 + 落页。"""
    dur = 0.7; n = int(dur * SR); t = tvec(n)
    env = np.exp(-0.5 * ((t - 0.25) / 0.11) ** 2)
    crk = fft_filter(rng.standard_normal(n), lo=1200, hi=8000) * ((rng.random(n) < 0.06) * 2.5 + 0.4)
    whoosh = fft_filter(rng.standard_normal(n), lo=200, hi=1500)
    y = env * (crk / np.max(np.abs(crk)) + 0.6 * whoosh / np.max(np.abs(whoosh)))
    place(y, 0.45, 0.4 * fft_filter(rng.standard_normal(int(0.04 * SR)), lo=300, hi=3000) * np.exp(-tvec(int(0.04 * SR)) / 0.008), False)
    return fade_edges(y, 0.005, 0.08)

def sfx_charcoal_reveal(rng):
    """炭粉刷显影：刷子沙沙 + 渐起的低语 (立体声)。"""
    dur = 3.2; m = Mix(dur, False, rng)
    for i, st in enumerate([0.0, 0.45, 0.85, 1.3, 1.7, 2.1]):
        d = rng.uniform(0.3, 0.42); k = int(d * SR)
        b = fft_filter(rng.standard_normal(k), lo=1500, hi=8000) * np.hanning(k) * (0.6 + 0.4 * np.abs(smooth_noise(k, 60, rng)))
        m.add(st, b / np.max(np.abs(b)), 0.35 * (1 - 0.08 * i), -0.2 + 0.08 * i, rev=0.15)
    for v, p in enumerate([-0.7, 0.7, 0.0]):
        w = whisper(2.4, rng, rate=8, fscale=1 + 0.05 * v) * np.linspace(0, 1, int(2.4 * SR)) ** 1.5
        m.add(0.7 + 0.1 * v, w, 0.18, p, rev=0.6)
    out = m.render(make_ir(rng, 2.5, 2.0, dark=1.5), make_ir(rng, 2.5, 2.0, dark=1.5), wet=0.4)
    return fade_edges(out, 0.005, 0.3)

def sfx_crow(rng):
    """乌鸦叫两声 + 扑翼。"""
    dur = 1.8; n = int(dur * SR); y = np.zeros(n)
    place(y, 0.0, caw(rng, 0.36, 560), False)
    place(y, 0.48, 0.85 * caw(rng, 0.32, 520), False)
    for i in range(7):
        k = int(0.07 * SR)
        f = fft_filter(rng.standard_normal(k), lo=120, hi=1500) * np.hanning(k)
        place(y, 0.95 + i * 0.11, 0.5 * (1 - i / 9) * f / np.max(np.abs(f)), False)
    y = y + 0.25 * conv(y, make_ir(rng, 1.5, 1.0))[:n]
    return fade_edges(y, 0.002, 0.15)

def sfx_window_wind(rng):
    """开窗冷风：插销 + 短吱呀 + 冷风灌入 (立体声)。"""
    dur = 2.4; m = Mix(dur, False, rng); n = m.L; t = tvec(n)
    m.add(0.0, modal(rng, [(1600, 1, .01), (3400, .5, .006), (700, .4, .02)], 0.1, 0.6), 0.4, 0.0, rev=0.2)
    m.add(0.08, creak(0.4, rng, 90, 220), 0.25, 0.0, rev=0.2)
    nz = rng.standard_normal((2, n))
    for ch in range(2):
        w = fft_filter(nz[ch], lo=150, hi=2500); w /= np.max(np.abs(w))
        e = np.clip((t - 0.25) / 0.35, 0, 1) * np.exp(-np.maximum(t - 0.8, 0) / 0.9)
        h = fft_filter(nz[ch], lo=900, hi=960, order=4); h /= np.max(np.abs(h))
        m.dry[ch] += 0.5 * w * e + 0.15 * h * e
    return fade_edges(m.render(make_ir(rng, 1.5, 1.0), make_ir(rng, 1.5, 1.0), wet=0.3), 0.001, 0.3)

def flame(n, rng):
    f = fft_filter(rng.standard_normal(n), lo=80, hi=900)
    f *= 0.6 + 0.4 * np.abs(smooth_noise(n, 12, rng))
    return f / (np.max(np.abs(f)) + 1e-9)

def sfx_candle_light(rng):
    """蜡烛点燃：火柴划擦 + 引燃“噗” + 火苗。"""
    dur = 1.4; n = int(dur * SR); t = tvec(n); y = np.zeros(n)
    k = int(0.18 * SR)
    scr = fft_filter(rng.standard_normal(k), lo=1500, hi=8000) * np.hanning(k) * (0.5 + (rng.random(k) < 0.05) * 2)
    place(y, 0.0, 0.6 * scr / np.max(np.abs(scr)), False)
    k = int(0.5 * SR); tt = tvec(k)
    puff = fft_filter(rng.standard_normal(k), lo=100, hi=2500) * (1 - np.exp(-tt / 0.01)) * np.exp(-tt / 0.12)
    place(y, 0.17, 0.9 * puff / np.max(np.abs(puff)), False)
    y += 0.25 * flame(n, rng) * np.clip((t - 0.3) / 0.2, 0, 1) * np.exp(-np.maximum(t - 0.5, 0) / 0.5)
    return fade_edges(y, 0.002, 0.15)

def sfx_candle_out(rng):
    """蜡烛熄灭：轻吹 + 火苗抖动熄灭 + 一缕烟。"""
    dur = 1.1; n = int(dur * SR); t = tvec(n)
    blow = formant_noise(n, [(0, 'u'), (dur, 'u')], rng, bw_mul=3) * np.exp(-0.5 * ((t - 0.15) / 0.08) ** 2)
    fl = flame(n, rng) * np.clip(1 - (t - 0.1) / 0.35, 0, 1) * (1 + 0.8 * np.sin(2 * np.pi * 14 * t))
    smoke = fft_filter(rng.standard_normal(n), lo=2000, hi=6000) * np.exp(-0.5 * ((t - 0.6) / 0.2) ** 2)
    y = 0.6 * blow + 0.4 * fl + 0.05 * smoke / np.max(np.abs(smoke))
    return fade_edges(y, 0.005, 0.15)

def sfx_winch_chain(rng):
    """绞盘转动 + 链条。"""
    dur = 2.8; n = int(dur * SR); t = tvec(n); y = np.zeros(n)
    tt = 0.05
    while tt < 2.3:
        place(y, tt, 0.5 * modal(rng, [(1300, 1, .01), (2900, .5, .005), (500, .5, .02)], 0.08, 0.5), False)
        tt += 0.16 + 0.02 * rng.standard_normal()
    place(y, 0.0, 0.35 * creak(2.4, rng, 30, 70, modes=((180, 1, .03), (420, .7, .02), (900, .4, .01))), False)
    tt = 0.1
    while tt < 2.4:
        place(y, tt, 0.25 * rng.uniform(.3, 1) * clink(rng, rng.uniform(2000, 5000), 0.15), False)
        tt += rng.exponential(0.035)
    y = y + 0.3 * conv(y, make_ir(rng, 1.8, 1.4, dark=1.3))[:n]
    return fade_edges(y, 0.002, 0.25)

def sfx_well_cover(rng):
    """井盖滑开：沉重石磨 + 落定 + 井口空洞回响 (立体声)。"""
    dur = 3.4; m = Mix(dur, False, rng); n = m.L; t = tvec(n)
    g = grind(n, rng, 50, 1100, 35) * np.clip(np.sin(np.pi * np.clip((t - 0.05) / 1.9, 0, 1)), 0, None) ** 0.5
    m.add(0, g, 0.6, -0.1, rev=0.4)
    m.add(1.9, modal(rng, [(48, 1, .3), (85, .6, .2), (160, .3, .08)], 0.9, 0.5, 80, 700, 0.02), 0.9, 0.0, rev=0.5)
    hol = fft_filter(rng.standard_normal(n), lo=60, hi=400)
    hol = hol / np.max(np.abs(hol)) * np.clip((t - 0.6) / 1.0, 0, 1) * np.exp(-np.maximum(t - 2.0, 0) / 0.7)
    m.add(0, hol, 0.3, 0.0, rev=0.9, deep=True)
    ir = [make_ir(rng, 3.0, 2.8, dark=2.0, predelay=0.05) for _ in range(2)]
    return fade_edges(m.render(*ir, wet=0.55), 0.003, 0.4)

def sfx_clue_connect(rng):
    """线索板连线成功：图钉 + 红线绷紧上滑的拨弦。"""
    dur = 0.8; n = int(dur * SR); t = tvec(n); y = np.zeros(n)
    place(y, 0.0, 0.5 * modal(rng, [(3200, 1, .006), (1400, .5, .01)], 0.06, 0.6), False)
    k = int(0.7 * SR); tk = tvec(k)
    fr = 330 * (1 + 0.5 * (1 - np.exp(-tk / 0.05)))
    s = sum(np.sin(h * 2 * np.pi * np.cumsum(fr) / SR) / h ** 1.3 for h in range(1, 8)) * np.exp(-tk / 0.18)
    place(y, 0.05, 0.6 * s / np.max(np.abs(s)), False)
    return fade_edges(y, 0.0005, 0.08)

def sfx_clue_fail(rng):
    """线索板连线失败：线断 (清脆断裂 + 下滑抽回) + 轻碰。"""
    dur = 0.6; n = int(dur * SR); y = np.zeros(n)
    k = int(0.02 * SR)
    snap = fft_filter(rng.standard_normal(k), lo=2000, hi=9000) * np.exp(-tvec(k) / 0.003)
    place(y, 0.0, snap / np.max(np.abs(snap)), False)
    k = int(0.3 * SR); tk = tvec(k)
    fr = 500 * np.exp(-tk / 0.08) + 120
    w = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-tk / 0.07)
    place(y, 0.005, 0.5 * w, False)
    place(y, 0.25, 0.4 * modal(rng, [(200, 1, .03), (450, .4, .02)], 0.15, 0.3, 200, 2000), False)
    return fade_edges(y, 0.0003, 0.05)

def sfx_testimony_flip(rng):
    """证词条翻出：纸片弹起 + 短嗖 + 拍落。"""
    dur = 0.45; n = int(dur * SR); t = tvec(n); y = np.zeros(n)
    k = int(0.03 * SR)
    place(y, 0.0, 0.6 * fft_filter(rng.standard_normal(k), lo=1500, hi=7000) * np.exp(-tvec(k) / 0.006), False)
    sw = fft_filter(rng.standard_normal(n), lo=400, hi=3000) * np.exp(-0.5 * ((t - 0.12) / 0.05) ** 2)
    y += 0.5 * sw / np.max(np.abs(sw))
    k = int(0.06 * SR)
    place(y, 0.22, 0.7 * fft_filter(rng.standard_normal(k), lo=200, hi=4000) * np.exp(-tvec(k) / 0.01), False)
    return fade_edges(y, 0.0003, 0.05)

def sfx_sanity_restore(rng):
    """心烛回复：素歌一句 + 烛火趋于平稳 (立体声)。"""
    dur = 3.6; m = Mix(dur, False, rng); n = m.L; t = tvec(n)
    notes = [(50, .45), (53, .45), (55, .45), (57, 1.3)]
    tot = sum(d for _, d in notes) + 0.4; k = int(tot * SR)
    f = np.zeros(k); keys = []; tt = 0.0
    for i, (nn, d) in enumerate(notes):
        f[int(tt * SR):] = mtof(nn); keys.append((tt + 0.05, 'aoea'[i])); tt += d
    f = np.exp(fft_filter(np.log(np.maximum(f, 50)), hi=10))
    y = vox(k, f, keys + [(tot, 'a')], env_ar(k, 0.15, 0.8, 1.3), rng, breath=0.12)
    m.add(0.1, y, 0.45, 0.0, rev=0.55)
    d = drone_periodic(n, mtof(38), rng, harm=(1, .4, .2)) * np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    m.add(0, d, 0.08, 0.0, rev=0.4)
    fl = flame(n, rng) * (1 + 0.8 * np.exp(-t / 0.6) * np.sin(2 * np.pi * 9 * t)) * np.sin(np.pi * t / dur)
    m.add(0, fl, 0.12, 0.3, rev=0.1)
    out = m.render(make_ir(rng, 3.0, 3.0, dark=1.3), make_ir(rng, 3.0, 3.0, dark=1.3), wet=0.5)
    return fade_edges(out, 0.005, 0.4)

# ============================================================ 语音占位 (非语言)
def vo_edric_hm(rng):
    n = int(0.65 * SR); t = tvec(n)
    f = 105 * 2 ** (6 * np.clip((t - 0.15) / 0.4, 0, 1) ** 1.5 / 12)
    return fade_edges(vox(n, f, [(0, 'm'), (0.65, 'm')], env_ar(n, 0.06, 0.15, 1.2), rng, breath=0.15), 0.005, 0.05)

def vo_edric_sneer(rng):
    n = int(0.55 * SR); t = tvec(n)
    nose = formant_noise(n, [(0, 'm'), (0.55, 'm')], rng, bw_mul=4) * np.exp(-0.5 * ((t - 0.08) / 0.04) ** 2)
    hm = vox(n, 115 * (1 - 0.2 * t / 0.55), [(0, 'm'), (0.55, 'm')], np.clip((t - 0.1) / 0.03, 0, 1) * np.exp(-np.maximum(t - 0.13, 0) / 0.12), rng, breath=0.2)
    return fade_edges(0.6 * nose / np.max(np.abs(nose)) + hm, 0.003, 0.05)

def vo_edric_gasp(rng):
    n = int(0.6 * SR); t = tvec(n)
    amp = np.clip(t / 0.12, 0, 1) * np.exp(-np.maximum(t - 0.3, 0) / 0.08)
    y = vox(n, 140 * (1 + 0.3 * t), [(0, 'o'), (0.3, 'a'), (0.6, 'a')], amp, rng, breath=1.0, voiced=0.15)
    return fade_edges(y, 0.003, 0.05)

def vo_osbert_sob(rng):
    dur = 2.2; n = int(dur * SR); t = tvec(n); y = np.zeros(n)
    for i, st in enumerate([0.0, 0.2, 0.38]):
        k = int(0.14 * SR)
        place(y, st, 0.5 * formant_noise(k, [(0, 'i'), (0.14, 'e')], rng) * np.hanning(k), False)
    k = int(1.5 * SR); tk = tvec(k)
    f = 150 * (1 - 0.15 * tk / 1.5) * (1 + 0.03 * np.sin(2 * np.pi * 7 * tk) + 0.02 * smooth_noise(k, 15, rng))
    w = vox(k, f, [(0, 'u'), (0.8, 'o'), (1.5, 'u')], env_ar(k, 0.1, 0.6, 1.3) * (0.7 + 0.3 * np.abs(np.sin(2 * np.pi * 3 * tk))), rng, breath=0.5, jitter=15)
    place(y, 0.6, w, False)
    return fade_edges(y, 0.003, 0.1)

def vo_ysolde_sneer(rng):
    dur = 0.7; n = int(dur * SR); y = np.zeros(n)
    for st, f0 in [(0.02, 230), (0.22, 215)]:
        k = int(0.17 * SR); tk = tvec(k)
        a = np.clip(tk / 0.01, 0, 1) * np.exp(-tk / 0.07)
        place(y, st, vox(k, f0 * (1 - 0.1 * tk / 0.17), [(0, 'm'), (0.17, 'm')], a, rng, breath=0.6, fscale=1.17), False)
    return fade_edges(y, 0.003, 0.05)

def vo_ysolde_laugh_break(rng):
    dur = 3.0; n = int(dur * SR); y = np.zeros(n); st = 0.05; f0 = 250
    for i in range(9):
        k = int(0.16 * SR); tk = tvec(k)
        a = np.clip((tk - 0.03) / 0.01, 0, 1) * np.exp(-np.maximum(tk - 0.04, 0) / 0.05)
        br = np.clip(1 - tk / 0.05, 0, 1)
        f = f0 * (1 + 0.03 * rng.standard_normal()) * (1 - 0.05 * tk / 0.16)
        place(y, st, vox(k, f * np.ones(k), [(0, 'a'), (0.16, 'a')], np.maximum(a, 0.3 * br), rng, breath=0.5 + br, fscale=1.17, jitter=20 + 5 * i), False)
        st += max(0.13, 0.24 - 0.015 * i); f0 *= 1.035
    k = int(1.0 * SR); tk = tvec(k)   # 崩溃：抽泣式吸气 + 颤抖哭腔
    place(y, st + 0.1, 0.6 * formant_noise(int(0.3 * SR), [(0, 'i'), (0.3, 'a')], rng) * np.hanning(int(0.3 * SR)), False)
    f = 330 * (1 - 0.25 * tk) * (1 + 0.04 * np.sin(2 * np.pi * 8 * tk))
    place(y, st + 0.45, vox(k, f, [(0, 'a'), (1.0, 'u')], env_ar(k, 0.05, 0.6, 1.3), rng, breath=0.6, fscale=1.17, jitter=30), False)
    return fade_edges(y, 0.003, 0.1)

# ============================================================ 第二章《血脉》
# 摇篮曲母题 (原创)：“线轴转，银铃响，小羊睡，月亮闭眼”，D 自然小调/多利亚，四句，每句一个意象。
LULLABY = [  # 每句 [(midi, 拍)]；最后一句收在主音 D
    [(69, 1), (72, 1), (69, 1), (67, 3)],            # 线轴转
    [(65, 1), (67, 1), (69, 1), (64, 3)],            # 银铃响
    [(62, 1), (65, 1), (64, 1), (62, 1), (60, 2)],   # 小羊睡
    [(62, 1), (64, 1), (65, 1), (64, 1), (62, 4)],   # 月亮闭眼
]
LULLABY_VOW = [['i', 'o', 'a', 'a'], ['i', 'i', 'a', 'a'], ['a', 'a', 'a', 'u', 'e'], ['e', 'a', 'i', 'a', 'a']]

def lullaby_events(phrases, beat, t0=0.0, transpose=0, gap=0.0, drop_last=False):
    """把摇篮曲句子展开成 [(t, midi, 时值秒, 句号, 音号)]。drop_last：每句都在最后一个音之前停住。"""
    ev = []; t = t0
    for pi in phrases:
        notes = LULLABY[pi]
        for k, (mm, d) in enumerate(notes):
            if not (drop_last and k == len(notes) - 1):
                ev.append((t, mm + transpose, d * beat, pi, k))
            t += d * beat
        t += gap
    return ev, t

def recorder(f, dur, rng, vib=9, breath=0.07):
    """芦笛/竖笛：近正弦 + 少量谐波，起音“气嗤”，延迟揉音，气声。"""
    n = int(dur * SR); t = tvec(n)
    cents = vib * np.sin(2 * np.pi * rng.uniform(4.8, 5.6) * t) * np.clip((t - 0.35) / 0.5, 0, 1) + 5 * smooth_noise(n, 1.2, rng)
    ph = 2 * np.pi * np.cumsum(f * 2 ** (cents / 1200)) / SR
    y = np.sin(ph) + 0.22 * np.sin(2 * ph + 0.4) + 0.12 * np.sin(3 * ph + 1.1) + 0.03 * np.sin(4 * ph)
    nz = fft_filter(rng.standard_normal(n), lo=f * 1.5, hi=min(9000, f * 8)); nz /= np.std(nz) + 1e-9
    y = y + breath * nz * (0.6 + 0.4 * smooth_noise(n, 6, rng))
    k = min(n, int(0.05 * SR))
    chiff = fft_filter(rng.standard_normal(k), lo=1500, hi=6500) * np.exp(-tvec(k) / 0.012)
    y[:k] += 0.35 * chiff / (np.max(np.abs(chiff)) + 1e-9)
    return y * env_ar(n, 0.05, min(0.3, dur * 0.4), 1.3)

def dulcimer(f, dur, rng):
    """扬琴/小铃组：两根略失谐的亮弦，硬槌敲击。"""
    a = lute(f * 2 ** (3.5 / 1200), dur, rng, bright=0.95, t60=2.8, pos=0.11, body_amt=0.02)
    b = lute(f * 2 ** (-3.5 / 1200), dur, rng, bright=0.95, t60=2.6, pos=0.13, body_amt=0.02)
    return fade_edges((a + b) / 2, 0.0005, 0.1)

def word(rng, seg, f0=104, breath=0.25, voiced=1.0, fscale=1.0, fall=0.12):
    """共振峰“念字”：seg=[(音素, 秒)]，'_' 开头为塞音爆破 (占位，非真人录音)。"""
    dur = sum(d for _, d in seg) + 0.25
    n = int(dur * SR); t = tvec(n)
    keys = []; amp = np.zeros(n); tt = 0.0; bursts = []
    for ph_, d in seg:
        a0, a1 = int(tt * SR), int((tt + d) * SR)
        if ph_.startswith('_'):
            bursts.append((tt + d, ph_))
        else:
            keys += [(tt + 0.015, ph_), (tt + d - 0.015, ph_)]
            amp[a0:a1] = 0.55 if ph_ in ('m', 'r', 'l') else 1.0
        tt += d
    keys = [(0, keys[0][1])] + keys + [(dur, keys[-1][1])]
    amp = fft_filter(amp, hi=40)
    f = f0 * (1.06 - fall * t / dur)
    y = vox(n, f, keys, amp, rng, breath=breath, voiced=voiced, fscale=fscale)
    pk = np.max(np.abs(y)) + 1e-9
    for b, kind in bursts:
        k = int(0.04 * SR); s0 = int(b * SR)
        lo, tau, g = {'_d': (1500, .006, .3), '_k': (1200, .018, .55), '_t': (3000, .01, .45)}.get(kind, (1500, .008, .3))
        bz = fft_filter(rng.standard_normal(k), lo=lo, hi=5000) * np.exp(-tvec(k) / tau)
        place(y, b, g * pk * bz / np.max(np.abs(bz)), False)
    return fade_edges(y, 0.005, 0.05)

SEG_EDRIC = [('e', .22), ('_d', .045), ('r', .07), ('i', .16), ('_k', .06)]
SEG_MORDRAKE = [('m', .09), ('o', .17), ('r', .07), ('_d', .04), ('r', .05), ('e', .22), ('_k', .07)]

def edric_mordrake(rng, f0=102):
    """主角嗓音念“埃德里克·莫尔德雷克”(占位)。"""
    a = word(rng, SEG_EDRIC, f0 * 1.04, fall=0.08)
    b = word(rng, SEG_MORDRAKE, f0, fall=0.16)
    y = np.zeros(len(a) + int(0.12 * SR) + len(b))
    place(y, 0, a, False); place(y, len(a) / SR - 0.12, b, False)   # 两词间约 0.13 s 停顿 (word 自带尾部留白)
    return y

def sing(rng, notes, beat, vowels, f_mul=1.0, fscale=1.17, vib=16, breath=0.12, jitter=5):
    """把一串 (midi, 拍) 唱出来：滑音连接 + 延迟揉音。返回信号。"""
    total = sum(d for _, d in notes) * beat + 0.5
    n = int(total * SR); f = np.zeros(n); keys = []; tt = 0.0; amp = np.zeros(n)
    for k, (mm, d) in enumerate(notes):
        a0, a1 = int(tt * SR), int((tt + d * beat) * SR)
        f[a0:] = mtof(mm) * f_mul
        keys += [(tt + 0.06, vowels[k % len(vowels)]), (tt + d * beat - 0.05, vowels[k % len(vowels)])]
        e = np.ones(a1 - a0); kk = min(len(e) // 3, int(0.06 * SR))
        e[:kk] = np.linspace(0.55, 1, kk)   # 每个音节轻微重新起音
        amp[a0:a1] = e * (0.85 + 0.15 * (d > 1))
        tt += d * beat
    f = np.exp(fft_filter(np.log(np.maximum(f, 50)), hi=9))
    t = tvec(n)
    f *= 2 ** (vib * np.sin(2 * np.pi * 5.1 * t) * (0.4 + 0.6 * smooth_noise(n, 0.8, rng) ** 2) / 1200)
    amp = fft_filter(amp, hi=12) * env_ar(n, 0.08, 0.5, 1.3)
    return vox(n, f, keys + [(total, vowels[-1])], amp, rng, breath=breath, fscale=fscale, jitter=jitter)

def cough(rng, f0=95, dur=0.32, strength=1.0):
    """老人咳嗽：声门爆破 + 浊/噪混合的 'a→e' 共振峰。"""
    n = int(dur * SR); t = tvec(n)
    amp = np.clip(t / 0.006, 0, 1) * np.exp(-t / (dur * 0.35))
    y = vox(n, f0 * (1.3 - 0.4 * t / dur) * (1 + 0.05 * smooth_noise(n, 30, rng)), [(0, 'a'), (dur, 'e')], amp, rng,
            breath=1.4, voiced=0.35, jitter=40)
    k = int(0.012 * SR)
    y[:k] += 0.6 * strength * fft_filter(rng.standard_normal(k), lo=200, hi=3000) * np.exp(-tvec(k) / 0.003)
    return fade_edges(y / (np.max(np.abs(y)) + 1e-9), 0.001, 0.04)

def old_breath(L, rng, cycles, rattle=0.5):
    """老人沉重缓慢的呼吸 (循环安全)：吸气 'o' 高频气声，呼气 'a' 低沉带痰音。"""
    s = lfo(L, cycles, -np.pi / 2)
    nz = rng.standard_normal((2, L))
    inh = fft_filter(nz[0], lo=400, hi=2600, circular=True); inh /= np.std(inh)
    exh = fft_filter(nz[1], lo=90, hi=900, circular=True); exh /= np.std(exh)
    rat = 1 + rattle * np.clip(lfo(L, int(round(L / SR * 23))), 0, None) ** 3   # 约 23 Hz 痰音颤动 (整周期)
    return 0.45 * inh * np.clip(s, 0, None) ** 2.2 + 1.0 * exh * rat * np.clip(-s, 0, None) ** 1.6

def hollow_wood(rng, f=None, dur=0.35):
    """木雕月亮的空响：中空木块模态。"""
    f = f or rng.uniform(620, 980)
    return modal(rng, [(f, 1, .05), (f * 2.42, .45, .025), (f * 3.9, .2, .012), (f * .51, .25, .04)], dur, 0.25, 800, 5000, 0.002)

def footstep(rng):
    k = int(0.25 * SR)
    return modal(rng, [(rng.uniform(70, 95), 1, .05), (rng.uniform(180, 240), .5, .03)], 0.25, 0.5, 150, 1500, 0.01)

def harmonic_creak(dur, rng, f=1480):
    """远处像画框吱呀的弦乐泛音：细高弓擦泛音 + 下滑 + 弓噪。"""
    n = int(dur * SR); t = tvec(n)
    fr = f * 2 ** ((-60 * (t / dur) ** 2 + 6 * smooth_noise(n, 3, rng)) / 1200)
    ph = 2 * np.pi * np.cumsum(fr) / SR
    y = np.sin(ph) + 0.15 * np.sin(2 * ph) + 0.05 * np.sin(3 * ph)
    y *= 1 + 0.35 * smooth_noise(n, 25, rng)
    nz = fft_filter(rng.standard_normal(n), lo=f * 0.8, hi=f * 3); nz /= np.std(nz)
    return (y + 0.25 * nz) * np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 1.5

# ---------------- BGM
def bgm_r4_bedchamber(rng):
    """领主寝室：低音古提琴长音 + 走调小竖琴断续拨出摇篮曲头两句；速度与老人呼吸同频 (5 秒一息)，约 120 秒。"""
    L = loop_n(120); m = Mix(0, True, rng, n=L); LEN = L / SR
    breath_cyc = 24; bp = LEN / breath_cyc            # 一呼一吸 5.0 秒
    bl = 0.75 + 0.25 * lfo(L, breath_cyc, -np.pi / 2)   # 整首随呼吸起伏
    # 低音古提琴：长音，每两息换一次，偶尔小二度/三全音
    seq = [38, 38, 46, 45, 38, 39, 43, 45, 38, 44, 41, 45]
    sl = LEN / len(seq)
    for i, nn in enumerate(seq):
        dr = (lambda tt: -30 * np.clip((tt - 6) / 5, 0, 1)) if nn in (39, 44) else None
        m.add(i * sl - 0.4, bowed(mtof(nn), sl + 2.5, rng, att=2.5, rel=3.0, rough=0.35, vib_cents=4, drift=dr), 0.30, -0.1, rev=0.35)
        if i % 3 == 1:
            m.add(i * sl + 1.0, bowed(mtof(nn + 7), sl, rng, att=2.5, rel=3.0, rough=0.3, vib_cents=3), 0.10, 0.2, rev=0.45)
    m.dry *= bl; m.send *= bl
    # 走调小竖琴：每根弦固定偏 -35..+30 音分；只拨头两句，断续 (偶尔漏掉音)
    detune = {p: rng.uniform(-35, 30) for p in range(55, 80)}
    beat = bp / 4                                       # 一息四拍
    for start, ph_set in [(6 * bp, [0, 1]), (13 * bp, [0]), (18 * bp, [0, 1])]:
        ev, _ = lullaby_events(ph_set, beat, start, gap=beat * 2)
        for (t0, mm, d, pi, k) in ev:
            if rng.random() < 0.12 and k not in (0,): continue   # 断续：漏音
            fr = mtof(mm) * 2 ** (detune[mm] / 1200)
            m.add(t0 + rng.normal(0, 0.03), harp(fr, 3.5, rng, bright=0.55), 0.16 * rng.uniform(.75, 1), 0.3, rev=0.45)
    for st, h in [(33, 11), (88, 7)]:
        m.add(st, glint(mtof(38) * h, 6.0, rng), 0.025, -0.5, rev=0.7)
    m.add(70.0, fft_filter(bell(mtof(50) * 2 ** (-20 / 1200), 9.0, rng, bright=.4), hi=1800), 0.10, 0.5, rev=0.9)
    sub = np.sin(periodic_phase(np.full(L, mtof(26)))) * (0.4 + 0.6 * (bl - 0.5))
    m.dry += 0.05 * np.stack([sub, sub])
    out = m.render(make_ir(rng, 4.0, 2.6, dark=1.6), make_ir(rng, 4.0, 2.6, dark=1.6), wet=0.45)
    return fft_filter(out, hi=6000, circular=True)

def bgm_r5_gallery(rng):
    """长廊画像馆：空旷长混响里单支芦笛吹摇篮曲，每句都停在最后一个音之前；远处偶有画框吱呀般的弦乐泛音，约 120 秒。"""
    L = loop_n(120); m = Mix(0, True, rng, n=L); LEN = L / SR
    beat = 0.78
    for start, phs, tr in [(5.0, [0, 1, 2, 3], 0), (52.0, [2, 3], 0), (78.0, [0, 1, 2, 3], -12)]:
        ev, _ = lullaby_events(phs, beat, start, transpose=tr, gap=beat * 2.5, drop_last=True)
        for (t0, mm, d, pi, k) in ev:
            f = mtof(mm + 12)
            m.add(t0, recorder(f * 2 ** (rng.normal(0, 4) / 1200), d * 0.95 + 0.05, rng), 0.11, -0.15, rev=0.8)
    for st, f in [(24.0, 1480), (63.0, 1660), (101.0, 1245)]:
        m.add(st, harmonic_creak(rng.uniform(1.6, 2.4), rng, f), 0.025, rng.choice([-0.8, 0.8]), rev=0.9)
    for f, g in [(mtof(45), .02), (mtof(52), .012)]:     # 很薄的空五度底
        d = drone_periodic(L, f, rng, harm=(1, .3, .1), vib_cents=3, amp_cycles=3)
        m.dry += g * np.stack([d, d]); m.send += g * 0.8 * d
    nz = fft_filter(rng.standard_normal(L), lo=150, hi=900, circular=True); nz /= np.std(nz)
    m.send += 0.006 * nz * (0.6 + 0.4 * lfo(L, 4))     # 走廊空气
    ir = [make_ir(rng, 7.0, 6.0, dark=1.3, predelay=0.06) for _ in range(2)]
    return m.render(*ir, wet=0.85)

def bgm_r6_nursery(rng):
    """育婴室：八音盒般的扬琴/小铃组弹完整摇篮曲，每一遍更慢、更低；底下极轻的男声持续音 (神父)，约 150 秒。"""
    L = loop_n(150); m = Mix(0, True, rng, n=L); LEN = L / SR
    reps = 6; beats = [0.58 * 1.085 ** k for k in range(reps)]
    tot = sum(26 * b for b in beats); gap = (LEN - tot) / reps
    t = 1.0
    for k, b in enumerate(beats):
        cents = -38 * k                                 # 每遍低一点 (微分音下沉)
        ev, t_end = lullaby_events([0, 1, 2, 3], b, t)
        for (t0, mm, d, pi, kk) in ev:
            f = mtof(mm + 12) * 2 ** ((cents + rng.normal(0, 6)) / 1200)
            m.add(t0 + rng.normal(0, 0.01), music_box(f, rng, dur=2.6, detune_cents=0, sag=-10 - 4 * k), 0.10, 0.25, rev=0.45)
            m.add(t0, dulcimer(f / 2, 2.4, rng), 0.05, -0.15, rev=0.4)
        t = t_end + gap
    # 神父的极轻男声持续音：闭口哼 'm'→'u'，D2/A2
    for st, nn in [(0.0, 38), (37.0, 45), (75.0, 38), (112.0, 43)]:
        s = chant(mtof(nn), 42.0, rng, 'm', 'u', att=8, rel=9, voices=2, detune=5,
                  drift=lambda tt: 10 * np.sin(2 * np.pi * tt / 17))
        m.add(st, s, 0.10, 0.0, rev=0.5)
    for i in range(int(LEN / 2.5)):                    # 极弱钟摆 (摇篮的节拍感)
        if i % 4 == 0: m.add(i * LEN / int(LEN / 2.5), tick(rng, 1300), 0.012, 0.4, rev=0.3)
    sub = np.sin(periodic_phase(np.full(L, mtof(26)))) * (0.6 + 0.4 * lfo(L, 3))
    m.dry += 0.03 * np.stack([sub, sub])
    out = m.render(make_ir(rng, 3.5, 2.6, dark=1.2), make_ir(rng, 3.5, 2.6, dark=1.2), wet=0.5)
    return out

def bgm_ending_ch2(rng):
    """第二章章末 (0:50，非循环)：艾琳德清唱摇篮曲一遍；第二遍井下多人低声加入；末句换成主角嗓音念“埃德里克·莫尔德雷克”，骤停。"""
    dur = 50.0; m = Mix(dur, False, rng); n = m.L; t = tvec(n)
    beat1 = 0.85
    notes1 = [x for p in LULLABY for x in p]; vow1 = [v for p in LULLABY_VOW for v in p]
    s1 = sing(rng, notes1, beat1, vow1, f_mul=1.0, fscale=1.17, vib=14, breath=0.14)
    m.add(2.0, s1, 0.30, 0.0, rev=0.55)
    # 第二遍：前三句，女声 + 井下多人 (低八度/低十二度，水下)
    beat2 = 0.9; st2 = 2.0 + 26 * beat1 + 2.4
    notes2 = [x for p in LULLABY[:3] for x in p]; vow2 = [v for p in LULLABY_VOW[:3] for v in p]
    s2 = sing(rng, notes2, beat2, vow2, fscale=1.17, vib=14, breath=0.18)
    m.add(st2, s2, 0.26, 0.0, rev=0.6)
    for v, (tr, pan, g) in enumerate([(-12, -0.6, .16), (-12, 0.5, .14), (-19, -0.2, .14), (-24, 0.3, .12), (-12, 0.0, .1)]):
        sv = sing(rng, notes2, beat2, ['u', 'o', 'u', 'a', 'o'], f_mul=2 ** ((tr + rng.uniform(-0.3, 0.3)) / 12), fscale=1.0,
                  vib=8, breath=0.5, jitter=12)
        k = len(sv); sv *= np.linspace(0.25, 1.0, k) ** 1.5      # 越来越近
        m.add(st2 + rng.uniform(0.05, 0.35), sv, g, pan, rev=0.85, deep=True)
    t_name = st2 + 18 * beat2 + 0.6
    name = edric_mordrake(rng, f0=102)
    m.add(t_name, name, 0.75, 0.0, rev=0.25)
    cut = t_name + len(name) / SR + 0.35
    # 持续音：全曲低 D 空五度缓慢膨胀，第二遍起下沉
    sw = np.clip(t / cut, 0, 1) ** 1.6 * (t < cut)
    for nn, g in [(38, .5), (45, .35), (26, .3)]:
        fr = mtof(nn) * 2 ** (-40 * np.clip((t - st2) / (cut - st2), 0, 1) / 1200)
        ph = 2 * np.pi * np.cumsum(fr) / SR
        y = sum(a * np.sin((h + 1) * ph) for h, a in enumerate([1, .45, .25, .12]))
        m.add(0, y * (0.25 + 0.75 * sw), g * 0.12, rng.uniform(-.3, .3), rev=0.4, deep=True)
    out = m.render(make_ir(rng, 5.0, 4.0, dark=1.5, predelay=0.04), make_ir(rng, 5.0, 4.0, dark=1.5, predelay=0.04), wet=0.55)
    gate = np.ones(n); c = int(cut * SR); k = int(0.012 * SR)
    gate[c:c + k] = np.linspace(1, 0, k); gate[c + k:] = 0
    return fade_edges(out * gate, 1.0, 0.01)

# ---------------- 环境声 (循环)
def amb_bedchamber_breath(rng):
    """寝室：炭火低噼啪 + 老人沉重缓慢的呼吸 (5 秒一息) 与偶尔的咳嗽 + 窗外风声。"""
    L = loop_n(60); m = Mix(0, True, rng, n=L); LEN = L / SR
    br = old_breath(L, rng, 12, rattle=0.6)
    m.add(0, br, 0.022, -0.25, rev=0.25)
    for st in [21.3, 47.8]:
        for i in range(rng.integers(2, 4)):
            m.add(st + i * rng.uniform(0.35, 0.5), cough(rng, rng.uniform(85, 105)), 0.12 * (1 - 0.2 * i), -0.25, rev=0.3)
    nz = rng.standard_normal((3, L))
    ember = fft_filter(nz[0], lo=60, hi=400, circular=True); ember /= np.std(ember)
    m.dry += pan2(0.012 * ember * (0.7 + 0.3 * lfo(L, 7)), 0.3)
    t = 0.0
    while t < LEN:                                       # 炭火：比壁炉更稀、更低的噼啪
        if rng.random() < 0.25:
            k = int(rng.uniform(.01, .025) * SR)
            pop = modal(rng, [(rng.uniform(250, 800), 1, .01), (rng.uniform(1200, 2200), .4, .004)], k / SR, 0.6, 400, 3000, 0.004)
            m.add(t, pop, rng.uniform(.05, .14), rng.uniform(0.1, 0.5), rev=0.2)
        else:
            k = max(30, int(rng.uniform(.001, .003) * SR))
            c = fft_filter(rng.standard_normal(k), lo=1000, hi=5000) * np.exp(-tvec(k) / (k / SR / 3))
            m.add(t, c / (np.max(np.abs(c)) + 1e-9), rng.uniform(.01, .04), rng.uniform(0.1, 0.5), rev=0.1)
        t += rng.exponential(0.35)
    gust = np.clip(0.4 + 0.4 * lfo(L, 3, 1.0) + 0.2 * lfo(L, 8, 2.0), 0.05, None)
    w = fft_filter(nz[1], lo=200, hi=900, circular=True); w /= np.std(w)
    h = fft_filter(nz[2], lo=560, hi=590, order=4, circular=True); h /= np.std(h)
    m.dry += pan2(0.010 * w * gust + 0.006 * h * gust ** 2, 0.75)
    return m.render(make_ir(rng, 2.0, 1.2, dark=1.5), make_ir(rng, 2.0, 1.2, dark=1.5), wet=0.3)

def amb_gallery_draft(rng):
    """长廊：穿堂风 + 油灯火苗声 + 画框轻碰墙 + 很远处的脚步。"""
    L = loop_n(60); m = Mix(0, True, rng, n=L); LEN = L / SR
    nz = rng.standard_normal((4, L))
    gust = np.clip(0.5 + 0.3 * lfo(L, 2, 0.3) + 0.2 * lfo(L, 5, 1.7), 0.05, None)
    for ch, p in [(0, -0.7), (1, 0.7)]:
        w = fft_filter(nz[ch], lo=50, hi=700, circular=True); w /= np.std(w)
        m.dry += pan2(0.04 * w * gust, p)
    hw = fft_filter(nz[2], lo=380, hi=400, order=4, circular=True); hw /= np.std(hw)
    m.dry += pan2(0.008 * hw * gust ** 3, -0.3)
    fl = fft_filter(nz[3], lo=80, hi=700, circular=True); fl /= np.std(fl)
    fk = fft_filter(rng.standard_normal(L), hi=10, circular=True)
    flick = 0.6 + 0.4 * np.abs(fk) / np.std(fk)
    m.dry += pan2(0.010 * fl * np.clip(flick, 0, 2.5), 0.4)
    for st in [11.0, 12.1, 38.5, 52.0]:                 # 画框轻碰墙
        m.add(st, modal(rng, [(rng.uniform(160, 220), 1, .03), (rng.uniform(450, 600), .5, .02), (1300, .2, .01)], 0.2, 0.4, 300, 3000),
              0.10, rng.uniform(-0.6, 0.6), rev=0.6)
    t = 26.0                                             # 很远的脚步 (6 步)
    for i in range(6):
        m.add(t, footstep(rng), 0.06 * (1 - 0.1 * i), -0.4, rev=0.95, deep=True); t += rng.uniform(0.62, 0.72)
    ir = [make_ir(rng, 5.0, 4.0, dark=1.4, predelay=0.05) for _ in range(2)]
    return m.render(*ir, wet=0.45, deep_lfo_cycles=2)

def amb_nursery_creak(rng):
    """育婴室：木摇篮规律吱呀 (1.2 秒一次) + 木月亮吊饰轻碰 + 雪落窗上。"""
    L = loop_n(60); m = Mix(0, True, rng, n=L); LEN = L / SR
    N = 50; per = LEN / N                               # 恰好 1.2 秒一次 (整周期)
    for i in range(N):
        fwd = i % 2 == 0
        c = creak(rng.uniform(0.32, 0.4), rng, 40 if fwd else 55, 110 if fwd else 140,
                  modes=((260, 1, .03), (610, .7, .02), (1350, .4, .01), (2400, .2, .006)))
        m.add(i * per + rng.normal(0, 0.015), fft_filter(c, hi=3500), 0.07 * rng.uniform(.8, 1), -0.1 if fwd else 0.1, rev=0.3)
    t = 3.0
    while t < LEN:                                       # 吊饰轻碰
        for j in range(rng.integers(1, 3)):
            m.add(t + j * rng.uniform(0.08, 0.2), hollow_wood(rng), 0.05 * rng.uniform(.5, 1), rng.uniform(-0.3, 0.5), rev=0.5)
        t += rng.uniform(5.0, 11.0)
    nz = rng.standard_normal((2, L))
    snow = fft_filter(nz[0], lo=3000, hi=9000, circular=True); snow /= np.std(snow)
    m.dry += pan2(0.003 * snow * (0.6 + 0.4 * lfo(L, 3)), -0.7)
    taps = (rng.random(L) < 0.0006) * rng.uniform(.2, 1, L)
    taps = fft_filter(taps, lo=2500, hi=8000, circular=True)
    m.dry += pan2(0.02 * taps / (np.max(np.abs(taps)) + 1e-12), -0.7)
    room = fft_filter(nz[1], lo=40, hi=200, circular=True); room /= np.std(room)
    m.dry += 0.004 * np.stack([room, room])
    return m.render(make_ir(rng, 1.6, 0.9, dark=1.3), make_ir(rng, 1.6, 0.9, dark=1.3), wet=0.3)

# ---------------- 音效
def sfx_door_unlock(rng):
    """长廊门：钥匙插入 → 转动 (棘轮) → 锁舌咔 → 木门门闩滑开 → 门板轻震。"""
    dur = 1.6; n = int(dur * SR); t = tvec(n); y = np.zeros(n)
    k = int(0.14 * SR)
    ins = fft_filter(rng.standard_normal(k), lo=1800, hi=7000) * np.hanning(k) * (0.4 + (rng.random(k) < 0.03) * 2)
    place(y, 0.0, 0.3 * ins / np.max(np.abs(ins)), False)
    for i, st in enumerate([0.2, 0.26, 0.31]):
        place(y, st, 0.35 * modal(rng, [(2300, 1, .006), (4100, .5, .004), (900, .4, .012)], 0.06, 0.6), False)
    place(y, 0.4, 0.9 * modal(rng, [(330, 1, .04), (780, .6, .025), (1900, .5, .01), (3300, .3, .006)], 0.25, 0.6, 600, 5000, 0.004), False)
    k = int(0.4 * SR); tk = tvec(k)
    slide = grind(k, rng, 300, 3500, 80, 0.15) * np.sin(np.pi * tk / (k / SR)) ** 0.7
    place(y, 0.62, 0.45 * slide, False)
    place(y, 1.02, 0.8 * modal(rng, [(180, 1, .05), (420, .5, .03), (950, .3, .012)], 0.4, 0.4, 200, 2500, 0.01), False)
    y = y + 0.3 * conv(y, make_ir(rng, 1.4, 1.0, dark=1.3))[:n]
    return fade_edges(y, 0.002, 0.15)

def sfx_rattle(rng):
    """银摇铃：一声小铃，清脆但带一点哑 (久未摇动的弹丸铃，短衰减 + 内部弹丸碎响)。"""
    dur = 1.3; n = int(dur * SR); t = tvec(n); y = np.zeros(n)
    f = 2350
    for st, g in [(0.0, 1.0), (0.16, 0.55)]:
        tt = np.maximum(t - st, 0); on = t >= st
        for r, a, d in [(1, 1, .28), (1.83, .45, .14), (2.71, .5, .09), (3.9, .2, .05), (5.2, .1, .03)]:
            y += on * g * a * np.exp(-tt / d) * np.sin(2 * np.pi * f * r * (1 + 0.002 * g) * tt + r)
    for i in range(9):                                   # 弹丸在铃里滚动的细碎响
        place(y, rng.uniform(0.0, 0.3), 0.08 * clink(rng, rng.uniform(3500, 6000), 0.05), False)
    y = fft_filter(y, lo=300, hi=7000)                   # “哑”：去掉最亮的上段
    y = y + 0.2 * conv(y, make_ir(rng, 1.0, 0.7, dark=1.2))[:n]
    return fade_edges(y, 0.0005, 0.2)

def sfx_ice_hiss(rng):
    """冰杯靠近炭火：冰裂一声 + 化开的嘶声 + 滴水。"""
    dur = 2.6; n = int(dur * SR); t = tvec(n); y = np.zeros(n)
    place(y, 0.0, 0.6 * modal(rng, [(1900, 1, .015), (3700, .6, .008), (5200, .3, .005)], 0.1, 0.8, 2000, 9000, 0.002), False)
    nz = fft_filter(rng.standard_normal(n), lo=2500, hi=9000)
    crack = (rng.random(n) < 0.004) * rng.uniform(1, 3, n)
    sz = (nz / np.std(nz) * 0.5 + fft_filter(crack, lo=2000, hi=8000) * 6)
    env = np.clip((t - 0.05) / 0.15, 0, 1) * np.exp(-np.maximum(t - 0.25, 0) / 0.8)
    y += 0.25 * sz * env * (0.7 + 0.3 * smooth_noise(n, 15, rng))
    for st in [0.7, 1.25, 1.75, 2.15]:
        place(y, st, 0.35 * water_drop(rng.uniform(900, 1700), rng), False)
    return fade_edges(y, 0.001, 0.2)

def sfx_brazier_crackle(rng):
    """炭火盆：一阵炭火噼啪 + 暖风涌起 (立体声)。"""
    dur = 2.2; m = Mix(dur, False, rng); n = m.L; t = tvec(n)
    w = fft_filter(rng.standard_normal(n), lo=70, hi=700)
    w = w / np.max(np.abs(w)) * np.sin(np.pi * np.clip(t / 1.9, 0, 1)) ** 1.2
    m.add(0, w, 0.4, 0.0, rev=0.2)
    tt = 0.05
    while tt < 1.8:
        k = int(rng.uniform(.008, .025) * SR)
        pop = modal(rng, [(rng.uniform(300, 1100), 1, .01), (rng.uniform(1500, 3200), .5, .004)], k / SR, 0.7, 500, 5000, 0.003)
        m.add(tt, pop, rng.uniform(.2, .5), rng.uniform(-.5, .5), rev=0.15)
        tt += rng.exponential(0.09)
    m.add(0.3, flame(int(1.6 * SR), rng) * np.hanning(int(1.6 * SR)), 0.2, 0.0, rev=0.1)
    return fade_edges(m.render(make_ir(rng, 1.2, 0.8), make_ir(rng, 1.2, 0.8), wet=0.2), 0.002, 0.3)

def sfx_solvent_wipe(rng):
    """浸油的布擦过油画：三下沙沙，最后一下像轻轻的吸气 (立体声)。"""
    dur = 2.3; m = Mix(dur, False, rng)
    for i, (st, d) in enumerate([(0.0, 0.45), (0.5, 0.42), (0.98, 0.5)]):
        k = int(d * SR); tk = tvec(k)
        b = fft_filter(rng.standard_normal(k), lo=500, hi=5000) * np.sin(np.pi * tk / d) ** 0.8 * (0.7 + 0.3 * np.abs(smooth_noise(k, 40, rng)))
        b = b + 0.4 * fft_filter(rng.standard_normal(k), lo=150, hi=600) * np.sin(np.pi * tk / d)   # 湿布的闷感
        m.add(st, b / np.max(np.abs(b)), 0.4, -0.3 + 0.3 * i, rev=0.15)
    k = int(0.7 * SR); tk = tvec(k)
    inh = formant_noise(k, [(0, 'u'), (0.35, 'i'), (0.7, 'i')], rng, fscale=1.15) * np.sin(np.pi * tk / 0.7) ** 2 * np.linspace(0.4, 1, k)
    m.add(1.45, inh / np.max(np.abs(inh)), 0.22, 0.0, rev=0.6)
    return fade_edges(m.render(make_ir(rng, 2.0, 1.6, dark=1.4), make_ir(rng, 2.0, 1.6, dark=1.4), wet=0.35), 0.003, 0.3)

def sfx_nursery_door(rng):
    """育婴室矮木门：门闩 + 门轴长吱呀 + 门后一声很轻的木铃 (立体声)。"""
    dur = 2.8; m = Mix(dur, False, rng)
    m.add(0.0, modal(rng, [(900, 1, .015), (2100, .5, .008), (350, .4, .03)], 0.12, 0.5), 0.4, 0.0, rev=0.2)
    c = creak(1.2, rng, 30, 95, modes=((210, 1, .035), (520, .8, .02), (1150, .5, .01), (2300, .25, .006)))
    m.add(0.12, c, 0.5, -0.1, rev=0.35)
    wb = hollow_wood(rng, 1150, 1.0)
    wb2 = modal(rng, [(1150 * 1.5, .6, .18), (1150 * 2.76, .3, .08)], 1.0, 0)
    m.add(1.55, wb + wb2, 0.18, 0.5, rev=0.8)
    m.add(1.85, hollow_wood(rng, 1080, 0.8), 0.08, 0.55, rev=0.85)
    ir = [make_ir(rng, 2.5, 2.2, dark=1.4, predelay=0.03) for _ in range(2)]
    return fade_edges(m.render(*ir, wet=0.4), 0.002, 0.35)

def sfx_cradle_creak(rng):
    """月亮吊饰：几只木月亮互相碰撞的空响 + 摇篮吱呀一声。"""
    dur = 1.8; n = int(dur * SR); y = np.zeros(n)
    for st in [0.0, 0.11, 0.19, 0.42, 0.55]:
        place(y, st, 0.5 * rng.uniform(.5, 1) * hollow_wood(rng, rng.uniform(600, 1000), 0.3), False)
    c = creak(0.55, rng, 45, 120, modes=((260, 1, .03), (610, .7, .02), (1350, .4, .01), (2400, .2, .006)))
    place(y, 0.75, 0.55 * c, False)
    y = y + 0.25 * conv(y, make_ir(rng, 1.2, 0.8, dark=1.3))[:n]
    return fade_edges(y, 0.0005, 0.15)

def sfx_thread_stitch(rng):
    """针线：针穿布的“嗤”连续五下 (E·D·R·I·C)，最后一针后静音半秒。"""
    dur = 3.4; n = int(dur * SR); y = np.zeros(n)
    for i, st in enumerate([0.05, 0.55, 1.05, 1.55, 2.12]):
        k = int(0.06 * SR)
        poke = fft_filter(rng.standard_normal(k), lo=1500, hi=6000) * np.exp(-tvec(k) / 0.01)
        place(y, st, 0.4 * poke / np.max(np.abs(poke)), False)
        d = 0.26 + (0.08 if i == 4 else 0); k = int(d * SR); tk = tvec(k)
        fc = 2500 + 4000 * (tk / d)                      # 线被拉过布：上扬的窄带嘶
        nz = rng.standard_normal(k); out = np.zeros(k)
        for a in range(0, k, 512):
            seg = nz[a:a + 1024] if a + 1024 <= k else nz[a:]
            out[a:a + len(seg)] += fft_filter(seg, lo=fc[a] * 0.7, hi=fc[a] * 1.3) * np.hanning(len(seg))
        out *= np.sin(np.pi * tk / d) ** 0.6
        place(y, st + 0.04, 0.6 * out / (np.max(np.abs(out)) + 1e-9), False)
    y = y + 0.15 * conv(y, make_ir(rng, 0.8, 0.5))[:n]
    end = int((2.12 + 0.04 + 0.34 + 0.3) * SR)          # 最后一针约 2.5 s 结束，其后静音
    y[end:] *= np.exp(-tvec(n - end) / 0.03)
    return fade_edges(y, 0.0005, 0.02)

def sfx_lock_unlock(rng):
    """机关/门锁解开 (第一章楼梯门等)：沉重铁锁机械咔嗒 + 齿轮转动 + 锁舌弹开 + 轻微余响 (带一丝三全音泛音)。"""
    dur = 1.5; m = Mix(dur, False, rng); n = m.L
    m.add(0.0, modal(rng, [(1500, 1, .012), (3300, .5, .006), (520, .6, .03)], 0.12, 0.7), 0.5, 0.0, rev=0.2)
    tt = 0.12
    for i in range(7):                                   # 齿轮转动：渐慢的齿响 + 低金属
        m.add(tt, modal(rng, [(rng.uniform(2400, 2800), 1, .006), (rng.uniform(800, 1000), .6, .015), (260, .4, .03)], 0.08, 0.5),
              0.3 * (0.8 + 0.2 * rng.random()), -0.1 + 0.03 * i, rev=0.25)
        tt += 0.045 + 0.012 * i
    k = int(0.5 * SR); tk = tvec(k)
    gr = grind(k, rng, 200, 2500, 60, 0.12) * np.sin(np.pi * np.clip(tk / 0.35, 0, 1)) ** 0.8
    m.add(0.12, gr, 0.15, 0.0, rev=0.2)
    clunk = modal(rng, [(140, 1, .07), (310, .7, .05), (690, .5, .03), (1210, .4, .02), (2750, .3, .008)], 0.6, 0.8, 500, 6000, 0.004)
    m.add(0.6, clunk, 0.95, 0.0, rev=0.35)
    k = int(0.45 * SR); tk = tvec(k)                     # 锁舌弹簧
    spring = np.sin(2 * np.pi * np.cumsum(420 * (1 + 0.15 * np.exp(-tk / 0.05))) / SR) * np.exp(-tk / 0.09) * (1 + 0.3 * np.sin(2 * np.pi * 31 * tk))
    m.add(0.62, spring, 0.18, 0.1, rev=0.3)
    m.add(0.66, glint(mtof(62) * 2 ** (6 / 12) * 2, 0.8, rng) * np.exp(-tvec(int(0.8 * SR)) / 0.3), 0.05, 0.3, rev=0.8)   # 三全音泛音
    m.add(0.66, glint(mtof(62) * 2, 0.8, rng) * np.exp(-tvec(int(0.8 * SR)) / 0.25), 0.04, -0.3, rev=0.8)
    ir = [make_ir(rng, 1.6, 1.2, dark=1.3, predelay=0.02) for _ in range(2)]
    return fade_edges(m.render(*ir, wet=0.35), 0.0005, 0.2)

# ---------------- 第二章语音占位 (可选，非语言)
def vo_alric_scoff(rng):
    n = int(0.5 * SR); t = tvec(n)
    nose = formant_noise(n, [(0, 'm'), (0.5, 'm')], rng, bw_mul=4) * np.exp(-0.5 * ((t - 0.06) / 0.035) ** 2)
    hm = vox(n, 128 * (1 - 0.25 * t / 0.5), [(0, 'm'), (0.5, 'm')], np.clip((t - 0.08) / 0.02, 0, 1) * np.exp(-np.maximum(t - 0.1, 0) / 0.09), rng, breath=0.25)
    return fade_edges(0.7 * nose / np.max(np.abs(nose)) + hm, 0.003, 0.05)

def vo_alric_breath(rng):
    dur = 1.8; n = int(dur * SR); t = tvec(n)
    y = formant_noise(n, [(0, 'a'), (1.0, 'o'), (dur, 'u')], rng, bw_mul=2.5) * np.clip(t / 0.15, 0, 1) * np.exp(-np.maximum(t - 0.4, 0) / 0.55)
    v = vox(n, 115 * (1 - 0.2 * t / dur), [(0, 'a'), (dur, 'u')], np.clip(t / 0.15, 0, 1) * np.exp(-np.maximum(t - 0.3, 0) / 0.35), rng, voiced=0.2)
    return fade_edges(y / np.max(np.abs(y)) + v, 0.003, 0.1)

def vo_severin_hum(rng):
    """神父闭口哼摇篮曲的一小句 (第一句，低八度)。"""
    y = sing(rng, LULLABY[0], 0.62, ['m', 'm', 'm', 'u'], f_mul=0.5, fscale=0.95, vib=6, breath=0.08, jitter=6)
    return fade_edges(y, 0.01, 0.2)

def vo_severin_sigh(rng):
    dur = 1.5; n = int(dur * SR); t = tvec(n)
    y = formant_noise(n, [(0, 'a'), (dur, 'u')], rng, bw_mul=2.2) * np.clip(t / 0.25, 0, 1) * np.exp(-np.maximum(t - 0.4, 0) / 0.4)
    v = vox(n, 100 * (1 - 0.2 * t / dur), [(0, 'a'), (dur, 'u')], np.clip(t / 0.2, 0, 1) * np.exp(-np.maximum(t - 0.3, 0) / 0.35), rng, voiced=0.3, breath=0.3)
    return fade_edges(y / np.max(np.abs(y)) * 0.8 + v, 0.003, 0.1)

def vo_godwin_cough(rng):
    dur = 1.6; n = int(dur * SR); y = np.zeros(n)
    for i, st in enumerate([0.0, 0.36, 0.68]):
        place(y, st, (1 - 0.2 * i) * cough(rng, 90 - 4 * i, 0.3), False)
    k = int(0.5 * SR)
    place(y, 1.05, 0.35 * formant_noise(k, [(0, 'o'), (0.5, 'a')], rng) * np.hanning(k), False)   # 喘
    return fade_edges(y, 0.002, 0.1)


# ============================================================ 注册表 (清单条目 → 函数)
# kind: bgm/amb 为长音频 (低响度、循环)；sfx/vo 为短音效
ITEMS = {
    'bgm_title':               dict(fn=bgm_title, dir='bgm', st=True, seed=11, loop=True, lufs=-21),
    'bgm_r1_hall':             dict(fn=bgm_r1_hall, dir='bgm', st=True, seed=12, loop=True, lufs=-21),
    'bgm_r2_scriptorium':      dict(fn=bgm_r2_scriptorium, dir='bgm', st=True, seed=13, loop=True, lufs=-21),
    'bgm_r3_crypt':            dict(fn=bgm_r3_crypt, dir='bgm', st=True, seed=14, loop=True, lufs=-21),
    'bgm_interrogation':       dict(fn=bgm_interrogation, dir='bgm', st=True, seed=15, loop=True, lufs=-20),
    'bgm_clueboard':           dict(fn=bgm_clueboard, dir='bgm', st=True, seed=16, loop=True, lufs=-22),
    'bgm_ending_ch1':          dict(fn=bgm_ending_ch1, dir='bgm', st=True, seed=17, loop=False, lufs=-19),
    'amb_hall_fire':           dict(fn=amb_hall_fire, dir='amb', st=True, seed=21, loop=True, lufs=-28),
    'amb_tower_wind':          dict(fn=amb_tower_wind, dir='amb', st=True, seed=22, loop=True, lufs=-27),
    'amb_crypt_drip':          dict(fn=amb_crypt_drip, dir='amb', st=True, seed=23, loop=True, lufs=-28),
    'amb_whisper_low':         dict(fn=amb_whisper_low, dir='amb', st=True, seed=24, loop=True, lufs=-24),
    'amb_whisper_near':        dict(fn=amb_whisper_near, dir='amb', st=True, seed=25, loop=True, lufs=-22),
    'stinger_contradiction':   dict(fn=stinger_contradiction, dir='sfx', st=True, seed=31),
    'stinger_deduction':       dict(fn=stinger_deduction, dir='sfx', st=True, seed=32),
    'sfx_pickup':              dict(fn=sfx_pickup, dir='sfx', st=False, seed=41),
    'sfx_combine_success':     dict(fn=sfx_combine_success, dir='sfx', st=False, seed=42),
    'sfx_combine_fail':        dict(fn=sfx_combine_fail, dir='sfx', st=False, seed=43),
    'sfx_item_use':            dict(fn=sfx_item_use, dir='sfx', st=False, seed=44),
    'sfx_stone_sink':          dict(fn=sfx_stone_sink, dir='sfx', st=False, seed=45),
    'sfx_crest_rotate':        dict(fn=sfx_crest_rotate, dir='sfx', st=False, seed=46),
    'sfx_dial_click':          dict(fn=sfx_dial_click, dir='sfx', st=False, seed=47),
    'sfx_box_open':            dict(fn=sfx_box_open, dir='sfx', st=False, seed=48),
    'sfx_page_turn':           dict(fn=sfx_page_turn, dir='sfx', st=False, seed=49),
    'sfx_charcoal_reveal':     dict(fn=sfx_charcoal_reveal, dir='sfx', st=True, seed=50),
    'sfx_crow':                dict(fn=sfx_crow, dir='sfx', st=False, seed=51),
    'sfx_window_wind':         dict(fn=sfx_window_wind, dir='sfx', st=True, seed=52),
    'sfx_candle_light':        dict(fn=sfx_candle_light, dir='sfx', st=False, seed=53),
    'sfx_candle_out':          dict(fn=sfx_candle_out, dir='sfx', st=False, seed=54),
    'sfx_winch_chain':         dict(fn=sfx_winch_chain, dir='sfx', st=False, seed=55),
    'sfx_well_cover':          dict(fn=sfx_well_cover, dir='sfx', st=True, seed=56),
    'sfx_clue_connect':        dict(fn=sfx_clue_connect, dir='sfx', st=False, seed=57),
    'sfx_clue_fail':           dict(fn=sfx_clue_fail, dir='sfx', st=False, seed=58),
    'sfx_testimony_flip':      dict(fn=sfx_testimony_flip, dir='sfx', st=False, seed=59),
    'sfx_wrong':               dict(fn=sfx_wrong, dir='sfx', st=False, seed=60),
    'sfx_tap':                 dict(fn=sfx_tap, dir='sfx', st=False, seed=61),
    'sfx_sanity_restore':      dict(fn=sfx_sanity_restore, dir='sfx', st=True, seed=62),
    'vo_edric_hm':             dict(fn=vo_edric_hm, dir='vo', st=False, seed=71),
    'vo_edric_sneer':          dict(fn=vo_edric_sneer, dir='vo', st=False, seed=72),
    'vo_edric_gasp':           dict(fn=vo_edric_gasp, dir='vo', st=False, seed=73),
    'vo_osbert_sob':           dict(fn=vo_osbert_sob, dir='vo', st=False, seed=74),
    'vo_ysolde_sneer':         dict(fn=vo_ysolde_sneer, dir='vo', st=False, seed=75),
    'vo_ysolde_laugh_break':   dict(fn=vo_ysolde_laugh_break, dir='vo', st=False, seed=76),
    # ---- 第二章《血脉》
    'bgm_r4_bedchamber':       dict(fn=bgm_r4_bedchamber, dir='bgm', st=True, seed=111, loop=True, lufs=-21),
    'bgm_r5_gallery':          dict(fn=bgm_r5_gallery, dir='bgm', st=True, seed=112, loop=True, lufs=-22),
    'bgm_r6_nursery':          dict(fn=bgm_r6_nursery, dir='bgm', st=True, seed=113, loop=True, lufs=-22),
    'bgm_ending_ch2':          dict(fn=bgm_ending_ch2, dir='bgm', st=True, seed=114, loop=False, lufs=-19),
    'amb_bedchamber_breath':   dict(fn=amb_bedchamber_breath, dir='amb', st=True, seed=121, loop=True, lufs=-28),
    'amb_gallery_draft':       dict(fn=amb_gallery_draft, dir='amb', st=True, seed=122, loop=True, lufs=-28),
    'amb_nursery_creak':       dict(fn=amb_nursery_creak, dir='amb', st=True, seed=123, loop=True, lufs=-28),
    'sfx_door_unlock':         dict(fn=sfx_door_unlock, dir='sfx', st=False, seed=131),
    'sfx_rattle':              dict(fn=sfx_rattle, dir='sfx', st=False, seed=132),
    'sfx_ice_hiss':            dict(fn=sfx_ice_hiss, dir='sfx', st=False, seed=133),
    'sfx_brazier_crackle':     dict(fn=sfx_brazier_crackle, dir='sfx', st=True, seed=134),
    'sfx_solvent_wipe':        dict(fn=sfx_solvent_wipe, dir='sfx', st=True, seed=135),
    'sfx_nursery_door':        dict(fn=sfx_nursery_door, dir='sfx', st=True, seed=136),
    'sfx_cradle_creak':        dict(fn=sfx_cradle_creak, dir='sfx', st=False, seed=137),
    'sfx_thread_stitch':       dict(fn=sfx_thread_stitch, dir='sfx', st=False, seed=138),
    'sfx_lock_unlock':         dict(fn=sfx_lock_unlock, dir='sfx', st=True, seed=139),
    'vo_alric_scoff':          dict(fn=vo_alric_scoff, dir='vo', st=False, seed=171),
    'vo_alric_breath':         dict(fn=vo_alric_breath, dir='vo', st=False, seed=172),
    'vo_severin_hum':          dict(fn=vo_severin_hum, dir='vo', st=False, seed=173, lufs=-13),
    'vo_severin_sigh':         dict(fn=vo_severin_sigh, dir='vo', st=False, seed=174),
    'vo_godwin_cough':         dict(fn=vo_godwin_cough, dir='vo', st=False, seed=175),
}

def is_long(it):
    return it['dir'] in ('bgm', 'amb')

def write_wav(path, x):
    import wave
    x = np.atleast_2d(x)
    pcm = np.clip(np.round(x.T * 32767), -32768, 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(x.shape[0]); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())

def out_path(name, ext):
    return os.path.join(OUT, ITEMS[name]['dir'], f'{name}.{ext}')

def encode(name, x, tmpdir):
    it = ITEMS[name]; ch = 2 if it['st'] else 1
    wav = os.path.join(tmpdir, name + '.wav'); write_wav(wav, x)
    os.makedirs(os.path.join(OUT, it['dir']), exist_ok=True)
    run = lambda *a: subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', wav, '-map_metadata', '-1', *a], check=True)
    if is_long(it):
        run('-c:a', 'libvorbis', '-q:a', str(LONG_OGG_Q), out_path(name, 'ogg'))
        run('-c:a', 'aac', '-b:a', LONG_AAC, '-movflags', '+faststart', out_path(name, 'm4a'))
        run('-c:a', 'libmp3lame', *LONG_MP3, out_path(name, 'mp3'))
    else:
        run('-c:a', 'libvorbis', '-q:a', str(SFX_OGG_Q), out_path(name, 'ogg'))
        run('-c:a', 'aac', '-b:a', SFX_AAC[ch], '-movflags', '+faststart', out_path(name, 'm4a'))
        run('-c:a', 'libmp3lame', *SFX_MP3[ch], out_path(name, 'mp3'))

def quiet_seam(x, it):
    """循环是环形的，可任意旋转起点。选能量+高频最低的位置做接缝 (BGM 只在前 15% 内找，保留开头听感)。"""
    m = x.mean(0) if x.ndim == 2 else x
    e = np.abs(m) + 6 * np.abs(np.diff(m, append=m[:1]))
    win = 4096
    c = np.convolve(np.concatenate([e[-win // 2:], e, e[:win // 2]]), np.ones(win) / win, 'valid')[:len(m)]
    lim = int(len(m) * (0.15 if it['dir'] == 'bgm' else 1.0))
    cand, cc = [], c[:lim:64].copy()
    for _ in range(6):                      # 返回若干个彼此相隔 ≥1 s 的候选
        i = int(np.argmin(cc)); cand.append(i * 64)
        cc[max(0, i - SR // 64):i + SR // 64] = np.inf
        if not np.isfinite(cc).any(): break
    return cand

def seam_ok(name):
    for e in FORMATS:
        y = decode(out_path(name, e))[0]
        st = np.max(np.abs(np.diff(y, axis=1)), axis=0)
        if np.max(np.abs(y[:, 0] - y[:, -1])) > np.percentile(st, 99.9): return False
    return True

def build(names):
    with tempfile.TemporaryDirectory() as tmp:
        for name in names:
            it = ITEMS[name]
            rng = np.random.default_rng(it['seed'])
            x = np.asarray(it['fn'](rng), dtype=np.float64)
            if not it['st'] and x.ndim == 2: x = x.mean(0)
            if it['st'] and x.ndim == 1: x = np.stack([x, x])
            if it.get('loop'):
                x = x - np.mean(x, axis=-1, keepdims=True)   # 去直流 (循环整体平移不破坏连续)
                cands = quiet_seam(x, it); x0 = x   # 把接缝转到安静处，减小编码器边界误差
                x = np.roll(x0, -cands[0], axis=-1)
            assert np.all(np.isfinite(x)), name
            x = x / (np.max(np.abs(x)) + 1e-12) * db(LONG_PEAK_DB if is_long(it) else SFX_PEAK_DB)
            if it.get('lufs') is not None:
                w = os.path.join(tmp, '_meas.wav'); write_wav(w, x)
                lu = loudness(w)
                if lu > it['lufs']:
                    x *= db(it['lufs'] - lu)
            lim = (-3.0 if is_long(it) else -1.0) - 0.3
            for _ in range(4):   # 有损编码可能使峰值上冲：解码复核，超限则降增益重编
                encode(name, x, tmp)
                pk = max(20 * np.log10(np.max(np.abs(decode(out_path(name, e))[0])) + 1e-12) for e in FORMATS)
                if pk <= lim: break
                x *= db(lim - pk - 0.3)
            if it.get('loop'):
                g = np.max(np.abs(x)) / np.max(np.abs(x0))
                for c in cands[1:]:
                    if seam_ok(name): break
                    print(f'  {name}: seam retry at {c / SR:.2f}s', flush=True)
                    x = np.roll(x0, -c, axis=-1) * g; encode(name, x, tmp)
            print(f'built {name}: {x.shape[-1] / SR:.3f}s', flush=True)

# ============================================================ 自检
def decode(path):
    info = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', path],
                                     capture_output=True, text=True, check=True).stdout)['streams'][0]
    ch = int(info['channels'])
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', str(ch), '-ar', str(SR), '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, '<f4').reshape(-1, ch).T.astype(np.float64), info

def loudness(path):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', path, '-af', 'ebur128', '-f', 'null', '-'],
                       capture_output=True, text=True).stderr
    for line in r.splitlines()[::-1]:
        if line.strip().startswith('I:'):
            return float(line.split()[1])
    return float('nan')

def check():
    ok = True; report = {}
    for name, it in ITEMS.items():
        ref_n = None
        for ext in FORMATS:
            p = out_path(name, ext)
            if not os.path.exists(p):
                print('MISSING', p); ok = False; continue
            x, info = decode(p)
            nan = not np.all(np.isfinite(x))
            peak = 20 * np.log10(np.max(np.abs(x)) + 1e-12)
            clip = int(np.sum(np.abs(x) >= 0.999))
            lim = -3.0 if is_long(it) else -1.0
            good = (not nan) and clip == 0 and peak <= lim
            if ref_n is None: ref_n = x.shape[1]
            if it.get('loop'):
                d = np.abs(np.diff(x, axis=1)); typ = np.percentile(d, 99.9)
                seam = np.max(np.abs(x[:, 0] - x[:, -1]))
                msg = f' samples={x.shape[1]} seam={seam:.5f} (p99.9 step {typ:.5f})'
                good = good and seam <= typ and x.shape[1] == ref_n and x.shape[1] % 1024 == 0
            else:
                msg = f' head={np.max(np.abs(x[:, :2])):.4f} tail={np.max(np.abs(x[:, -32:])):.5f}'
                good = good and np.max(np.abs(x[:, -32:])) < 0.003
            lufs = loudness(p); size = os.path.getsize(p)
            report.setdefault(name, {})[ext] = dict(dur=round(x.shape[1] / SR, 3), peak=round(peak, 2), lufs=lufs, kb=round(size / 1024, 1))
            print(f"{'OK ' if good else 'BAD'} {it['dir']}/{name}.{ext:4s} {x.shape[1]/SR:7.3f}s peak {peak:6.2f} dBFS {lufs:6.1f} LUFS "
                  f"{size/1024:7.1f} KB ch={info['channels']} nan={nan} clip={clip}{msg}", flush=True)
            ok &= good
    man = {'sample_rate': SR, 'formats_by_preference_ios_first': ['m4a', 'ogg', 'mp3'], 'files': {}}
    for name, it in ITEMS.items():
        e = {'dir': it['dir'], 'channels': 2 if it['st'] else 1, 'loop': bool(it.get('loop')),
             'src': {ext: f"{it['dir']}/{name}.{ext}" for ext in FORMATS}}
        if name in report and 'ogg' in report[name]:
            e['duration'] = report[name]['ogg']['dur']
            if it.get('loop'):
                e.update(loopStart=0.0, loopEnd=e['duration'])
        man['files'][name] = e
    with open(os.path.join(OUT, 'audio_manifest.json'), 'w') as fh:
        json.dump(man, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(HERE, 'check_report.json'), 'w') as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    print('ALL OK' if ok else 'SOME CHECKS FAILED')
    return ok

def clean_stale():
    """删除输出目录中不属于清单的旧音频。"""
    keep = {os.path.abspath(out_path(n, e)) for n in ITEMS for e in FORMATS}
    for root, _, files in os.walk(OUT):
        if os.path.abspath(root).startswith(HERE): continue
        for f in files:
            p = os.path.abspath(os.path.join(root, f))
            if f.rsplit('.', 1)[-1] in ('ogg', 'm4a', 'mp3', 'wav') and p not in keep:
                os.remove(p); print('removed stale', p)

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', nargs='*')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    if not a.check:
        build(a.only or list(ITEMS))
        if not a.only: clean_stale()
    sys.exit(0 if check() else 1)
