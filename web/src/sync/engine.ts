import {
  ClientActionEnum,
  epochNow,
  NTP_CONSTANTS,
  WSResponseSchema,
  type WSRequestType,
  type WSResponseType,
} from "@beatsync/shared";
import { audioEngine, isAudioContextPaused } from "./audio";
import {
  calculateOffsetEstimate,
  calculateWaitTimeMilliseconds,
  handleNTPResponse,
  resetProbeState,
  sendProbePair,
  type NTPMeasurement,
} from "./clock";

export type EnginePhase =
  | "idle" // waiting for the user to tap
  | "connecting"
  | "syncing" // connected, gathering NTP measurements
  | "ready" // synced + buffers loaded, waiting for playback
  | "reconnecting";

export interface EngineState {
  phase: EnginePhase;
  joined: boolean;
  isPlaying: boolean;
  trackName: string | null;
  /** Raw registered URL of the playing source (for art sidecar lookup) */
  trackUrl: string | null;
  listenerCount: number;
  sourcesLoaded: number;
  sourcesTotal: number;
  offsetMs: number;
  rttMs: number;
  reconnectAttempt: number;
}

// Room matches the plugin's Room ID setting (default 000000); override with ?room=
const ROOM_ID = new URLSearchParams(location.search).get("room") ?? "000000";
const MAX_MEASUREMENTS = NTP_CONSTANTS.MAX_MEASUREMENTS;
const CONNECTION_TIMEOUT_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 15;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;

interface AudioSourceState {
  url: string;
  status: "idle" | "loading" | "loaded" | "error";
  buffer?: AudioBuffer;
}

const displayName = (url: string): string => {
  try {
    const file = decodeURIComponent(url.split("/").pop() ?? url);
    return file.replace(/\.[a-z0-9]+$/i, "");
  } catch {
    return url;
  }
};

/**
 * FalconBeat sync engine: owns the WebSocket, the NTP clock estimate, the
 * audio buffers, and scheduled playback. UI subscribes to state snapshots.
 */
export class SyncEngine {
  private ws: WebSocket | null = null;
  private measurements: NTPMeasurement[] = [];
  private offsetEstimate = 0;
  private rttEstimate = 0;
  private isSynced = false;

  private joined = false; // user has tapped "listen" (audio unlocked)
  private sources = new Map<string, AudioSourceState>();

  private currentSource: AudioBufferSourceNode | null = null;
  private isPlaying = false;
  private currentUrl: string | null = null;
  private playbackStartCtxTime = 0; // audioContext.currentTime at scheduled start
  private playbackOffset = 0; // track position at scheduled start
  private trackDuration = 0;

  private heartbeatTimer: number | null = null;
  private mediaWired = false;
  private lastNtpRequestAt: number | null = null;
  private reconnectTimer: number | null = null;
  private connectWatchdog: number | null = null;
  private reconnectAttempt = 0;
  private listenerCount = 0;

  private listeners = new Set<() => void>();
  private snapshot: EngineState;

  constructor() {
    this.snapshot = this.computeSnapshot();

    audioEngine.setStateChangeCallback((state) => {
      // iOS can suspend/interrupt the context (calls, Control Center). If we
      // were mid-play, audio is now desynced — stop and resync on resume.
      if (isAudioContextPaused(state) && this.isPlaying) {
        this.stopPlaybackLocal();
        this.emit();
      }
      if (state === "running" && this.joined) this.requestSync();
    });

    // Wake events are event-driven and fire even when timers are throttled.
    window.addEventListener("online", () => this.reconnectNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      this.reconnectNow();
      if (this.ws?.readyState === WebSocket.OPEN) this.scheduleHeartbeat();
    });
    // iOS bfcache: frozen pages restore without re-running mount effects.
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) this.reconnectNow();
    });
  }

  // ── Public API ───────────────────────────────────────────────────

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): EngineState => this.snapshot;

  /**
   * User gesture entry point. Creates/resumes the AudioContext inside the
   * gesture (autoplay policy), connects the socket, requests room sync.
   */
  async join(): Promise<void> {
    if (this.joined) return;
    this.joined = true;
    try {
      await audioEngine.resume();
    } catch (e) {
      console.warn("AudioContext resume failed", e);
    }
    // The hidden media element is what puts us in the OS media widget. Its
    // pause/play events also serve as the control surface on browsers that
    // don't support mediaSession action handlers (Firefox): pausing the
    // element from the notification leaves, playing rejoins.
    const el = audioEngine.getMediaElement();
    if (el && !this.mediaWired) {
      this.mediaWired = true;
      el.addEventListener("pause", () => {
        if (this.joined) this.leave();
      });
      el.addEventListener("play", () => {
        if (!this.joined) void this.join();
      });
    }
    audioEngine.playMediaElement();
    this.connect();
    this.requestSync();
    this.loadAllSources();
    this.emit();
  }

  leave(): void {
    this.joined = false;
    this.stopPlaybackLocal();
    // joined is already false, so the element's 'pause' handler no-ops.
    audioEngine.pauseMediaElement();
    this.teardownSocket();
    this.emit();
  }

  /** Playhead position in seconds for the UI progress display */
  getTrackPosition(): { position: number; duration: number } | null {
    if (!this.isPlaying) return null;
    const elapsed = audioEngine.getCurrentTime() - this.playbackStartCtxTime;
    return {
      position: Math.min(Math.max(0, this.playbackOffset + elapsed), this.trackDuration),
      duration: this.trackDuration,
    };
  }

  // ── WebSocket lifecycle ──────────────────────────────────────────

  private wsUrl(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const clientId = this.clientId();
    const username = `listener-${clientId.slice(0, 6)}`;
    return `${proto}://${location.host}/ws?roomId=${ROOM_ID}&username=${username}&clientId=${clientId}`;
  }

  private clientId(): string {
    let id = localStorage.getItem("falconbeat-client-id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("falconbeat-client-id", id);
    }
    return id;
  }

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.teardownSocket();

    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.clearReconnectTimers();
      this.scheduleHeartbeat();
      this.emit();
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      resetProbeState();
      this.measurements = [];
      this.offsetEstimate = 0;
      this.isSynced = false;
      if (this.joined) this.scheduleReconnect();
      this.emit();
    };

    ws.onerror = () => {
      // onclose follows; reconnect handled there
    };

    ws.onmessage = (ev) => this.onMessage(ev);
  }

  private teardownSocket(): void {
    if (!this.ws) return;
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.ws.onmessage = null;
    this.ws.onopen = null;
    try {
      this.ws.close();
    } catch {}
    this.ws = null;
    this.stopHeartbeat();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempt++;
    if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      // Give up but stay joined; next visibility/online event resets the budget
      return;
    }
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(1.5, this.reconnectAttempt - 1), RECONNECT_MAX_MS);
    const delay = base + Math.random() * 0.15 * base;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      // Safari can silently drop the connect attempt — watchdog retries
      this.connectWatchdog = window.setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.teardownSocket();
          this.scheduleReconnect();
        }
      }, CONNECTION_TIMEOUT_MS);
    }, delay);
  }

  private reconnectNow(): void {
    if (!this.joined) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.reconnectAttempt = 0;
    this.clearReconnectTimers();
    this.connect();
  }

  private clearReconnectTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectWatchdog) {
      clearTimeout(this.connectWatchdog);
      this.connectWatchdog = null;
    }
  }

  // ── NTP heartbeat ────────────────────────────────────────────────

  private scheduleHeartbeat(): void {
    this.stopHeartbeat();
    const tick = () => {
      // Staleness: a request went unanswered past the timeout → socket is dead
      // even if the browser hasn't noticed. Close it to trigger reconnect.
      if (this.lastNtpRequestAt && Date.now() - this.lastNtpRequestAt > NTP_CONSTANTS.RESPONSE_TIMEOUT_MS) {
        this.ws?.close();
        return;
      }
      this.lastNtpRequestAt = Date.now();
      if (this.ws) {
        sendProbePair({
          ws: this.ws,
          currentRTT: this.rttEstimate || undefined,
          compensationMs: audioEngine.getCompensationMs() || undefined,
        });
      }
      const interval =
        this.measurements.length < MAX_MEASUREMENTS
          ? NTP_CONSTANTS.INITIAL_INTERVAL_MS
          : NTP_CONSTANTS.STEADY_STATE_INTERVAL_MS;
      this.heartbeatTimer = window.setTimeout(tick, interval);
    };
    this.heartbeatTimer = window.setTimeout(tick, NTP_CONSTANTS.INITIAL_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.lastNtpRequestAt = null;
  }

  private addMeasurement(m: NTPMeasurement): void {
    this.measurements.push(m);
    if (this.measurements.length > MAX_MEASUREMENTS) this.measurements.shift();

    const { offset, roundTrip } = calculateOffsetEstimate(this.measurements);
    this.offsetEstimate = offset;
    this.rttEstimate = roundTrip;

    if (!this.isSynced && this.measurements.length >= MAX_MEASUREMENTS) {
      this.isSynced = true;
      // Sync just converged — make sure buffers are in flight and the room
      // knows we're here (covers "joined before WS finished connecting").
      this.loadAllSources();
      if (this.joined) this.requestSync();
    }
    this.emit();
  }

  private send(request: WSRequestType): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(request));
    }
  }

  private requestSync(): void {
    this.send({ type: ClientActionEnum.enum.SYNC });
  }

  // ── Message dispatch ─────────────────────────────────────────────

  private onMessage(ev: MessageEvent): void {
    let response: WSResponseType;
    try {
      response = WSResponseSchema.parse(JSON.parse(ev.data as string));
    } catch {
      console.warn("Unparseable server message", ev.data);
      return;
    }

    switch (response.type) {
      case "NTP_RESPONSE": {
        const m = handleNTPResponse(response);
        this.lastNtpRequestAt = null;
        if (m) this.addMeasurement(m);
        break;
      }
      case "LIVENESS_PING":
        this.send({ type: ClientActionEnum.enum.LIVENESS_PONG });
        if (this.ws) {
          sendProbePair({
            ws: this.ws,
            currentRTT: this.rttEstimate || undefined,
            compensationMs: audioEngine.getCompensationMs() || undefined,
          });
        }
        break;
      case "ROOM_EVENT":
        this.onRoomEvent(response.event);
        break;
      case "SCHEDULED_ACTION":
        this.onScheduledAction(response);
        break;
      case "DEMO_USER_COUNT":
        this.listenerCount = response.count;
        this.emit();
        break;
      // DEMO_AUDIO_READY_COUNT, SEARCH_RESPONSE, STREAM_JOB_UPDATE — unused
      default:
        break;
    }
  }

  private onRoomEvent(event: Extract<WSResponseType, { type: "ROOM_EVENT" }>["event"]): void {
    switch (event.type) {
      case "SET_AUDIO_SOURCES": {
        const live = new Set(event.sources.map((s) => s.url));
        for (const s of event.sources) {
          if (!this.sources.has(s.url)) this.sources.set(s.url, { url: s.url, status: "idle" });
        }
        // The plugin evicts played tracks from the room — drop their decoded
        // buffers too, or a long show accumulates every song in memory. The
        // currently-playing source keeps its entry (the buffer is alive in
        // the playing node regardless).
        for (const url of [...this.sources.keys()]) {
          if (!live.has(url) && url !== this.currentUrl) this.sources.delete(url);
        }
        if (this.joined) this.loadAllSources();
        this.emit();
        break;
      }
      case "LOAD_AUDIO_SOURCE": {
        const url = event.audioSourceToPlay.url;
        if (!this.sources.has(url)) {
          this.sources.set(url, { url, status: "idle" });
        }
        void this.loadSource(url);
        break;
      }
      case "CLIENT_CHANGE": {
        // Non-demo: every join/leave rebroadcasts the full client list.
        // Count non-admins — the plugin's admin WS (creator) and the bridge
        // shouldn't show up as listeners.
        this.listenerCount = event.clients.filter((c) => !c.isAdmin).length;
        this.emit();
        break;
      }
      default:
        break;
    }
  }

  private onScheduledAction(msg: Extract<WSResponseType, { type: "SCHEDULED_ACTION" }>): void {
    const { scheduledAction: action, serverTimeToExecute } = msg;
    switch (action.type) {
      case "PLAY":
        this.schedulePlay({
          audioSource: action.audioSource,
          trackTimeSeconds: action.trackTimeSeconds,
          targetServerTime: serverTimeToExecute,
        });
        break;
      case "PAUSE":
        this.schedulePause(serverTimeToExecute);
        break;
      case "GLOBAL_VOLUME_CONFIG":
        audioEngine.setMasterGain(action.volume, action.rampTime);
        break;
      default:
        // SPATIAL_CONFIG, METRONOME_CONFIG, LOW_PASS_CONFIG, STOP_SPATIAL_AUDIO
        break;
    }
  }

  // ── Audio source loading ─────────────────────────────────────────

  private resolveUrl(url: string): string {
    return url.startsWith("/") ? `${location.origin}${url}` : url;
  }

  private loadAllSources(): void {
    for (const [url, s] of this.sources) {
      if (s.status === "idle" || s.status === "error") void this.loadSource(url);
    }
  }

  private async loadSource(url: string): Promise<void> {
    const s = this.sources.get(url);
    if (!s || s.status === "loading" || s.status === "loaded") {
      if (s?.status === "loaded") {
        this.send({ type: ClientActionEnum.enum.AUDIO_SOURCE_LOADED, source: { url } });
      }
      return;
    }
    s.status = "loading";
    this.emit();

    try {
      const res = await fetch(this.resolveUrl(url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await audioEngine.decodeAudioData(await res.arrayBuffer());
      const cur = this.sources.get(url);
      if (cur) {
        cur.status = "loaded";
        cur.buffer = buf;
      }
      this.send({ type: ClientActionEnum.enum.AUDIO_SOURCE_LOADED, source: { url } });
    } catch (e) {
      const cur = this.sources.get(url);
      if (cur) cur.status = "error";
      console.error(`Failed to load ${url}:`, e);
    }
    this.emit();
  }

  // ── Scheduled playback ───────────────────────────────────────────

  /** ms until a server timestamp fires, minus local output latency */
  private waitSeconds(targetServerTime: number): number {
    const waitMs = calculateWaitTimeMilliseconds(targetServerTime, this.offsetEstimate);
    return Math.max(0, waitMs - audioEngine.getFilteredOutputLatencyMs()) / 1000;
  }

  private schedulePlay(data: {
    audioSource: string;
    trackTimeSeconds: number;
    targetServerTime: number;
  }): void {
    if (!this.joined) return; // pre-gesture: can't play anyway; SYNC on join covers us

    let waitSec = this.waitSeconds(data.targetServerTime);

    // Deadline already passed? Distinguish "network genuinely late" from
    // "output latency ate the buffer" — same logic as upstream client.
    if (waitSec < 0.05) {
      const rawWaitMs = calculateWaitTimeMilliseconds(data.targetServerTime, this.offsetEstimate);
      if (rawWaitMs < 50) {
        // Genuinely late — reschedule with a proportional buffer at the
        // recomputed track position instead of starting behind everyone.
        const missedByMs = 50 - rawWaitMs;
        const retryDelayMs = Math.min(missedByMs + 200, 2000);
        const elapsedMs = epochNow() + this.offsetEstimate - data.targetServerTime;
        const retryOffset = data.trackTimeSeconds + (elapsedMs + retryDelayMs) / 1000;
        this.startPlayback(data.audioSource, retryOffset, retryDelayMs / 1000);
        return;
      }
      waitSec = 0;
    }

    const source = this.sources.get(data.audioSource);
    if (!source || source.status !== "loaded") {
      // Buffer not ready — start/continue loading and ask the server where
      // playback will be in a second (upstream retry path).
      void this.loadSource(data.audioSource);
      setTimeout(() => this.requestSync(), 1000);
      return;
    }

    this.startPlayback(data.audioSource, data.trackTimeSeconds, waitSec);
  }

  private startPlayback(url: string, offsetSec: number, delaySec: number): void {
    const source = this.sources.get(url);
    if (!source?.buffer) return;
    if (!audioEngine.isRunning()) {
      console.warn("AudioContext not running; aborting play");
      return;
    }
    if (offsetSec >= source.buffer.duration) {
      console.warn(`Offset ${offsetSec.toFixed(2)}s past track end (${source.buffer.duration.toFixed(2)}s)`);
      return;
    }

    this.stopPlaybackLocal();

    const ctx = audioEngine.getContext();
    const node = audioEngine.createBufferSource();
    node.buffer = source.buffer;
    node.connect(audioEngine.getInputNode());

    const startTime = ctx.currentTime + delaySec;
    node.onended = () => {
      // Only react if this node is still the current one and it ran to the end
      if (this.currentSource === node && this.isPlaying) {
        const expectedEnd = this.playbackStartCtxTime + (this.trackDuration - this.playbackOffset);
        if (Math.abs(ctx.currentTime - expectedEnd) < 0.5) {
          this.isPlaying = false;
          this.currentSource = null;
          this.emit();
        }
      }
    };
    node.start(startTime, offsetSec);

    this.currentSource = node;
    this.isPlaying = true;
    this.currentUrl = url;
    this.playbackStartCtxTime = startTime;
    this.playbackOffset = offsetSec;
    this.trackDuration = source.buffer.duration;
    this.emit();
  }

  private schedulePause(targetServerTime: number): void {
    const waitSec = this.waitSeconds(targetServerTime);
    const node = this.currentSource;
    if (node) {
      try {
        node.stop(audioEngine.getCurrentTime() + waitSec);
      } catch {}
    }
    // Reflect the pending stop in UI immediately; isPlaying flips when it
    // fires — but only if no newer track has taken over currentSource in
    // the meantime (a pause between playlist songs must not clobber the
    // next track's state).
    window.setTimeout(() => {
      if (this.currentSource === node) {
        this.isPlaying = false;
        this.currentSource = null;
        this.emit();
      }
    }, waitSec * 1000);
    this.emit();
  }

  private stopPlaybackLocal(): void {
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
      } catch {}
      this.currentSource = null;
    }
    this.isPlaying = false;
  }

  // ── State snapshot ───────────────────────────────────────────────

  private computeSnapshot(): EngineState {
    const loaded = [...this.sources.values()].filter((s) => s.status === "loaded").length;
    let phase: EnginePhase = "idle";
    if (this.joined) {
      const connected = this.ws?.readyState === WebSocket.OPEN;
      if (!connected) phase = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
      else if (!this.isSynced) phase = "syncing";
      else phase = "ready";
    }
    return {
      phase,
      joined: this.joined,
      isPlaying: this.isPlaying,
      trackName: this.currentUrl ? displayName(this.currentUrl) : null,
      trackUrl: this.currentUrl,
      listenerCount: this.listenerCount,
      sourcesLoaded: loaded,
      sourcesTotal: this.sources.size,
      offsetMs: this.offsetEstimate,
      rttMs: this.rttEstimate,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  private emit(): void {
    this.snapshot = this.computeSnapshot();
    for (const cb of this.listeners) cb();
  }
}

export const syncEngine = new SyncEngine();
