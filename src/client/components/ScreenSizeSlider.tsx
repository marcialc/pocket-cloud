import { MIN_SCREEN_SIZE, type Preferences } from "../preferences";

export function ScreenSizeSlider({ prefs, onPrefs, id }: { prefs: Preferences; onPrefs: (patch: Partial<Preferences>) => void; id?: string }) {
  return (
    <input
      id={id}
      className="volume"
      type="range"
      min={MIN_SCREEN_SIZE}
      max={1}
      step={0.05}
      value={prefs.screenSize}
      onChange={(e) => onPrefs({ screenSize: Number(e.target.value) })}
      aria-valuetext={`${Math.round(prefs.screenSize * 100)} percent`}
    />
  );
}
