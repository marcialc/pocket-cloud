import { useCallback, useEffect, useState } from "react";
import { CloudPanel } from "./components/CloudPanel";
import { ControlsPanel } from "./components/ControlsPanel";
import { backupName, downloadBytes } from "./components/download";
import { GameScreen } from "./components/GameScreen";
import { RomPicker } from "./components/RomPicker";
import { SaveChoice } from "./components/SaveChoice";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { RomError, displayName, inspectRom, type RomInfo } from "./emulator/rom";
import { loadPreferences, savePreferences, type Preferences } from "./preferences";
import { fetchAccount, signOut } from "./saves/authApi";
import { resetPlayerKey } from "./saves/identity";
import {
  clearCloudSyncState,
  deleteLocalSave,
  deleteRom,
  getLocalSave,
  getRom,
  listRoms,
  putLocalSave,
  putRom,
  renameRom,
  touchRom,
  type LocalGameSave,
  type RomSummary,
} from "./saves/localSaves";
import { localFromCloud, planLaunch, type LaunchPlan } from "./saves/SaveSync";
import { bindUiSounds } from "./uiSound";

export type Session = {
  rom: RomInfo;
  romData: ArrayBuffer;
  save: LocalGameSave | null;
  /** Upload the local save right after boot (it never reached / diverged from the cloud). */
  push: { force: boolean } | null;
};

type Stage =
  | { name: "pick"; error?: string }
  | { name: "loading"; label: string }
  | { name: "choose"; rom: RomInfo; romData: ArrayBuffer; plan: LaunchPlan }
  | { name: "play"; session: Session };

export function App() {
  const [stage, setStage] = useState<Stage>({ name: "pick" });
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);
  // null until IndexedDB answers, so the empty-shelf art doesn't flash on load.
  const [library, setLibrary] = useState<RomSummary[] | null>(null);
  // Signed-in email; undefined while checking, null when signed out.
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  const [welcome, setWelcome] = useState(false);
  const [panel, setPanel] = useState<"account" | "controls" | null>(null);

  // App-wide preferences that live outside any one screen.
  useEffect(() => {
    document.documentElement.dataset.motion = prefs.reduceMotion ? "reduce" : "system";
  }, [prefs.reduceMotion]);
  useEffect(() => (prefs.uiSounds ? bindUiSounds() : undefined), [prefs.uiSounds]);

  const refreshLibrary = useCallback(() => {
    listRoms().then(setLibrary, () => setLibrary([]));
  }, []);
  useEffect(refreshLibrary, [refreshLibrary]);

  useEffect(() => {
    fetchAccount().then((email) => {
      setAccount(email);
      if (!email && !loadPreferences().skipSignIn) setWelcome(true);
    });
  }, []);

  /** After sign-in: the old anonymous key now belongs to the account, so rotate it. */
  const signedIn = useCallback(async (email: string) => {
    resetPlayerKey();
    await clearCloudSyncState();
    setAccount(email);
    setWelcome(false);
  }, []);

  const signedOut = useCallback(async (everywhere: boolean) => {
    await signOut(everywhere);
    await clearCloudSyncState();
    setAccount(null);
  }, []);

  const updatePrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePreferences(next);
      return next;
    });
  }, []);

  const openRom = useCallback(
    async (data: ArrayBuffer, fileName: string) => {
      setStage({ name: "loading", label: "Reading cartridge…" });
      try {
        const rom = await inspectRom(data);
        if (prefs.rememberRom) {
          const existing = await getRom(rom.romHash);
          const now = Date.now();
          // ROM bytes are stored locally only, so the file never has to be picked again.
          await putRom({
            romHash: rom.romHash,
            fileName,
            title: displayName(rom),
            ...(existing?.customName ? { customName: existing.customName } : {}),
            data,
            addedAt: existing?.addedAt ?? now,
            lastPlayedAt: now,
          }).catch((err) => console.warn("Could not store this ROM locally", err));
          refreshLibrary();
        }
        setStage({ name: "loading", label: prefs.cloudSync ? "Checking for saves…" : "Loading save…" });
        let local = await getLocalSave(rom.romHash);
        const plan = await planLaunch(local, rom.romHash, prefs.cloudSync);
        const d = plan.decision;
        if (local && plan.cloud && plan.cloud.sramHash === local.sramHash && local.cloud?.revision !== plan.cloud.revision) {
          // Same bytes on both sides: just remember the cloud revision we match.
          local = { ...local, cloud: { revision: plan.cloud.revision, sramHash: plan.cloud.sramHash } };
          await putLocalSave(local);
        }
        if (d.use === "ask") {
          setStage({ name: "choose", rom, romData: data, plan });
        } else if (d.use === "cloud") {
          const save = localFromCloud(plan.cloud!);
          await putLocalSave(save);
          setStage({ name: "play", session: { rom, romData: data, save, push: null } });
        } else {
          const push = d.use === "local" && d.push ? { force: d.force ?? false } : null;
          setStage({ name: "play", session: { rom, romData: data, save: local, push } });
        }
      } catch (err) {
        console.error(err);
        const message = err instanceof RomError ? err.message : "Something went wrong loading that file.";
        setStage({ name: "pick", error: message });
      }
    },
    [prefs.cloudSync, prefs.rememberRom, refreshLibrary],
  );

  const chooseSave = useCallback(async (choice: "local" | "cloud", backup: boolean) => {
    if (stage.name !== "choose") return;
    const { rom, romData, plan } = stage;
    // Offer the save being replaced as a file first.
    if (backup && choice === "local" && plan.cloud) downloadBytes(plan.cloud.sram, backupName(rom.gameId, "cloud"));
    if (backup && choice === "cloud" && plan.local) downloadBytes(plan.local.sram, backupName(rom.gameId, "device"));
    if (choice === "cloud") {
      const save = localFromCloud(plan.cloud!);
      await putLocalSave(save);
      setStage({ name: "play", session: { rom, romData, save, push: null } });
    } else {
      setStage({ name: "play", session: { rom, romData, save: plan.local, push: { force: true } } });
    }
  }, [stage]);

  /** Play a game already in the library (no file picking). */
  const openStored = useCallback(
    async (romHash: string) => {
      setStage({ name: "loading", label: "Loading game…" });
      const stored = await getRom(romHash);
      if (!stored) {
        refreshLibrary();
        setStage({ name: "pick", error: "That game is no longer stored on this device." });
        return;
      }
      await touchRom(romHash);
      refreshLibrary();
      await openRom(stored.data, stored.fileName);
    },
    [openRom, refreshLibrary],
  );

  const removeStored = useCallback(
    async (romHash: string, alsoSave: boolean) => {
      await deleteRom(romHash);
      if (alsoSave) await deleteLocalSave(romHash);
      refreshLibrary();
    },
    [refreshLibrary],
  );

  const renameStored = useCallback(
    async (romHash: string, name: string) => {
      await renameRom(romHash, name);
      refreshLibrary();
    },
    [refreshLibrary],
  );

  switch (stage.name) {
    case "pick":
    case "loading":
      if (stage.name === "pick" && welcome) {
        return (
          <WelcomeScreen
            onSignedIn={signedIn}
            onSkip={() => {
              updatePrefs({ skipSignIn: true });
              setWelcome(false);
            }}
          />
        );
      }
      return (
        <>
          <RomPicker
            busy={stage.name === "loading" ? stage.label : account === undefined ? "Starting…" : null}
            error={stage.name === "pick" ? stage.error : undefined}
            library={library}
            prefs={prefs}
            onPrefs={updatePrefs}
            onOpen={openRom}
            onPlayStored={openStored}
            onRemoveStored={removeStored}
            onRenameStored={renameStored}
            account={account ?? null}
            onAccount={() => setPanel("account")}
            onControls={() => setPanel("controls")}
          />
          {panel === "account" && (
            <CloudPanel
              prefs={prefs}
              onPrefs={updatePrefs}
              onSignedIn={signedIn}
              onSignOut={async (everywhere) => {
                await signedOut(everywhere);
                setPanel(null);
              }}
              onClose={() => setPanel(null)}
            />
          )}
          {panel === "controls" && (
            <ControlsPanel
              bindings={prefs.keyBindings}
              onChange={(keyBindings) => updatePrefs({ keyBindings })}
              onClose={() => setPanel(null)}
            />
          )}
        </>
      );
    case "choose":
      return (
        <SaveChoice
          title={displayName(stage.rom)}
          local={stage.plan.local!}
          cloud={stage.plan.cloud!}
          recommended={stage.plan.decision.use === "ask" ? stage.plan.decision.recommended : "cloud"}
          onChoose={chooseSave}
        />
      );
    case "play":
      return (
        <GameScreen
          key={stage.session.rom.romHash + stage.session.save?.sramHash}
          session={stage.session}
          prefs={prefs}
          onPrefs={updatePrefs}
          onEject={() => setStage({ name: "pick" })}
        />
      );
  }
}
