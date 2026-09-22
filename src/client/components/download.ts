/** Saves bytes as a file via a temporary object URL (e.g. a .sav backup). */
export function downloadBytes(bytes: Uint8Array | ArrayBuffer, fileName: string): void {
  const data = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
  const url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "POKEMON RED" + "cloud" → "POKEMON RED (cloud 2026-09-22).sav" */
export function backupName(gameId: string, label: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${gameId} (${label} ${day}).sav`;
}
