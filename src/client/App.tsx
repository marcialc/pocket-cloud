import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ListRomsResponse } from "../shared/api";
import { CloudPanel } from "./components/CloudPanel";
import { ControlsPanel } from "./components/ControlsPanel";
import { backupName, downloadBytes } from "./components/download";
import { GameScreen } from "./components/GameScreen";
import { RomPicker } from "./components/RomPicker";
import { SaveChoice } from "./components/SaveChoice";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { RomError, displayName, inspectRom, type RomInfo } from "./emulator/rom";
import { loadPreferences, resetCloudRomsChoice, savePreferences, type Preferences } from "./preferences";
import { fetchAccount, signOut } from "./saves/authApi";
import { deleteCloudRom, downloadCloudRom, listCloudRoms } from "./saves/cloudApi";
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
import {
  backUpLibrary,
  backUpRom,
  forgetBackUp,
  mergeLibrary,
  missingFromAccount,
  resetBackUpState,
} from "./saves/romLibrary";
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
  // Games kept in the account; null while loading, when signed out, cloud backup is off, or the cloud can't be reached.
  const [cloud, setCloud] = useState<ListRomsResponse | null>(null);
  const cloudRoms = cloud?.roms ?? null;
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;
  // Bumped on every list request, so an answer that arrives late (e.g. after sign-out) is dropped.
  const cloudRequest = useRef(0);
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

  /** Signed in with cloud backup on: show and download the account's games. */
  const cloudLibrary = !!account && prefs.cloudSync;
  /** ...and the player agreed to keep their games there: upload them too. */
  const keepGames = cloudLibrary && prefs.cloudRoms === "on";
  const refreshCloudRoms = useCallback(() => {
    const request = ++cloudRequest.current;
    if (!cloudLibrary) {
      setCloud(null);
      return;
    }
    listCloudRoms().then(
      (list) => request === cloudRequest.current && setCloud(list),
      () => request === cloudRequest.current && setCloud(null),
    );
  }, [cloudLibrary]);
  useEffect(refreshCloudRoms, [refreshCloudRoms]);

  // Once the player has agreed (and the account's list has loaded), back up the games already in
  // this browser. Runs once per sign-in, not on every list refresh; sign-out stops it.
  const cloudReady = cloud !== null;
  const [backingUp, setBackingUp] = useState(false);
  useEffect(() => {
    if (!keepGames || !cloudReady) return;
    const stop = new AbortController();
    setBackingUp(true);
    backUpLibrary(cloudRef.current!, stop.signal)
      .then((n) => !stop.signal.aborted && n > 0 && refreshCloudRoms())
      .finally(() => !stop.signal.aborted && setBackingUp(false));
    return () => {
      stop.abort();
      setBackingUp(false);
    };
  }, [keepGames, cloudReady, refreshCloudRoms]);

  // One-time question, asked once the account's list is in: how many games would be uploaded.
  const offerKeepGames =
    cloudLibrary && prefs.cloudRoms === "ask" && cloud && library ? { missing: missingFromAccount(library, cloud).length } : null;

  const shelf = useMemo(() => (library ? mergeLibrary(library, cloudRoms) : null), [library, cloudRoms]);

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
    resetBackUpState();
    setPrefs(resetCloudRomsChoice());
    setAccount(email);
    setWelcome(false);
  }, []);

  const signedOut = useCallback(async (everywhere: boolean) => {
    await signOut(everywhere);
    await clearCloudSyncState();
    resetBackUpState();
    setPrefs(resetCloudRomsChoice());
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
    /** `picked`: the player chose this file just now (not from the library). */
    async (data: ArrayBuffer, fileName: string, picked: boolean) => {
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
        // Only once the account's list is known, so a game it already has isn't sent again. A game the
        // player removed from the account goes back only if they picked the file again.
        const inAccount = cloud?.roms.some((r) => r.romHash === rom.romHash);
        const removed = cloud?.removed.includes(rom.romHash);
        if (keepGames && cloud && !inAccount && (picked || !removed)) {
          // Runs in the background; the game starts right away.
          backUpRom({ romHash: rom.romHash, fileName, title: displayName(rom), data }, picked).then(refreshCloudRoms, (err) =>
            console.warn("Could not back up this ROM to the account", err),
          );
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
    [prefs.cloudSync, prefs.rememberRom, refreshLibrary, keepGames, cloud, refreshCloudRoms],
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
      if (stored) {
        await touchRom(romHash);
        refreshLibrary();
        await openRom(stored.data, stored.fileName, false);
        return;
      }
      // Not in this browser: fetch it from the account (first play on a new device).
      const entry = cloudRoms?.find((r) => r.romHash === romHash);
      if (!entry) {
        refreshLibrary();
        setStage({ name: "pick", error: "That game is no longer stored on this device." });
        return;
      }
      setStage({ name: "loading", label: "Downloading game…" });
      let data: ArrayBuffer | null;
      try {
        data = await downloadCloudRom(romHash);
      } catch {
        setStage({ name: "pick", error: "Couldn’t download that game. Check your connection and try again." });
        return;
      }
      if (!data) {
        refreshCloudRoms();
        setStage({ name: "pick", error: "That game is no longer in your account." });
        return;
      }
      await openRom(data, entry.fileName, false);
    },
    [openRom, refreshLibrary, cloudRoms, refreshCloudRoms],
  );

  const removeStored = useCallback(
    async (romHash: string, alsoSave: boolean, alsoCloud: boolean) => {
      await deleteRom(romHash);
      if (alsoSave) await deleteLocalSave(romHash);
      if (alsoCloud) {
        await deleteCloudRom(romHash).then(
          () => forgetBackUp(romHash),
          (err) => console.warn("Could not remove this ROM from the account", err),
        );
        refreshCloudRoms();
      }
      refreshLibrary();
    },
    [refreshLibrary, refreshCloudRoms],
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
            library={shelf}
            cloudLibrary={cloudLibrary}
            prefs={prefs}
            onPrefs={updatePrefs}
            onOpen={(data, fileName) => openRom(data, fileName, true)}
            offerKeepGames={offerKeepGames}
            onKeepGames={(on) => updatePrefs({ cloudRoms: on ? "on" : "off" })}
            backingUp={backingUp}
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
