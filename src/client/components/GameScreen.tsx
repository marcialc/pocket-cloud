import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "../App";
import { BinjgbEmulator } from "../emulator/BinjgbEmulator";
import { bindKeyboard } from "../emulator/controls";
import type { GameBoyEmulator } from "../emulator/GameBoyEmulator";
import { keyLabel, type KeyBindings } from "../emulator/keyBindings";
import { defaultPalette, displayName } from "../emulator/rom";
import type { Preferences } from "../preferences";
import { SaveSync, type SyncStatus } from "../saves/SaveSync";
import { CloudPanel } from "./CloudPanel";
import { ControlsPanel } from "./ControlsPanel";
import { SaveChoice } from "./SaveChoice";
import { SyncBadge } from "./SyncBadge";
import { TouchControls } from "./TouchControls";

type Props = {
  session: Session;
  prefs: Preferences;
  onPrefs: (patch: Partial<Preferences>) => void;
  onEject: () => void;
};

export function GameScreen({ session, prefs, onPrefs, onEject }: Props) {
  const shell = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [emulator, setEmulator] = useState<GameBoyEmulator | null>(null);
  const [sync, setSync] = useState<SaveSync | null>(null);
  const [status, setStatus] = useState<SyncStatus>({ state: "idle" });
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const title = displayName(session.rom);

  // Boot: one emulator + one sync pipeline per session.
  useEffect(() => {
    let disposed = false;
    const emu = new BinjgbEmulator({ canvas: canvas.current!, palette: defaultPalette(session.rom) });
    let saveSync: SaveSync | null = null;

    (async () => {
      await emu.loadRom(session.romData);
      if (disposed) return;
      if (session.save) {
        try {
          emu.loadSram(new Uint8Array(session.save.sram));
        } catch (err) {
          console.warn("Ignoring incompatible save", err);
        }
      }
      saveSync = new SaveSync(emu, session.rom, session.save, prefs.cloudSync);
      saveSync.subscribe(setStatus);
      setStatus(saveSync.getStatus());
      if (session.push) saveSync.requestPush(session.push.force);
      emu.start();
      saveSync.setPlaying(true);
      setEmulator(emu);
      setSync(saveSync);
    })().catch((err: unknown) => {
      if (disposed) return;
      console.error(err);
      setError(err instanceof Error ? err.message : "The emulator failed to start.");
    });

    return () => {
      disposed = true;
      // Capture the latest SRAM before the core goes away, then tear down.
      const s = saveSync;
      if (s) {
        void s.flush().finally(() => {
          s.destroy();
          emu.destroy();
        });
      } else {
        emu.destroy();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once per session
  }, [session]);

  // Keyboard input; re-bound whenever the player remaps keys.
  useEffect(() => (emulator ? bindKeyboard(emulator, prefs.keyBindings) : undefined), [emulator, prefs.keyBindings]);

  // Mirror preferences into the running emulator / sync loop.
  useEffect(() => {
    emulator?.setVolume(prefs.volume);
    emulator?.setMuted(prefs.muted);
  }, [emulator, prefs.volume, prefs.muted]);
  useEffect(() => sync?.setCloudEnabled(prefs.cloudSync), [sync, prefs.cloudSync]);

  const setRunning = useCallback(
    (run: boolean) => {
      if (!emulator) return;
      if (run) emulator.start();
      else emulator.pause();
      sync?.setPlaying(run);
      setPaused(!run);
    },
    [emulator, sync],
  );

  // Pause when the tab is hidden and flush saves; resume on return.
  useEffect(() => {
    if (!emulator || !sync) return;
    let autoPaused = false;
    const onVisibility = () => {
      if (document.hidden) {
        void sync.flush();
        if (emulator.running) {
          autoPaused = true;
          setRunning(false);
        }
      } else if (autoPaused) {
        autoPaused = false;
        setRunning(true);
      }
    };
    const onPageHide = () => void sync.flush();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [emulator, sync, setRunning]);

  const reset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 2500);
      return;
    }
    setConfirmReset(false);
    emulator?.reset();
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.current?.requestFullscreen?.().catch(() => {});
  };

  const downloadSave = () => {
    const sram = emulator?.getSram();
    if (!sram) return;
    const url = URL.createObjectURL(new Blob([sram.slice().buffer], { type: "application/octet-stream" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${session.rom.gameId}.sav` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const resolveConflict = async (choice: "local" | "cloud") => {
    if (!sync || !emulator) return;
    if (choice === "local") return sync.keepLocal();
    const sram = await sync.takeCloud();
    if (sram) {
      emulator.loadSram(sram);
      emulator.reset();
    }
  };

  const localSave = sync?.getLocal() ?? session.save;

  return (
    <div className="game" ref={shell}>
      <header className="game-bar">
        <button className="brand" onClick={onEject} title="Eject cartridge">
          <span className="brand-dot" aria-hidden /> {title}
        </button>
        <SyncBadge status={status} onClick={() => setPanel(true)} />
      </header>

      <div className="screen-area">
        <div className="bezel">
          <div className="bezel-label">
            <span className="power" data-on={!paused && !error} /> POCKET CLOUD · STEREO
          </div>
          <div className="lcd">
            <canvas ref={canvas} width={160} height={144} aria-label={`${title} screen`} />
            {paused && !error && (
              <button className="lcd-overlay" onClick={() => setRunning(true)}>
                <span>PAUSED</span>
                <small>click to resume</small>
              </button>
            )}
            {error && (
              <div className="lcd-overlay error-overlay" role="alert">
                <span>ERROR</span>
                <small>{error}</small>
              </div>
            )}
          </div>
        </div>
      </div>

      <TouchControls emulator={emulator} />

      <footer className="toolbar">
        <button className="tool" onClick={() => setRunning(paused)} disabled={!emulator}>
          {paused ? "▶ Resume" : "❚❚ Pause"}
        </button>
        <button className="tool" onClick={() => void sync?.flush()} disabled={!sync} title="Back up the latest in-game save now">
          ☁ Sync
        </button>
        <button className={`tool${confirmReset ? " warn" : ""}`} onClick={reset} disabled={!emulator}>
          {confirmReset ? "Reset?" : "↺ Reset"}
        </button>
        <button className="tool" onClick={toggleFullscreen}>⛶ Fullscreen</button>
        <button className="tool" onClick={() => setControlsOpen(true)}>⌨ Controls</button>
        <div className="volume">
          <button className="tool" onClick={() => onPrefs({ muted: !prefs.muted })} aria-label={prefs.muted ? "Unmute" : "Mute"}>
            {prefs.muted || prefs.volume === 0 ? "🔇" : "🔊"}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={prefs.muted ? 0 : prefs.volume}
            onChange={(e) => onPrefs({ volume: Number(e.target.value), muted: false })}
            aria-label="Volume"
          />
        </div>
      </footer>

      <KeysHint bindings={prefs.keyBindings} onEdit={() => setControlsOpen(true)} />

      {controlsOpen && (
        <ControlsPanel
          bindings={prefs.keyBindings}
          onChange={(keyBindings) => onPrefs({ keyBindings })}
          onClose={() => setControlsOpen(false)}
        />
      )}

      {panel && (
        <CloudPanel
          cloudSync={prefs.cloudSync}
          onCloudSync={(cloudSync) => onPrefs({ cloudSync })}
          onDownloadSave={emulator ? downloadSave : null}
          onBeforeRestore={async () => {
            await sync?.flush();
            sync?.destroy();
          }}
          onClose={() => setPanel(false)}
        />
      )}

      {status.state === "conflict" && (
        <SaveChoice
          inGame
          title={title}
          local={{ updatedAt: localSave?.updatedAt ?? Date.now(), playTime: localSave?.playTime ?? 0 }}
          cloud={status.cloud}
          recommended={status.cloud.updatedAt > (localSave?.updatedAt ?? 0) ? "cloud" : "local"}
          onChoose={(c) => void resolveConflict(c)}
        />
      )}
    </div>
  );
}

function KeysHint({ bindings, onEdit }: { bindings: KeyBindings; onEdit: () => void }) {
  const first = (codes: string[]) => (codes[0] ? keyLabel(codes[0]) : "—");
  const dpad = ["up", "down", "left", "right"] as const;
  const arrows = dpad.every((d) => bindings[d][0] === `Arrow${d[0]!.toUpperCase()}${d.slice(1)}`);
  return (
    <p className="keys-hint">
      {arrows ? "Arrows move" : dpad.map((d) => <kbd key={d}>{first(bindings[d])}</kbd>)} · <kbd>{first(bindings.a)}</kbd> A ·{" "}
      <kbd>{first(bindings.b)}</kbd> B · <kbd>{first(bindings.start)}</kbd> Start · <kbd>{first(bindings.select)}</kbd> Select
      <button className="link" onClick={onEdit}>Change</button>
    </p>
  );
}
