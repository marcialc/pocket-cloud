import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NostalgistEmulator } from "./NostalgistEmulator";

const SRAM_PATH = "/home/web_user/retroarch/userdata/saves/mGBA/game.srm";

/** Whether RetroArch's AudioContext starts running (desktop) or suspended (no user gesture yet). */
let audioStartsSuspended = false;

class FakeAudioContext {
  state: AudioContextState = audioStartsSuspended ? "suspended" : "running";
  suspend = vi.fn(async () => void (this.state = "suspended"));
  resume = vi.fn(async () => void (this.state = "running"));
  close = vi.fn(async () => void (this.state = "closed"));
}

/**
 * Stands in for a Nostalgist instance: a file system, and a "game" whose battery
 * RAM lands in the .srm when RetroArch is asked to flush it, like _cmd_savefiles.
 */
class FakeNostalgist {
  status: "initial" | "running" | "paused" | "terminated" = "initial";
  readonly files = new Map<string, Uint8Array>();
  /** What the running game holds in battery RAM; null: a game without a save. */
  gameSram: Uint8Array | null = null;
  readonly module = {
    FS: {
      mkdirTree: vi.fn(),
      writeFile: (path: string, data: Uint8Array) => void this.files.set(path, data.slice()),
      readFile: (path: string) => {
        const data = this.files.get(path);
        if (!data) throw new Error("ENOENT");
        return data;
      },
    },
    _cmd_savefiles: vi.fn(() => {
      if (this.gameSram) this.files.set(SRAM_PATH, this.gameSram.slice());
    }),
    _cmd_set_volume: vi.fn(),
  };
  /** The SRAM file RetroArch found when the game loaded. */
  bootSram: Uint8Array | null = null;
  audio: FakeAudioContext | null = null;
  /** Rejects start() (a core that fails to run). */
  failStart = false;
  start = vi.fn(async () => {
    if (this.failStart) throw new Error("callMain failed");
    // RetroArch makes its AudioContext while it starts.
    this.audio = new (window as unknown as { AudioContext: new () => FakeAudioContext }).AudioContext();
    this.bootSram = this.files.get(SRAM_PATH) ?? null;
    this.gameSram = this.bootSram;
    this.status = "running";
  });
  pause = vi.fn(() => void (this.status = "paused"));
  resume = vi.fn(() => void (this.status = "running"));
  exit = vi.fn(() => void (this.status = "terminated"));
  pressDown = vi.fn();
  pressUp = vi.fn();
  sendCommand = vi.fn();
  /** The snapshot the running game last loaded. */
  loadedState: Uint8Array | null = null;
  /** saveState() never answers (a core that doesn't get to it, like one in a hidden tab). */
  stallSaveState = false;
  saveState = vi.fn(() =>
    this.stallSaveState
      ? new Promise<never>(() => {})
      : Promise.resolve({ state: new Blob([new Uint8Array([7, 7, 7])]) }),
  );
  loadState = vi.fn(async (state: Blob) => void (this.loadedState = new Uint8Array(await state.arrayBuffer())));
  constructor(readonly options: Record<string, unknown>) {}
  getStatus = () => this.status;
  getEmscriptenModule = () => this.module;
}

const nostalgists: FakeNostalgist[] = [];
/** While set, prepare() (the core download) waits for it. */
let prepareGate: Promise<void> | null = null;
/** Applied to each prepared instance, e.g. to make its start fail. */
let onPrepare: ((instance: FakeNostalgist) => void) | null = null;
vi.mock("nostalgist", () => ({
  Nostalgist: {
    prepare: vi.fn(async (options: Record<string, unknown>) => {
      await prepareGate;
      const instance = new FakeNostalgist(options);
      onPrepare?.(instance);
      nostalgists.push(instance);
      return instance;
    }),
  },
}));

function fakeCanvas() {
  return { addEventListener: vi.fn(), removeEventListener: vi.fn(), blur: vi.fn() } as unknown as HTMLCanvasElement;
}

let canvas: HTMLCanvasElement;

beforeEach(() => {
  vi.useFakeTimers();
  nostalgists.length = 0;
  prepareGate = null;
  onPrepare = null;
  audioStartsSuspended = false;
  const win = new EventTarget() as EventTarget & { AudioContext: typeof FakeAudioContext };
  win.AudioContext = FakeAudioContext;
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("location", { href: "http://localhost/" });
  canvas = fakeCanvas();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loaded(sram?: Uint8Array) {
  const emu = new NostalgistEmulator({ canvas, platform: "gba" });
  await emu.loadRom(new ArrayBuffer(0x100));
  if (sram) emu.loadSram(sram);
  return { emu, core: nostalgists.at(-1)! };
}

async function started(sram?: Uint8Array) {
  const setup = await loaded(sram);
  setup.emu.start();
  await vi.advanceTimersByTimeAsync(0);
  return setup;
}

function bytes(...values: number[]) {
  return new Uint8Array(values);
}

function gate() {
  let open!: () => void;
  prepareGate = new Promise((resolve) => (open = resolve));
  return () => {
    prepareGate = null;
    open();
  };
}

describe("NostalgistEmulator", () => {
  it("prepares mGBA with a fixed ROM name, self-hosted cores and a bind for each GBA button", async () => {
    const { core } = await loaded();
    const options = core.options as {
      core: string;
      rom: { fileName: string };
      respondToGlobalEvents: boolean;
      element: HTMLCanvasElement;
      resolveCoreWasm: (core: string) => URL;
      retroarchConfig: Record<string, unknown>;
    };
    expect(options).toMatchObject({ core: "mgba", rom: { fileName: "game.gba" }, respondToGlobalEvents: false, element: canvas });
    expect(options.resolveCoreWasm("mgba").href).toBe("http://localhost/vendor/retroarch/mgba_libretro.wasm");
    const binds = Object.keys(options.retroarchConfig).filter((key) => key.startsWith("input_player1_"));
    expect(binds.sort()).toEqual(
      ["a", "b", "down", "l", "left", "r", "right", "select", "start", "up"].map((b) => `input_player1_${b}`),
    );
    // Nothing runs until start().
    expect(core.start).not.toHaveBeenCalled();
  });

  it("puts a loaded save where RetroArch reads it at boot", async () => {
    const { emu, core } = await started(bytes(1, 2, 3));
    expect(core.bootSram).toEqual(bytes(1, 2, 3));
    expect(emu.getSram()).toEqual(bytes(1, 2, 3));
  });

  it("reports game writes at most once a second, and only real changes", async () => {
    const { emu, core } = await started(bytes(1, 2, 3));
    const listener = vi.fn();
    emu.onSramWrite(listener);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).not.toHaveBeenCalled();

    core.gameSram = bytes(4, 5, 6);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(emu.getSram()).toEqual(bytes(4, 5, 6));
    await vi.advanceTimersByTimeAsync(3000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("delivers a pending write at once on flushSramWrites()", async () => {
    const { emu, core } = await started();
    const listener = vi.fn();
    emu.onSramWrite(listener);
    core.gameSram = bytes(9);
    emu.flushSramWrites();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("doesn't take a blank save area for a save, nor a game without one", async () => {
    const { emu, core } = await started();
    const listener = vi.fn();
    emu.onSramWrite(listener);
    expect(emu.getSram()).toBeNull();
    // mGBA before it knows the save type: 128 KiB of 0xFF.
    core.gameSram = new Uint8Array(0x20000).fill(0xff);
    emu.flushSramWrites();
    expect(listener).not.toHaveBeenCalled();
    expect(emu.getSram()).toBeNull();

    core.gameSram = new Uint8Array(0x8000).fill(0xff);
    core.gameSram[0] = 1;
    emu.flushSramWrites();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(emu.getSram()).toHaveLength(0x8000);
  });

  it("maps buttons to the RetroPad and ignores ones the GBA doesn't have", async () => {
    const { emu, core } = await loaded();
    emu.buttonDown("start"); // held before the game runs: pressed once it does
    emu.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(core.pressDown).toHaveBeenCalledWith("start");
    await vi.advanceTimersByTimeAsync(5);
    emu.buttonDown("l");
    emu.buttonUp("l");
    emu.buttonDown("x");
    expect(core.pressDown.mock.calls.map(([b]) => b)).toEqual(["start", "l"]);
    expect(core.pressUp).toHaveBeenCalledWith("l");
    expect(emu.lastInputAt).toBe(performance.now());
  });

  it("pauses the core and its audio, and resumes both", async () => {
    const { emu, core } = await started();
    emu.pause();
    expect(emu.running).toBe(false);
    expect(core.pause).toHaveBeenCalled();
    expect(core.audio!.state).toBe("suspended");
    emu.start();
    expect(core.resume).toHaveBeenCalled();
    expect(core.audio!.state).toBe("running");
  });

  it("resets through RetroArch, or relaunches to boot a save loaded while playing", async () => {
    const { emu, core } = await started(bytes(1));
    emu.reset();
    expect(core.sendCommand).toHaveBeenCalledWith("RESET");

    emu.loadSram(bytes(7, 7));
    expect(emu.getSram()).toEqual(bytes(7, 7));
    emu.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(core.exit).toHaveBeenCalledWith({ removeCanvas: false });
    expect(core.audio!.close).toHaveBeenCalled();
    const next = nostalgists.at(-1)!;
    expect(next).not.toBe(core);
    expect(next.bootSram).toEqual(bytes(7, 7));
    expect(emu.getSram()).toEqual(bytes(7, 7));
  });

  it("sets the volume in dB", async () => {
    const { emu, core } = await started();
    emu.setVolume(0.5);
    expect(core.module._cmd_set_volume).toHaveBeenLastCalledWith(expect.closeTo(-6.02, 2));
    emu.setMuted(true);
    expect(core.module._cmd_set_volume).toHaveBeenLastCalledWith(-80);
  });

  it("puts the browser's AudioContext back after each start, even when starts overlap", async () => {
    const Native = (window as unknown as { AudioContext: unknown }).AudioContext;
    const first = await loaded();
    const second = await loaded();
    first.emu.start();
    second.emu.start();
    await vi.advanceTimersByTimeAsync(0);
    expect((window as unknown as { AudioContext: unknown }).AudioContext).toBe(Native);
    // Each core's context is its own to close.
    first.emu.destroy();
    expect(first.core.audio!.state).toBe("closed");
    expect(second.core.audio!.state).toBe("running");
    second.emu.destroy();
  });

  it("unlocks audio on the next gesture when it starts suspended, then stops listening", async () => {
    audioStartsSuspended = true;
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const { core } = await started();
    expect(added.mock.calls.map(([type]) => type).sort()).toEqual(["keydown", "pointerdown", "touchend"]);
    // Our fake resumes whenever asked; a real browser only inside a gesture.
    window.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(0);
    expect(core.audio!.state).toBe("running");
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(["keydown", "pointerdown", "touchend"]);
  });

  it("keeps a smaller loaded save at its size when mGBA pads it to the whole chip", async () => {
    const save = new Uint8Array(0x2000).fill(0xff);
    save[0] = 1;
    const { emu, core } = await started(save);
    const listener = vi.fn();
    emu.onSramWrite(listener);
    core.gameSram = new Uint8Array(0x8000).fill(0xff);
    core.gameSram.set(save);
    emu.flushSramWrites();
    expect(listener).not.toHaveBeenCalled();
    expect(emu.getSram()).toEqual(save);
    // A real write past the loaded size is a change, and kept whole.
    core.gameSram[0x7000] = 2;
    emu.flushSramWrites();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(emu.getSram()).toHaveLength(0x8000);
  });

  it("boots the newest save loaded while a relaunch downloads the core", async () => {
    const { emu } = await started(bytes(1));
    const open = gate();
    emu.loadSram(bytes(2));
    emu.reset();
    emu.loadSram(bytes(3));
    emu.reset(); // queued behind the relaunch; nothing new left to load
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(nostalgists).toHaveLength(2);
    expect(nostalgists[1]!.bootSram).toEqual(bytes(3));
    expect(emu.getSram()).toEqual(bytes(3));
  });

  it("relaunches again for a save loaded after the relaunch took its save", async () => {
    const { emu } = await started(bytes(1));
    emu.loadSram(bytes(2));
    emu.reset();
    await vi.advanceTimersByTimeAsync(0);
    emu.loadSram(bytes(3));
    emu.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(nostalgists.map((n) => n.bootSram)).toEqual([bytes(1), bytes(2), bytes(3)]);
    expect(nostalgists.slice(0, 2).every((n) => n.status === "terminated")).toBe(true);
    expect(emu.getSram()).toEqual(bytes(3));
  });

  it("doesn't leave a core running when destroyed during a relaunch", async () => {
    const { emu, core } = await started(bytes(1));
    const open = gate();
    emu.loadSram(bytes(2));
    emu.reset();
    emu.destroy();
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(core.status).toBe("terminated");
    expect(nostalgists[1]!.status).toBe("terminated");
    expect(nostalgists[1]!.start).not.toHaveBeenCalled();
  });

  it("stops a core that finished starting after destroy()", async () => {
    const { emu, core } = await loaded();
    emu.start();
    emu.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(core.status).toBe("terminated");
    expect(core.audio!.state).toBe("closed");
  });

  it("reports a core that fails to start, and stops", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { emu, core } = await loaded();
    core.failStart = true;
    const onError = vi.fn();
    emu.onError(onError);
    emu.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "The emulator failed to start." }));
    expect(emu.running).toBe(false);
    expect(core.exit).toHaveBeenCalled();
    // Resume and reset stay harmless.
    emu.start();
    emu.reset();
    expect(emu.running).toBe(false);
  });

  it("reports a relaunch that fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { emu } = await started(bytes(1));
    onPrepare = (instance) => (instance.failStart = true);
    const onError = vi.fn();
    emu.onError(onError);
    emu.loadSram(bytes(2));
    emu.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(emu.running).toBe(false);
  });

  it("tears everything down on destroy()", async () => {
    const { emu, core } = await started(bytes(1));
    const listener = vi.fn();
    emu.onSramWrite(listener);
    emu.destroy();
    expect(core.exit).toHaveBeenCalledWith({ removeCanvas: false });
    expect(core.audio!.close).toHaveBeenCalled();
    expect(canvas.removeEventListener).toHaveBeenCalledWith("focus", expect.any(Function));
    core.gameSram = bytes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(core.module._cmd_savefiles).not.toHaveBeenCalledAfter(core.exit);
    expect(listener).not.toHaveBeenCalled();
  });

  it("doesn't start a core that finished loading after destroy()", async () => {
    const emu = new NostalgistEmulator({ canvas, platform: "gba" });
    const loading = emu.loadRom(new ArrayBuffer(0x100));
    emu.destroy();
    await expect(loading).rejects.toThrow(/destroyed/);
    expect(nostalgists[0]!.exit).toHaveBeenCalled();
  });

  describe("snapshots", () => {
    it("carries on from a snapshot loaded before start, once the game runs", async () => {
      const { emu, core } = await loaded();
      emu.loadState(bytes(1, 2, 3));
      expect(core.loadState).not.toHaveBeenCalled();
      emu.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(core.loadedState).toEqual(bytes(1, 2, 3));
    });

    it("only takes a snapshot before start", async () => {
      const { emu } = await started();
      expect(() => emu.loadState(bytes(1))).toThrow();
    });

    it("boots normally when the snapshot doesn't load", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { emu, core } = await loaded();
      core.loadState.mockRejectedValueOnce(new Error("fs timeout"));
      emu.loadState(bytes(1));
      emu.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(emu.running).toBe(true);
      expect(warn).toHaveBeenCalled();
    });

    it("doesn't load the snapshot again when a reset relaunches the game", async () => {
      const { emu } = await loaded();
      emu.loadState(bytes(1));
      emu.start();
      await vi.advanceTimersByTimeAsync(0);
      emu.loadSram(bytes(5, 6));
      emu.reset();
      await vi.advanceTimersByTimeAsync(0);
      expect(nostalgists.at(-1)!.loadState).not.toHaveBeenCalled();
    });

    it("snapshots the running game, and has nothing to snapshot before it runs", async () => {
      const { emu } = await loaded();
      expect(await emu.saveState()).toBeNull();
      emu.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(await emu.saveState()).toEqual(bytes(7, 7, 7));
    });

    it("doesn't ask for a snapshot while RetroArch's frame loop is stopped", async () => {
      const { emu, core } = await started();
      emu.pause();
      expect(await emu.saveState()).toBeNull();
      emu.start();
      (document as unknown as { hidden: boolean }).hidden = true;
      expect(await emu.saveState()).toBeNull();
      expect(core.saveState).not.toHaveBeenCalled();
    });

    it("gives up on a snapshot RetroArch never writes", async () => {
      const { emu, core } = await started();
      core.stallSaveState = true;
      const taking = emu.saveState();
      const result = expect(taking).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5000);
      await result;
    });
  });
});
