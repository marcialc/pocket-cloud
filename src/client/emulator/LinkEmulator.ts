import { unzlibSync } from "fflate";
import type { Button } from "../../shared/platforms";
import type { Emulator } from "./Emulator";

/**
 * The game while linked with a friend: it runs on the link server (both GBAs
 * in one container, see link-server/), and this shows its screen and sound
 * and sends the buttons back over a WebSocket. It implements Emulator so the
 * keyboard, gamepad and touch controls and the volume work unchanged; there's
 * no battery save here (it comes back when the cable is pulled) and no pause,
 * since the friend's game runs on the same cable.
 *
 * Protocol (link-server/src/linkd.c), binary messages, little-endian:
 *   server: 0x00 player width(u16) height(u16) | 0x01 seq(u32) zlib(BGR555 XOR
 *           previous frame) | 0x02 ping echo | 0x03 rate(u32) mu-law sound
 *   client: 0x01 keys(u16) | 0x02 8-byte ping | 0x03 seq(u32) frame drawn |
 *           0x04 stats for the link server's logs (see linkd.c)
 *
 * Saying which frames were drawn keeps the server from getting more than a
 * few frames ahead: otherwise a slow connection or device queues frames on
 * the way and the picture (and so the controls) falls further and further
 * behind.
 */

const MSG_HELLO = 0x00;
const MSG_FRAME = 0x01;
const MSG_KEYS = 0x01;
const MSG_AUDIO = 0x03;
const MSG_PING = 0x02;
const MSG_DRAWN = 0x03;
const MSG_STATS = 0x04;

// GBA key bits: A B Select Start Right Left Up Down R L.
const KEY_BITS: Partial<Record<Button, number>> = {
  a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9,
};

// Sound is scheduled this far ahead to ride out network jitter; further
// behind than AUDIO_MAX_AHEAD (clock drift, a stall) and it catches up.
const AUDIO_LEAD = 0.08;
const AUDIO_MAX_AHEAD = 0.3;
const RECONNECT_MS = 1500;
const PING_MS = 1000;
const STATS_MS = 10_000;

const MULAW = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exponent = (u >> 4) & 7;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << exponent) - 0x84;
  MULAW[i] = ((u & 0x80) ? -magnitude : magnitude) / 32768;
}

let audio: AudioContext | null = null;

/** Browsers only start sound after a click or key press: call from one (the Plug in button). */
export function unlockLinkAudio(): void {
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume();
}

export class LinkEmulator implements Emulator {
  readonly running = true;
  lastInputAt = 0;
  private socket: WebSocket | null = null;
  private keys = 0;
  private frame: Uint16Array | null = null;
  private image: ImageData | null = null;
  private pixels: Uint32Array | null = null;
  /** Where each frame's XOR delta unpacks to, and the same bytes as pixels. */
  private deltaBytes: Uint8Array | null = null;
  private delta: Uint16Array | null = null;
  private soundAt = 0;
  private readonly gain: GainNode | null;
  private volume = 1;
  private muted = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly statsTimer: ReturnType<typeof setInterval>;
  private readonly pingTimer: ReturnType<typeof setInterval>;
  /** Since the last stats message: what the link server logs about this screen. */
  private stats = newStats();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly url: string,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.gain = audio ? audio.createGain() : null;
    this.gain?.connect(audio!.destination);
    this.connect();
    this.pingTimer = setInterval(() => this.ping(), PING_MS);
    this.statsTimer = setInterval(() => this.sendStats(), STATS_MS);
  }

  async loadRom(): Promise<void> {}
  start(): void {}
  pause(): void {}
  reset(): void {}

  buttonDown(button: Button): void {
    const bit = KEY_BITS[button];
    if (bit === undefined) return;
    this.lastInputAt = performance.now();
    if (audio?.state === "suspended") void audio.resume();
    this.setKeys(this.keys | (1 << bit));
  }

  buttonUp(button: Button): void {
    const bit = KEY_BITS[button];
    if (bit !== undefined) this.setKeys(this.keys & ~(1 << bit));
  }

  getSram(): Uint8Array | null {
    return null;
  }
  loadSram(): void {}
  onSramWrite(): () => void {
    return () => {};
  }
  flushSramWrites(): void {}

  setVolume(volume: number): void {
    this.volume = volume;
    this.applyVolume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolume();
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.pingTimer);
    clearInterval(this.statsTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.gain?.disconnect();
  }

  private applyVolume(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  private setKeys(keys: number): void {
    if (keys === this.keys) return;
    this.keys = keys;
    this.sendKeys();
  }

  private sendKeys(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(new Uint8Array([MSG_KEYS, this.keys & 0xff, this.keys >> 8]));
    }
  }

  private ping(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const message = new DataView(new ArrayBuffer(9));
    message.setUint8(0, MSG_PING);
    message.setFloat64(1, performance.now(), true);
    this.socket.send(message.buffer);
  }

  private sendStats(): void {
    const s = this.stats;
    this.stats = newStats();
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const ms = (n: number) => Math.min(0xffff, Math.round(n));
    const message = new DataView(new ArrayBuffer(14));
    message.setUint8(0, MSG_STATS);
    message.setUint16(1, Math.min(0xffff, s.frames), true);
    message.setUint16(3, Math.min(0xffff, s.drawn), true);
    message.setUint16(5, ms(s.drawn ? s.waitSum / s.drawn : 0), true);
    message.setUint16(7, ms(s.waitMax), true);
    message.setUint16(9, ms(s.pings ? s.pingSum / s.pings : 0), true);
    message.setUint16(11, ms(s.pingMax), true);
    message.setUint8(13, (document.hidden ? 1 : 0) | (matchMedia("(pointer: coarse)").matches ? 2 : 0));
    this.socket.send(message.buffer);
  }

  /** Only on the socket the frame came on: a new one counts from zero. */
  private sendDrawn(socket: WebSocket, seq: number): void {
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
    const message = new DataView(new ArrayBuffer(5));
    message.setUint8(0, MSG_DRAWN);
    message.setUint32(1, seq, true);
    socket.send(message.buffer);
  }

  /** Stays connected while the link lasts; the game screen ends it when the link does. */
  private connect(): void {
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => this.sendKeys();
    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const data = new Uint8Array(event.data);
      if (data[0] === MSG_FRAME) this.stats.frames++;
      // Synchronous, frame by frame: an async decode took several event-loop
      // turns per frame, and on a busy page frames queued up behind each other.
      this.handle(data, socket, performance.now());
    };
    socket.onclose = () => {
      if (this.destroyed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  private handle(data: Uint8Array, socket: WebSocket, arrived: number): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (data[0]) {
      case MSG_HELLO: {
        const width = view.getUint16(2, true);
        const height = view.getUint16(4, true);
        this.canvas.width = width;
        this.canvas.height = height;
        this.frame = new Uint16Array(width * height);
        this.image = this.ctx.createImageData(width, height);
        this.pixels = new Uint32Array(this.image.data.buffer);
        this.deltaBytes = new Uint8Array(width * height * 2);
        this.delta = new Uint16Array(this.deltaBytes.buffer);
        return;
      }
      case MSG_FRAME:
        try {
          this.drawFrame(data.subarray(5));
        } catch (err) {
          console.warn("Bad link frame", err);
        } finally {
          this.sendDrawn(socket, view.getUint32(1, true));
          const wait = performance.now() - arrived;
          this.stats.drawn++;
          this.stats.waitSum += wait;
          this.stats.waitMax = Math.max(this.stats.waitMax, wait);
        }
        return;
      case MSG_PING: {
        const rtt = performance.now() - view.getFloat64(1, true);
        this.stats.pings++;
        this.stats.pingSum += rtt;
        this.stats.pingMax = Math.max(this.stats.pingMax, rtt);
        return;
      }
      case MSG_AUDIO:
        return this.playSound(view.getUint32(1, true), data.subarray(5));
    }
  }

  private drawFrame(packed: Uint8Array): void {
    const { frame, pixels, image, deltaBytes, delta } = this;
    if (!frame || !pixels || !image || !deltaBytes || !delta || this.destroyed) return;
    if (unzlibSync(packed, { out: deltaBytes }).length !== deltaBytes.length) return;
    for (let i = 0; i < frame.length; i++) {
      const v = (frame[i]! ^= delta[i]!);
      pixels[i] = 0xff000000 | (expand5((v >> 10) & 31) << 16) | (expand5((v >> 5) & 31) << 8) | expand5(v & 31);
    }
    this.ctx.putImageData(image, 0, 0);
  }

  private playSound(rate: number, bytes: Uint8Array): void {
    if (!audio || !this.gain || audio.state !== "running" || !bytes.length) return;
    const buffer = audio.createBuffer(1, bytes.length, rate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < bytes.length; i++) samples[i] = MULAW[bytes[i]!]!;
    const now = audio.currentTime;
    if (this.soundAt < now + 0.01 || this.soundAt > now + AUDIO_MAX_AHEAD) this.soundAt = now + AUDIO_LEAD;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start(this.soundAt);
    this.soundAt += buffer.duration;
  }
}

function newStats() {
  return { frames: 0, drawn: 0, waitSum: 0, waitMax: 0, pings: 0, pingSum: 0, pingMax: 0 };
}

function expand5(v: number): number {
  return (v << 3) | (v >> 2);
}
