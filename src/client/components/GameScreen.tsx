import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Session } from "../App";
import { PLATFORMS, buttonLabel, type PlatformId } from "../../shared/platforms";
import { bindKeyboard } from "../emulator/controls";
import { createEmulator } from "../emulator/createEmulator";
import type { Emulator } from "../emulator/Emulator";
import { scoreWatcherFor } from "../emulator/scoreWatch";
import { keyLabel, type KeyBindings } from "../emulator/keyBindings";
import { displayName } from "../emulator/rom";
import { resetCloudRomsChoice, type Preferences } from "../preferences";
import { signOut } from "../saves/authApi";
import { fetchCloudSave } from "../saves/cloudApi";
import { resetPlayerKey } from "../saves/identity";
import { reportScore } from "../saves/socialApi";
import { clearCloudSyncState } from "../saves/localSaves";
import { SaveSync, type SyncStatus } from "../saves/SaveSync";
import { CloudPanel } from "./CloudPanel";
import { ControlsPanel } from "./ControlsPanel";
import { FriendsPanel } from "./FriendsPanel";
import { backupName, downloadBytes } from "./download";
import { Brand, Icon, Ridges, type IconName } from "./icons";
import { SaveChoice } from "./SaveChoice";
import { describeStatus, SyncBadge } from "./SyncBadge";
import { TouchControls } from "./TouchControls";

type Props = {
  session: Session;
  prefs: Preferences;
  onPrefs: (patch: Partial<Preferences>) => void;
  /** Signed in with an email account (controls are saved to it). */
  signedIn: boolean;
  onEject: () => void;
};

const DIM_AFTER_MS = 2500;
// iPhone Safari can't make a page element fullscreen, so the button is hidden there.
const CAN_FULLSCREEN = document.fullscreenEnabled === true;

export function GameScreen({ session, prefs, onPrefs, signedIn, onEject }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [emulator, setEmulator] = useState<Emulator | null>(null);
  const [sync, setSync] = useState<SaveSync | null>(null);
  const [status, setStatus] = useState<SyncStatus>({ state: "idle" });
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"account" | "controls" | "friends" | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [scale, setScale] = useState(3);
  const [dim, setDim] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const title = displayName(session.rom);
  const platform = PLATFORMS[session.rom.platform];
  const { width: LCD_W, height: LCD_H } = platform.screen;
  const bindings = prefs.controls[platform.controls];

  // Boot: one emulator + one sync pipeline per session.
  useEffect(() => {
    let disposed = false;
    const emu = createEmulator(session.rom, canvas.current!);
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
      // A save without a clock base (new game, or made before the clock was emulated) starts its clock now.
      const rtcBase = session.save?.rtcBase ?? Date.now();
      emu.setClock?.(rtcBase);
      saveSync = new SaveSync(emu, session.rom, session.save, prefs.cloudSync, rtcBase);
      saveSync.subscribe(setStatus);
      setStatus(saveSync.getStatus());
      if (session.push) saveSync.requestPush(session.push.force);
      emu.onError?.((err) => !disposed && setError(err.message));
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
      // Stop the game at once (it keeps running until destroy(), which waits for the upload below).
      // Pausing delivers the last SRAM write first, so the flush still captures it.
      emu.pause();
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

  // Games with a score in RAM (Tetris): follow it while playing and send the best to the leaderboard.
  useEffect(() => {
    const watcher = signedIn && emulator ? scoreWatcherFor(session.rom.gameId) : null;
    if (!emulator || !watcher) return;
    const { romHash, gameId } = session.rom;
    let reported = 0;
    const report = (keepalive = false) => {
      const best = watcher.best();
      if (best <= reported) return;
      reported = best;
      reportScore(romHash, watcher.board, best, gameId, keepalive).catch((err) => {
        reported = 0;
        console.warn("Could not send the score to the leaderboard", err);
      });
    };
    const sample = setInterval(() => emulator.running && watcher.sample(emulator), 500);
    const send = setInterval(report, 30_000);
    const onHide = () => document.hidden && report(true);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(sample);
      clearInterval(send);
      document.removeEventListener("visibilitychange", onHide);
      report(true);
    };
  }, [emulator, signedIn, session.rom]);

  // Keyboard input; re-bound whenever the player remaps keys.
  useEffect(() => (emulator ? bindKeyboard(emulator, bindings) : undefined), [emulator, bindings]);

  // Mirror preferences into the running emulator / sync loop.
  useEffect(() => {
    emulator?.setVolume(prefs.volume);
    emulator?.setMuted(prefs.muted);
  }, [emulator, prefs.volume, prefs.muted]);
  useEffect(() => sync?.setCloudEnabled(prefs.cloudSync), [sync, prefs.cloudSync]);

  // Fill the space (times the "Screen size" setting), rounded down to whole device pixels
  // so the LCD's edges stay sharp, e.g. 2.5x on a 2x screen.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => {
      const css = getComputedStyle(el);
      const chromeX = parseFloat(css.getPropertyValue("--chrome-x")) || 0;
      const chromeY = parseFloat(css.getPropertyValue("--chrome-y")) || 0;
      const w = el.clientWidth - chromeX;
      const h = el.clientHeight - chromeY;
      const step = window.devicePixelRatio || 1;
      setScale(Math.max(1, Math.floor(Math.min(w / LCD_W, h / LCD_H) * prefs.screenSize * step) / step));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the LCD size is fixed per session
  }, [prefs.screenSize]);

  // Screen readers hear sync changes (state changes only, not every timestamp).
  const statusKind = describeStatus(status).label;
  useEffect(() => {
    const d = describeStatus(status);
    setAnnounce(`Save ${d.label.toLowerCase()}. ${d.detail}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- announce on label change only
  }, [statusKind]);

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

  // Toolbar dims while you play and comes back on mouse move or tap.
  const dimTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wake = useCallback(() => {
    setDim(false);
    clearTimeout(dimTimer.current);
    dimTimer.current = setTimeout(() => setDim(true), DIM_AFTER_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(dimTimer.current);
  }, [wake]);

  const togglePause = () => {
    setRunning(paused);
    setAnnounce(paused ? "Resumed" : "Paused");
  };

  const openReset = () => {
    setConfirmReset(true);
    setTimeout(() => document.getElementById("reset-cancel")?.focus(), 0);
  };

  const doReset = () => {
    setConfirmReset(false);
    setMenu(false);
    emulator?.reset();
    if (paused) setRunning(true);
    setFlash("RESET");
    setAnnounce("Game reset");
    setTimeout(() => setFlash(null), 700);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.().catch(() => {});
  };

  const downloadSave = () => {
    const sram = emulator?.getSram();
    if (sram) downloadBytes(sram, `${session.rom.gameId}.sav`);
  };

  const resolveConflict = async (choice: "local" | "cloud", backup: boolean) => {
    if (!sync || !emulator) return;
    if (choice === "local") {
      if (backup) {
        const cloud = await fetchCloudSave(session.rom.romHash).catch(() => null);
        if (cloud) downloadBytes(cloud.sram, backupName(session.rom.gameId, "cloud"));
      }
      return sync.keepLocal();
    }
    if (backup) {
      const sram = emulator.getSram();
      if (sram) downloadBytes(sram, backupName(session.rom.gameId, "device"));
    }
    const sram = await sync.takeCloud();
    if (sram) {
      emulator.loadSram(sram);
      emulator.setClock?.(sync.getRtcBase());
      emulator.reset();
    }
  };

  /** Identity changed in-game (signed in or out): save, drop sync state and re-run the launch flow. */
  const switchIdentity = async (change: () => Promise<void> | void) => {
    await sync?.flush();
    sync?.destroy();
    await change();
    await clearCloudSyncState();
    resetCloudRomsChoice();
    window.location.reload();
  };

  const localSave = sync?.getLocal() ?? session.save;
  const muted = prefs.muted || prefs.volume === 0;
  const overlayOpen = panel !== null || menu || confirmReset;

  const tools: { icon: IconName; label: string; onClick: () => void; pressed?: boolean; disabled?: boolean }[] = [
    { icon: paused ? "play" : "pause", label: paused ? "Resume" : "Pause", onClick: togglePause, disabled: !emulator },
    { icon: "sync", label: "Sync now", onClick: () => void sync?.flush(), disabled: !sync || !prefs.cloudSync },
    { icon: "reset", label: "Reset", onClick: openReset, disabled: !emulator },
  ];

  return (
    <div
      className={`game${dim && !paused && !overlayOpen ? " idle" : ""}`}
      ref={root}
      onMouseMove={wake}
      onPointerDown={wake}
      style={{ "--scale": scale, "--lcd-w": LCD_W, "--lcd-h": LCD_H } as CSSProperties}
    >
      <header className="game-bar">
        <Brand />
        <span className="game-bar-title px">{title}</span>
        <div className="game-bar-end">
          <SyncBadge status={status} onClick={() => setPanel("account")} />
          <button type="button" className="ibtn menu-btn" onClick={() => setMenu(true)} aria-label="Menu" aria-haspopup="dialog">
            <Icon name="menu" size={20} />
          </button>
          <button type="button" className="link on-dark eject" onClick={onEject}>
            Change game
          </button>
        </div>
      </header>

      <div className="stage" ref={stage}>
        <section className="shell plastic" aria-label="Handheld">
          <div className="shell-top" aria-hidden>
            <Ridges />
            <Ridges />
          </div>
          <div className="bezel">
            <span className="power" data-on={!paused && !error} aria-hidden>
              <span className="led" />
              <span className="px">PWR</span>
            </span>
            <div className="lcd">
              <canvas ref={canvas} width={LCD_W} height={LCD_H} role="img" aria-label={`${title} screen`} />
              {paused && !error && !flash && (
                <button type="button" className="lcd-overlay" onClick={togglePause}>
                  <span className="px">PAUSED</span>
                  <small className="px">PRESS TO RESUME</small>
                </button>
              )}
              {flash && (
                <div className="lcd-overlay" aria-hidden>
                  <span className="px">{flash}</span>
                </div>
              )}
              {error && (
                <div className="lcd-overlay error-overlay" role="alert">
                  <span className="px">ERROR</span>
                  <small>{error}</small>
                </div>
              )}
            </div>
          </div>
          <div className="shell-foot">
            <span className="px shell-title">{title}</span>
            <span className="speaker" aria-hidden>
              <span />
              <span />
              <span />
              <span />
              <span />
            </span>
          </div>
        </section>
      </div>

      <TouchControls emulator={emulator} platform={session.rom.platform} haptics={prefs.haptics} />

      <div className="toolbar-wrap">
        <div className="toolbar plastic" role="toolbar" aria-label="Game controls">
          {tools.map((t) => (
            <button
              key={t.label}
              type="button"
              className={`ibtn tip${t.label === "Reset" && confirmReset ? " on" : ""}`}
              data-tip={t.label}
              aria-label={t.label}
              onClick={t.onClick}
              disabled={t.disabled}
            >
              <Icon name={t.icon} />
            </button>
          ))}
          <span className="sep" aria-hidden />
          <button
            type="button"
            className="ibtn tip"
            data-tip={muted ? "Unmute" : "Mute"}
            aria-label="Mute"
            aria-pressed={prefs.muted}
            onClick={() => onPrefs({ muted: !prefs.muted })}
          >
            <Icon name={muted ? "soundOff" : "soundOn"} />
          </button>
          <VolumeSlider prefs={prefs} onPrefs={onPrefs} />
          <span className="sep" aria-hidden />
          {CAN_FULLSCREEN && (
            <button type="button" className="ibtn tip" data-tip="Fullscreen" aria-label="Fullscreen" onClick={toggleFullscreen}>
              <Icon name="fullscreen" />
            </button>
          )}
          <button type="button" className="ibtn tip" data-tip="Controls" aria-label="Controls" onClick={() => setPanel("controls")}>
            <Icon name="gamepad" size={22} />
          </button>
          {signedIn && (
            <button type="button" className="ibtn tip" data-tip="Leaderboard" aria-label="Friends and leaderboard" onClick={() => setPanel("friends")}>
              <Icon name="trophy" />
            </button>
          )}
          <button type="button" className="ibtn tip" data-tip="Account" aria-label="Account and saves" onClick={() => setPanel("account")}>
            <Icon name="user" />
          </button>
        </div>
        {confirmReset && !menu && (
          <ResetConfirm title={title} onCancel={() => setConfirmReset(false)} onReset={doReset} className="popover" />
        )}
      </div>

      <KeysHint platform={session.rom.platform} bindings={bindings} onEdit={() => setPanel("controls")} />

      {menu && (
        <div className="backdrop sheet-backdrop" onClick={() => setMenu(false)}>
          <div
            className="sheet plastic"
            role="dialog"
            aria-modal="true"
            aria-labelledby="menu-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === "Escape" && setMenu(false)}
          >
            <div className="side-head">
              <h2 id="menu-title" className="px">
                MENU
              </h2>
              <button type="button" className="ibtn" autoFocus onClick={() => setMenu(false)} aria-label="Close menu">
                <Icon name="close" size={18} />
              </button>
            </div>
            {confirmReset ? (
              <ResetConfirm title={title} onCancel={() => setConfirmReset(false)} onReset={doReset} />
            ) : (
              <>
                <div className="tiles">
                  {tools.map((t) => (
                    <button
                      key={t.label}
                      type="button"
                      className="tile"
                      disabled={t.disabled}
                      onClick={() => {
                        t.onClick();
                        if (t.label !== "Reset") setMenu(false);
                      }}
                    >
                      <Icon name={t.icon} size={22} /> {t.label}
                    </button>
                  ))}
                  <button type="button" className="tile" onClick={() => onPrefs({ muted: !prefs.muted })}>
                    <Icon name={muted ? "soundOff" : "soundOn"} size={22} /> {prefs.muted ? "Unmute" : "Mute"}
                  </button>
                  {CAN_FULLSCREEN && (
                    <button type="button" className="tile" onClick={toggleFullscreen}>
                      <Icon name="fullscreen" size={22} /> Fullscreen
                    </button>
                  )}
                  <button type="button" className="tile" onClick={() => (setMenu(false), setPanel("controls"))}>
                    <Icon name="gamepad" size={24} /> Controls
                  </button>
                  {signedIn && (
                    <button type="button" className="tile" onClick={() => (setMenu(false), setPanel("friends"))}>
                      <Icon name="trophy" size={22} /> Leaderboard
                    </button>
                  )}
                  <button type="button" className="tile" onClick={() => (setMenu(false), setPanel("account"))}>
                    <Icon name="user" size={22} /> Account
                  </button>
                  <button type="button" className="tile" onClick={onEject}>
                    <Icon name="eject" size={22} /> Games
                  </button>
                </div>
                <div className="sheet-rows">
                  <div className="sheet-row">
                    <label htmlFor="menu-volume">Volume</label>
                    <VolumeSlider prefs={prefs} onPrefs={onPrefs} id="menu-volume" />
                  </div>
                  <label className="sheet-row">
                    Vibrate on press
                    <input
                      className="switch"
                      type="checkbox"
                      role="switch"
                      checked={prefs.haptics}
                      onChange={(e) => onPrefs({ haptics: e.target.checked })}
                    />
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {panel === "controls" && (
        <ControlsPanel
          bindings={prefs.controls}
          platform={session.rom.platform}
          signedIn={signedIn}
          onChange={(controls) => onPrefs({ controls })}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === "friends" && <FriendsPanel current={{ romHash: session.rom.romHash }} onClose={() => setPanel(null)} />}

      {panel === "account" && (
        <CloudPanel
          prefs={prefs}
          onPrefs={onPrefs}
          onSignedIn={() => switchIdentity(resetPlayerKey)}
          onSignOut={(everywhere) => switchIdentity(() => signOut(everywhere))}
          onBeforeRestore={async () => {
            await sync?.flush();
            sync?.destroy();
          }}
          current={{ romHash: session.rom.romHash, status, onDownload: downloadSave }}
          onClose={() => setPanel(null)}
        />
      )}

      {status.state === "conflict" && (
        <SaveChoice
          inGame
          title={title}
          local={{ updatedAt: localSave?.updatedAt ?? Date.now(), playTime: localSave?.playTime ?? 0 }}
          cloud={status.cloud}
          recommended={status.cloud.updatedAt > (localSave?.updatedAt ?? 0) ? "cloud" : "local"}
          onChoose={(c, backup) => resolveConflict(c, backup)}
        />
      )}

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

function VolumeSlider({ prefs, onPrefs, id }: { prefs: Preferences; onPrefs: (patch: Partial<Preferences>) => void; id?: string }) {
  const value = prefs.muted ? 0 : prefs.volume;
  return (
    <input
      id={id}
      className="volume"
      type="range"
      min={0}
      max={1}
      step={0.05}
      value={value}
      onChange={(e) => onPrefs({ volume: Number(e.target.value), muted: false })}
      aria-label={id ? undefined : "Volume"}
      aria-valuetext={prefs.muted ? "Muted" : `${Math.round(value * 100)} percent`}
    />
  );
}

function ResetConfirm({
  title,
  onCancel,
  onReset,
  className = "",
}: {
  title: string;
  onCancel: () => void;
  onReset: () => void;
  className?: string;
}) {
  return (
    <div
      className={`reset-confirm plastic enter ${className}`}
      role="alertdialog"
      aria-labelledby="reset-title"
      aria-describedby="reset-desc"
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <h2 id="reset-title">Reset {title}?</h2>
      <p id="reset-desc">Progress since your last in-game save will be lost. Your saved game isn’t touched.</p>
      <div className="row end">
        <button id="reset-cancel" type="button" className="btn small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn small primary" onClick={onReset}>
          Reset
        </button>
      </div>
    </div>
  );
}

function KeysHint({ platform, bindings, onEdit }: { platform: PlatformId; bindings: KeyBindings; onEdit: () => void }) {
  const first = (codes: string[] = []) => (codes[0] ? keyLabel(codes[0]) : "none");
  const dpad = ["up", "down", "left", "right"] as const;
  const arrows = dpad.every((d) => bindings[d]?.[0] === `Arrow${d[0]!.toUpperCase()}${d.slice(1)}`);
  const buttons = PLATFORMS[platform].buttons.filter((b) => !(dpad as readonly string[]).includes(b));
  return (
    <p className="keys-hint">
      {arrows ? "Arrows move" : dpad.map((d) => <kbd key={d}>{first(bindings[d])}</kbd>)}
      {buttons.map((b) => (
        <Fragment key={b}>
          {" · "}
          <kbd>{first(bindings[b])}</kbd> {buttonLabel(platform, b)}
        </Fragment>
      ))}
      <button type="button" className="link on-dark" onClick={onEdit}>
        Change
      </button>
    </p>
  );
}
