/**
 * Optional UI click sound (Preferences.uiSounds, off by default). A tiny
 * square-wave blip made with Web Audio, so there is no asset to load.
 * Never plays for the touch gamepad: game input stays silent.
 */
let ctx: AudioContext | null = null;

export function playClick(): void {
  try {
    ctx ??= new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 1320;
    gain.gain.setValueAtTime(0.035, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.04);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  } catch {
    // Audio unavailable (autoplay policy, old browser): clicks are cosmetic.
  }
}

const CLICKABLE = "button, a[href], input[type=checkbox], [role=switch]";

/** Plays a click for UI controls while enabled. Returns a cleanup function. */
export function bindUiSounds(): () => void {
  const onClick = (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target.closest(CLICKABLE) : null;
    if (el && !el.closest(".touch-controls")) playClick();
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
