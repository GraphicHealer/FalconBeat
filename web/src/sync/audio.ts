import { LOW_PASS_CONSTANTS } from "@beatsync/shared";

/** iOS 18+ uses a non-standard "interrupted" state (phone call, Siri) */
export const isAudioContextPaused = (state: AudioContextState | string | undefined | null): boolean =>
  state === "suspended" || state === "interrupted";

// Minimal silent WAV (1 sample, 44.1kHz, 16-bit mono, 46 bytes).
// On iOS < 16.4, WebAudio routes through the ringer channel and is muted by
// the hardware switch; playing any <audio> element forces the media channel.
const SILENCE_DATA_URL =
  "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==";

/**
 * Synthesize the hidden media element's audio file at runtime: 10 seconds
 * of a 15Hz subsonic sine, 8kHz/16-bit mono PCM WAV (~160KB blob). The
 * low sample rate keeps it small; 15Hz is well under Nyquist here.
 */
const makeToneWavUrl = (): string => {
  const seconds = 10;
  const freq = 15;
  const amp = 0.3;
  const rate = 8000;
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  writeStr(8, "WAVEfmt ");
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 2, Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
};

/** Reported outputLatency above this is garbage (e.g. Bluetooth reporting 648ms) */
const MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS = 100;

/**
 * Singleton AudioContext manager. One context for the app lifetime —
 * iOS caps contexts and repeated creation degrades performance.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private lowPass: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private silentAudioElement: HTMLAudioElement | null = null;
  private mediaElement: HTMLAudioElement | null = null;
  private mediaGestureWired = false;
  private hasRegisteredGestureListeners = false;
  private hasVisibilityListener = false;
  private stateChangeCallback: ((state: AudioContextState) => void) | null = null;

  private isIOS(): boolean {
    const ua = navigator.userAgent.toLowerCase();
    return (
      ua.includes("iphone") ||
      ua.includes("ipad") ||
      ua.includes("ipod") ||
      (ua.includes("mac os x") && navigator.maxTouchPoints > 0)
    );
  }

  getContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext();
      this.ctx.onstatechange = () => {
        const state = this.ctx?.state;
        if (state) this.stateChangeCallback?.(state);
      };
      this.setupGraph();
      this.registerSilentAudioBypass();
    }
    return this.ctx;
  }

  /** Entry point of the effect chain: source → lowPass → masterGain → destination */
  getInputNode(): AudioNode {
    this.getContext();
    return this.lowPass!;
  }

  /** Spectrum tap on the audible chain — the page's equalizer background. */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  getCurrentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  isRunning(): boolean {
    return this.ctx?.state === "running";
  }

  setStateChangeCallback(cb: (state: AudioContextState) => void): void {
    this.stateChangeCallback = cb;
  }

  /**
   * Resume from suspended/interrupted. Must be called inside (or downstream
   * of) a user gesture on iOS. Also grabs a screen wake lock.
   */
  async resume(): Promise<void> {
    const ctx = this.getContext();
    if (isAudioContextPaused(ctx.state)) {
      await ctx.resume();
    }
    await this.requestWakeLock();
  }

  /**
   * Read outputLatency, filtering garbage values. Wired speakers (~24ms) are
   * trustworthy; Bluetooth often reports nonsense — better ignored.
   */
  getFilteredOutputLatencyMs(): number {
    const rawMs = (this.getContext().outputLatency ?? 0) * 1000;
    return rawMs > MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS ? 0 : rawMs;
  }

  /** Total local playback latency the client subtracts from wait time */
  getCompensationMs(): number {
    return this.getFilteredOutputLatencyMs();
  }

  setMasterGain(value: number, rampTime = 0): void {
    if (!this.masterGain || !this.ctx) return;
    const clamped = Math.max(0, Math.min(1, value));
    if (rampTime > 0) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(clamped, now + rampTime);
    } else {
      this.masterGain.gain.value = clamped;
    }
  }

  /**
   * The hidden <audio> element that makes playback visible to OS media
   * controls. Its pause/play events are the control surface on browsers
   * without navigator.mediaSession action handlers (Firefox).
   */
  getMediaElement(): HTMLAudioElement | null {
    return this.mediaElement;
  }

  /** Play the media element so the OS shows its media widget. */
  playMediaElement(): void {
    const el = this.mediaElement;
    if (!el || !el.paused) return;
    el.play().catch(() => {
      // Gesture may have lapsed — retry on the next raw DOM gesture.
      if (this.mediaGestureWired) return;
      this.mediaGestureWired = true;
      const retry = () => {
        el.play()
          .then(() => {
            for (const evt of ["click", "touchend", "keydown"]) {
              window.removeEventListener(evt, retry, true);
            }
          })
          .catch(() => {});
      };
      for (const evt of ["click", "touchend", "keydown"]) {
        window.addEventListener(evt, retry, { capture: true, passive: true });
      }
    });
  }

  pauseMediaElement(): void {
    this.mediaElement?.pause();
  }

  createBufferSource(): AudioBufferSourceNode {
    return this.getContext().createBufferSource();
  }

  async decodeAudioData(buf: ArrayBuffer): Promise<AudioBuffer> {
    return this.getContext().decodeAudioData(buf);
  }

  private setupGraph(): void {
    if (!this.ctx) return;

    this.lowPass = this.ctx.createBiquadFilter();
    this.lowPass.type = "lowpass";
    this.lowPass.frequency.value = LOW_PASS_CONSTANTS.MAX_FREQ;
    this.lowPass.Q.value = 0.707;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;

    this.lowPass.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    // Side-chain only — feeds the page background's spectrum, no output.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 128;
    this.analyser.smoothingTimeConstant = 0.8;
    // Widen the dB window so loud passages don't pin every bar to the top.
    this.analyser.minDecibels = -85;
    this.analyser.maxDecibels = -10;
    this.masterGain.connect(this.analyser);

    // Browsers only surface OS-level media controls (Android shade/lockscreen,
    // Firefox's media notification — it doesn't implement navigator.mediaSession)
    // for a real media element; WebAudio alone is invisible to them. The
    // element also has to be playing audible media of a few seconds' duration
    // — a silent/empty stream keeps the widget hidden. This is a real WAV
    // file: a 15Hz subsonic tone, 10s, looped. Real audio energy satisfies
    // the audibility + duration checks; nothing reaches the ear or speaker.
    // All audible output stays on the synced ctx.destination path.
    const el = document.createElement("audio");
    el.src = makeToneWavUrl();
    el.loop = true;
    el.preload = "auto";
    el.disableRemotePlayback = true;
    this.mediaElement = el;

    // Bluetooth keepalive: -80dB 1Hz signal keeps the A2DP buffer from
    // resettling between pause/play cycles (browsers optimize away gain=0).
    const keepalive = this.ctx.createOscillator();
    keepalive.frequency.value = 1;
    const keepaliveGain = this.ctx.createGain();
    keepaliveGain.gain.value = 0.0001;
    keepalive.connect(keepaliveGain);
    keepaliveGain.connect(this.lowPass);
    keepalive.start();
  }

  /**
   * Screen wake lock prevents WiFi power-save mode, which buffers inbound
   * packets 100-300ms at the AP and destroys sync.
   */
  private async requestWakeLock(): Promise<void> {
    if (this.wakeLock) return;
    try {
      if ("wakeLock" in navigator) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => {
          this.wakeLock = null;
        });
        if (!this.hasVisibilityListener) {
          this.hasVisibilityListener = true;
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && !this.wakeLock) {
              this.requestWakeLock().catch(() => {});
            }
          });
        }
      }
    } catch {
      // best-effort
    }
  }

  /**
   * iOS <16.4 mute-switch bypass via looping silent <audio>. Must be triggered
   * from raw DOM gesture handlers (React synthetic events break the chain).
   */
  private registerSilentAudioBypass(): void {
    if (this.hasRegisteredGestureListeners) return;
    // @ts-expect-error audioSession only exists on iOS Safari 16.4+
    if (navigator.audioSession) return;
    if (!this.isIOS()) return;
    this.hasRegisteredGestureListeners = true;

    const audio = document.createElement("audio");
    audio.setAttribute("x-webkit-airplay", "deny");
    audio.controls = false;
    audio.disableRemotePlayback = true;
    audio.preload = "auto";
    audio.loop = true;
    audio.src = SILENCE_DATA_URL;
    audio.load();

    const tryPlay = () => {
      if (this.silentAudioElement) return;
      audio
        .play()
        .then(() => {
          this.silentAudioElement = audio;
          for (const evt of ["click", "touchend", "keydown"]) {
            window.removeEventListener(evt, tryPlay, true);
          }
        })
        .catch(() => {});
    };
    for (const evt of ["click", "touchend", "keydown"]) {
      window.addEventListener(evt, tryPlay, { capture: true, passive: true });
    }
  }
}

export const audioEngine = new AudioEngine();

// Set the iOS audio session to "playback" so sound comes out the media
// channel even with the hardware mute switch on (iOS 16.4+).
if (typeof window !== "undefined") {
  try {
    // @ts-expect-error audioSession only exists on iOS Safari 16.4+
    if (window.navigator.audioSession) window.navigator.audioSession.type = "playback";
  } catch {}
}
