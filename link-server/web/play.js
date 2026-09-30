// Test client for linkd's WebSocket stream (protocol in src/linkd.c).
"use strict";

const MSG_HELLO = 0x00;
const MSG_FRAME = 0x01;
const MSG_KEYS = 0x01;
const MSG_PING = 0x02;
const MSG_AUDIO = 0x03;

// Sound is scheduled this far ahead to ride out network jitter; if it gets
// further behind than AUDIO_MAX_AHEAD (clock drift, a stall), catch up.
const AUDIO_LEAD = 0.08;
const AUDIO_MAX_AHEAD = 0.3;

// GBA key bits: A B Select Start Right Left Up Down R L.
const KEY_BITS = {
  KeyZ: 0, KeyX: 1, Backspace: 2, Enter: 3,
  ArrowRight: 4, ArrowLeft: 5, ArrowUp: 6, ArrowDown: 7,
  KeyS: 8, KeyA: 9,
};

const params = new URLSearchParams(location.search);
const wanted = (params.get("players") || "1,2").split(",").map(Number).filter((n) => n === 1 || n === 2);
const screensEl = document.getElementById("screens");
const screens = [];
let active = null;
let audio = null;

const MULAW = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exponent = (u >> 4) & 7;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << exponent) - 0x84;
  MULAW[i] = ((u & 0x80) ? -magnitude : magnitude) / 32768;
}

// Browsers only start sound after a click or key press.
function startAudio() {
  if (!audio) audio = new AudioContext();
  if (audio.state === "suspended") audio.resume();
}

function playSound(screen, rate, bytes) {
  if (!audio || audio.state !== "running" || screen !== active || !bytes.length) return;
  const buffer = audio.createBuffer(1, bytes.length, rate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < bytes.length; i++) samples[i] = MULAW[bytes[i]];
  const now = audio.currentTime;
  if (screen.soundAt < now + 0.01 || screen.soundAt > now + AUDIO_MAX_AHEAD) {
    screen.soundAt = now + AUDIO_LEAD;
  }
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  source.start(screen.soundAt);
  screen.soundAt += buffer.duration;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function expand5(v) {
  return (v << 3) | (v >> 2);
}

function createScreen(player) {
  const el = document.createElement("div");
  el.className = "screen";
  el.innerHTML = `<h2>Player ${player}</h2><canvas width="240" height="160"></canvas><div class="stats">connecting…</div>`;
  screensEl.append(el);
  const canvas = el.querySelector("canvas");
  const stats = el.querySelector(".stats");
  const ctx = canvas.getContext("2d");
  const screen = { player, el, canvas, ctx, stats, socket: null, keys: 0, frame: null, image: null,
                   pixels: null, queue: Promise.resolve(), frames: 0, bytes: 0, rtt: null,
                   soundAt: 0 };
  el.addEventListener("click", () => {
    startAudio();
    setActive(screen);
  });
  connect(screen);
  return screen;
}

function setActive(screen) {
  if (active && active !== screen) {
    active.keys = 0;
    sendKeys(active);
    active.el.classList.remove("active");
  }
  active = screen;
  screen.el.classList.add("active");
}

function connect(screen) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws?player=${screen.player}`);
  socket.binaryType = "arraybuffer";
  screen.socket = socket;
  socket.onmessage = (event) => {
    const data = new Uint8Array(event.data);
    // Frames decode asynchronously; chain them so they apply in order.
    screen.queue = screen.queue.then(() => handle(screen, data)).catch((error) => console.error(error));
  };
  socket.onclose = () => {
    screen.stats.textContent = "disconnected, retrying…";
    setTimeout(() => connect(screen), 1000);
  };
}

async function handle(screen, data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (data[0]) {
    case MSG_HELLO: {
      const width = view.getUint16(2, true);
      const height = view.getUint16(4, true);
      screen.canvas.width = width;
      screen.canvas.height = height;
      screen.frame = new Uint16Array(width * height);
      screen.image = screen.ctx.createImageData(width, height);
      screen.pixels = new Uint32Array(screen.image.data.buffer);
      break;
    }
    case MSG_FRAME: {
      if (!screen.frame) return;
      const delta = new Uint16Array((await inflate(data.subarray(5))).buffer);
      const { frame, pixels } = screen;
      for (let i = 0; i < frame.length; i++) {
        const v = (frame[i] ^= delta[i]);
        pixels[i] = 0xff000000 | (expand5((v >> 10) & 31) << 16) | (expand5((v >> 5) & 31) << 8) | expand5(v & 31);
      }
      screen.ctx.putImageData(screen.image, 0, 0);
      screen.frames++;
      screen.bytes += data.byteLength;
      break;
    }
    case MSG_AUDIO: {
      playSound(screen, view.getUint32(1, true), data.subarray(5));
      screen.bytes += data.byteLength;
      break;
    }
    case MSG_PING: {
      screen.rtt = performance.now() - view.getFloat64(1, true);
      break;
    }
  }
}

function sendKeys(screen) {
  if (screen.socket && screen.socket.readyState === WebSocket.OPEN) {
    screen.socket.send(new Uint8Array([MSG_KEYS, screen.keys & 0xff, screen.keys >> 8]));
  }
}

function setButton(bit, down) {
  if (!active) return;
  if (down) startAudio();
  const keys = down ? active.keys | (1 << bit) : active.keys & ~(1 << bit);
  if (keys !== active.keys) {
    active.keys = keys;
    sendKeys(active);
  }
}

function onKey(event, down) {
  const bit = KEY_BITS[event.code];
  if (bit === undefined) return;
  event.preventDefault();
  setButton(bit, down);
}

// On-screen buttons (touch screens). Each finger holds its own button.
const held = new Map();
for (const button of document.querySelectorAll("[data-bit]")) {
  const bit = Number(button.dataset.bit);
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    held.set(event.pointerId, bit);
    button.classList.add("down");
    setButton(bit, true);
  });
  const release = (event) => {
    if (held.get(event.pointerId) !== bit) return;
    held.delete(event.pointerId);
    button.classList.remove("down");
    if (![...held.values()].includes(bit)) setButton(bit, false);
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
}

addEventListener("keydown", (event) => onKey(event, true));
addEventListener("keyup", (event) => onKey(event, false));
addEventListener("blur", () => {
  if (active) {
    active.keys = 0;
    sendKeys(active);
  }
});

setInterval(() => {
  for (const screen of screens) {
    if (screen.socket.readyState !== WebSocket.OPEN) continue;
    const ping = new DataView(new ArrayBuffer(9));
    ping.setUint8(0, MSG_PING);
    ping.setFloat64(1, performance.now(), true);
    screen.socket.send(ping.buffer);
    const rtt = screen.rtt === null ? "–" : `${screen.rtt.toFixed(0)} ms`;
    screen.stats.textContent = `${screen.frames} fps · ${(screen.bytes * 8 / 1000).toFixed(0)} kbit/s · ping ${rtt}`;
    screen.frames = 0;
    screen.bytes = 0;
  }
}, 1000);

for (const player of wanted) screens.push(createScreen(player));
if (screens.length) setActive(screens[0]);
