import type { CloudSaveMeta } from "../../shared/api";
import type { LocalGameSave } from "../saves/localSaves";
import { formatPlayTime, formatWhen } from "./format";

type Props = {
  title: string;
  local: Pick<LocalGameSave, "updatedAt" | "playTime">;
  cloud: Pick<CloudSaveMeta, "updatedAt" | "playTime">;
  recommended: "local" | "cloud";
  onChoose: (choice: "local" | "cloud") => void;
  /** Shown mid-game: choosing cloud restarts the console. */
  inGame?: boolean;
};

export function SaveChoice({ title, local, cloud, recommended, onChoose, inGame }: Props) {
  const newer = cloud.updatedAt > local.updatedAt ? "cloud" : "local";
  return (
    <div className={inGame ? "modal-backdrop" : "landing"}>
      <div className="dialog" role="dialog" aria-labelledby="save-choice-title">
        <h2 id="save-choice-title">Two different saves</h2>
        <p>
          {title} has one save on this device and a different one in the cloud. Which one do you want to keep playing?
        </p>
        <div className="save-options">
          <button className={`save-option${recommended === "cloud" ? " recommended" : ""}`} onClick={() => onChoose("cloud")}>
            <strong>☁ Cloud save</strong>
            <span>Saved {formatWhen(cloud.updatedAt)}</span>
            {cloud.playTime ? <span>{formatPlayTime(cloud.playTime)} played</span> : null}
            {newer === "cloud" && <em>Newer</em>}
          </button>
          <button className={`save-option${recommended === "local" ? " recommended" : ""}`} onClick={() => onChoose("local")}>
            <strong>▣ This device</strong>
            <span>Saved {formatWhen(local.updatedAt)}</span>
            {local.playTime ? <span>{formatPlayTime(local.playTime)} played</span> : null}
            {newer === "local" && <em>Newer</em>}
          </button>
        </div>
        <p className="fine">
          The save you don’t pick is replaced{inGame ? " and the game restarts" : ""}.
        </p>
      </div>
    </div>
  );
}
