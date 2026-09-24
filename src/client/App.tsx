import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ListRomsResponse } from "../shared/api";
import { EMPTY_SHELF, forgetGame, gameName, renameGame, sameShelf, type Shelf } from "../shared/shelf";
import { CloudPanel } from "./components/CloudPanel";
import { ControlsPanel } from "./components/ControlsPanel";
import { FriendsPanel } from "./components/FriendsPanel";
import { backupName, downloadBytes } from "./components/download";
import { GameScreen } from "./components/GameScreen";
import { InviteDialog } from "./components/InviteDialog";
import { RomPicker } from "./components/RomPicker";
import { SaveChoice } from "./components/SaveChoice";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { RomError, displayName, inspectRom, type RomInfo } from "./emulator/rom";
import { loadPreferences, resetCloudRomsChoice, savePreferences, type Preferences } from "./preferences";
import { fetchAccount, signOut } from "./saves/authApi";
import { deleteCloudRom, downloadCloudRom, listCloudRoms } from "./saves/cloudApi";
import { pushKeyBindings, syncKeyBindings } from "./saves/controlsSync";
import { resetPlayerKey } from "./saves/identity";
import { forgetUnsyncedShelf, pushShelf, syncShelf } from "./saves/shelfSync";
import { clearInvite, takeInvite } from "./saves/invite";
import {
  clearCloudSyncState,
  deleteLocalSave,
  deleteRom,
  forgetLegacyNames,
  getLocalSave,
  getRom,
  legacyNames,
  listRoms,
  putLocalSave,
  putRom,
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
import { matchCloud } from "./saves/sync";
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
  const accountRef = useRef(account);
  accountRef.current = account;
  // Games kept in the account; null while loading, when signed out, cloud backup is off, or the cloud can't be reached.
  const [cloud, setCloud] = useState<ListRomsResponse | null>(null);
  const cloudRoms = cloud?.roms ?? null;
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;
  // Bumped on every list request, so an answer that arrives late (e.g. after sign-out) is dropped.
  const cloudRequest = useRef(0);
  const [welcome, setWelcome] = useState(false);
  // A friend's invite link this browser opened; it asks to sign in itself, so no welcome screen.
  const [invite, setInvite] = useState(takeInvite);
  const inviteRef = useRef(invite);
  const [panel, setPanel] = useState<"account" | "controls" | "friends" | null>(null);

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

  const names = prefs.shelf.names;
  const shelf = useMemo(() => (library ? mergeLibrary(library, cloudRoms, names) : null), [library, cloudRoms, names]);

  useEffect(() => {
    fetchAccount().then((email) => {
      setAccount(email);
      if (!email && !loadPreferences().skipSignIn && !inviteRef.current) setWelcome(true);
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
    // The favorites and groups (with names the player typed) stay in the account, not in this browser
    // for whoever signs in next.
    forgetUnsyncedShelf();
    const next = { ...resetCloudRomsChoice(), shelf: EMPTY_SHELF };
    savePreferences(next);
    setPrefs(next);
    setAccount(null);
  }, []);

  const storePrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePreferences(next);
      return next;
    });
  }, []);

  const updatePrefs = useCallback(
    (patch: Partial<Preferences>) => {
      storePrefs(patch);
      // Signed in: the controls follow the account to other browsers.
      if (patch.controls && accountRef.current) void pushKeyBindings(accountRef.current, patch.controls);
      // ...and so do the library's favorites and groups.
      if (patch.shelf && accountRef.current) void pushShelf(accountRef.current, patch.shelf);
    },
    [storePrefs],
  );

  // Signed in: use the account's controls (or give it this browser's if it has none yet).
  useEffect(() => {
    if (!account) return;
    let stale = false;
    syncKeyBindings(account, loadPreferences().controls).then(
      (controls) => !stale && controls && storePrefs({ controls }),
      (err) => console.warn("Could not load the controls from the account", err),
    );
    return () => {
      stale = true;
    };
  }, [account, storePrefs]);

  /**
   * Game names used to be kept with the ROM in this browser only. Once `shelf` is the one to use, move
   * them into it (a name it already has wins), so they follow the account and show on the game screen.
   */
  const adoptLegacyNames = useCallback(
    async (shelf: Shelf) => {
      const legacy = await legacyNames();
      let next = shelf;
      const moved: string[] = [];
      for (const [romHash, name] of Object.entries(legacy)) {
        if (gameName(next, romHash) === undefined) {
          const named = renameGame(next, romHash, name);
          // No room: it stays here and is tried again next time.
          if (named === next) continue;
          next = named;
        }
        moved.push(romHash);
      }
      if (next !== shelf) updatePrefs({ shelf: next });
      await forgetLegacyNames(moved);
    },
    [updatePrefs],
  );
  const warnLegacyNames = (err: unknown) => console.warn("Could not move game names to the library shelf", err);

  // Signed in: use the account's favorites and groups (or give it this browser's if it has none yet).
  // Checked again whenever the page comes back into view: phones keep a tab open for days, and the
  // player may have changed the shelf on another device meanwhile.
  useEffect(() => {
    if (!account) return;
    let stale = false;
    const sync = () =>
      syncShelf(account, loadPreferences().shelf).then(
        (shelf) => {
          if (stale) return;
          if (shelf && !sameShelf(shelf, loadPreferences().shelf)) storePrefs({ shelf });
          adoptLegacyNames(shelf ?? loadPreferences().shelf).catch(warnLegacyNames);
        },
        (err) => console.warn("Could not load the library groups from the account", err),
      );
    const onVisible = () => document.visibilityState === "visible" && void sync();
    void sync();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stale = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [account, storePrefs, adoptLegacyNames]);

  // Signed out: this browser's shelf is the one.
  useEffect(() => {
    if (account === null) adoptLegacyNames(loadPreferences().shelf).catch(warnLegacyNames);
  }, [account, adoptLegacyNames]);

  const openRom = useCallback(
    /** `picked`: the player chose this file just now (not from the library). */
    async (data: ArrayBuffer, fileName: string, picked: boolean) => {
      setStage({ name: "loading", label: "Reading cartridge…" });
      try {
        const rom = await inspectRom(data, fileName);
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
        if (
          local &&
          plan.cloud &&
          plan.cloud.sramHash === local.sramHash &&
          (local.cloud?.revision !== plan.cloud.revision || (plan.cloud.rtcBase !== undefined && plan.cloud.rtcBase !== local.rtcBase))
        ) {
          // Same bytes on both sides: remember the cloud revision we match, and use its clock base.
          local = matchCloud(local, plan.cloud);
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
      let removedFromAccount = false;
      if (alsoCloud) {
        removedFromAccount = await deleteCloudRom(romHash).then(
          () => {
            forgetBackUp(romHash);
            return true;
          },
          (err) => {
            console.warn("Could not remove this ROM from the account", err);
            return false;
          },
        );
        refreshCloudRoms();
      }
      // Signed in, the game may still be in the account: only when its list says it isn't do we know it's gone.
      const stillInAccount =
        !removedFromAccount && !!accountRef.current && (cloudRoms === null || cloudRoms.some((r) => r.romHash === romHash));
      // Gone from the library altogether: unfavorite it and take it out of its groups.
      if (!stillInAccount) {
        const { shelf } = loadPreferences();
        const next = forgetGame(shelf, romHash);
        if (next !== shelf) updatePrefs({ shelf: next });
      }
      refreshLibrary();
    },
    [refreshLibrary, refreshCloudRoms, cloudRoms, updatePrefs],
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
            account={account ?? null}
            onAccount={() => setPanel("account")}
            onControls={() => setPanel("controls")}
            onFriends={() => setPanel("friends")}
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
          {panel === "friends" && account && <FriendsPanel onClose={() => setPanel(null)} />}
          {invite && stage.name === "pick" && (
            <InviteDialog
              token={invite}
              account={account}
              onSignedIn={signedIn}
              onDone={(openFriends) => {
                clearInvite();
                setInvite(null);
                if (openFriends) setPanel("friends");
              }}
            />
          )}
          {panel === "controls" && (
            <ControlsPanel
              bindings={prefs.controls}
              signedIn={!!account}
              onChange={(controls) => updatePrefs({ controls })}
              onClose={() => setPanel(null)}
            />
          )}
        </>
      );
    case "choose":
      return (
        <SaveChoice
          title={gameName(prefs.shelf, stage.rom.romHash) ?? displayName(stage.rom)}
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
          signedIn={!!account}
          onEject={() => setStage({ name: "pick" })}
        />
      );
  }
}
