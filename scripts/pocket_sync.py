#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

import requests
from tqdm import tqdm

DEFAULT_BASE = "https://pocketcloud.app"
DEFAULT_COOKIE_FILE = Path.home() / ".pocket-sync-cookies.json"
MIN_ROM_BYTES = 1024
MAX_ROM_BYTES = 32 * 1024 * 1024
MAX_CLOUD_ROMS = 100
MAX_RETRIES = 5
BACKOFF_FACTOR = 2.0
TIMEOUT = 180
DEFAULT_CONCURRENCY = 2

_local = threading.local()


def session() -> requests.Session:
    """One cookie jar per thread (requests.Session is not thread-safe)."""
    if not hasattr(_local, "session"):
        _local.session = requests.Session()
    return _local.session


def _auth_error(response: requests.Response) -> str:
    """Human-readable failure for an auth endpoint answer that isn't ok."""
    try:
        body = response.json()
    except ValueError:
        body = {}
    code = body.get("error", f"HTTP {response.status_code}")
    if response.status_code == 429 and "retryAfter" in body:
        return f"rate_limited (new code available in {body['retryAfter']}s; wait or reuse a cached session)"
    if code == "auth_unavailable":
        return "auth unavailable on this deployment (SESSION_SECRET missing or too short)"
    return str(code)


def normalize_code(raw: str) -> str:
    """Mirrors the server's normalizeCode: drop spaces/dashes, uppercase."""
    return raw.replace(" ", "").replace("-", "").strip().upper()


def login(base_url: str, email: str) -> None:
    """Run the email code flow; the session cookie lands in the cookie jar."""
    s = session()
    response = s.post(f"{base_url}/api/auth/request", json={"email": email}, timeout=30)
    if response.status_code != 200:
        print(f"Sign-in failed: {_auth_error(response)}")
        sys.exit(2)
    code = normalize_code(getpass.getpass("Sign-in code (check your email): "))
    response = s.post(f"{base_url}/api/auth/verify", json={"email": email, "code": code}, timeout=30)
    if response.status_code != 200:
        print(f"Sign-in failed: {_auth_error(response)}")
        sys.exit(2)
    print(f"Signed in as {email}.")


def save_session_cookie(base_url: str, cookie_file: Path) -> None:
    """Persist the session cookie so later runs skip the email round-trip."""
    host = urlparse(base_url).hostname or ""
    for cookie in session().cookies:
        if cookie.name.endswith("pc_session"):
            cookie_file.parent.mkdir(parents=True, exist_ok=True)
            cookie_file.write_text(
                json.dumps({"name": cookie.name, "value": cookie.value, "domain": cookie.domain or host})
            )
            os.chmod(cookie_file, 0o600)
            return


def restore_session(base_url: str, cookie_file: Path) -> bool:
    """Load a cached cookie and check it against /api/auth/me."""
    if not cookie_file.exists():
        return False
    try:
        data = json.loads(cookie_file.read_text())
        name, value = data["name"], data["value"]
    except (OSError, ValueError, KeyError):
        return False
    host = urlparse(base_url).hostname or ""
    s = session()
    s.cookies.set(name, value, domain=data.get("domain") or host, path="/")
    try:
        response = s.get(f"{base_url}/api/auth/me", timeout=30)
    except requests.exceptions.RequestException:
        s.cookies.clear()
        return False
    if response.status_code != 200:
        s.cookies.clear() 
        return False
    print(f"Signed in as {response.json().get('email', '?')} (cached session).")
    return True


def ensure_session(base_url: str, email: str, cookie_file: Path) -> None:
    """Reuse a cached session when it still validates; otherwise sign in."""
    if restore_session(base_url, cookie_file):
        return
    login(base_url, email)
    save_session_cookie(base_url, cookie_file)


def list_roms(base_url: str) -> dict:
    response = session().get(f"{base_url}/api/roms", timeout=30)
    response.raise_for_status()
    return response.json()


def _ascii_field(raw: bytes) -> str:
    """Printable ASCII up to the first NUL, trimmed — rom.ts's asciiField."""
    text = raw.split(b"\x00", 1)[0]
    return bytes(c for c in text if 0x20 <= c <= 0x7E).decode("ascii").strip()


def cartridge_title(data: bytes) -> str:
    """Header title, mirroring src/client/emulator/rom.ts so the account shows
    the same title the browser would display: GBA carts carry a 12-byte title
    at 0xA0 (fixed 0x96 byte at 0xB2 proves the header); Game Boy carts carry
    16 bytes at 0x134, shortened to 0x143 on CGB-era cartridges."""
    if len(data) > 0xB2 and data[0xB2] == 0x96:
        return _ascii_field(data[0xA0:0xAC])
    if len(data) > 0x143:
        end = 0x143 if data[0x143] in (0x80, 0xC0) else 0x144
        return _ascii_field(data[0x134:end])
    return ""


def _backoff_seconds(attempt: int, response: requests.Response | None) -> float:
    """Retry-After header first, then the server's JSON retryAfter field
    (where the Worker actually reports it), else exponential backoff."""
    delay = None
    if response is not None:
        header = response.headers.get("Retry-After")
        if header and header.isdigit():
            delay = float(header)
        else:
            try:
                body = response.json()
            except ValueError:
                body = {}
            if isinstance(body.get("retryAfter"), (int, float)):
                delay = float(body["retryAfter"])
    return (delay if delay is not None else BACKOFF_FACTOR**attempt) + random.uniform(0, 0.5)


def upload_rom(base_url: str, path: Path, picked: bool = True) -> tuple[Path, str, str]:
    """Upload one ROM. Returns (path, romHash, outcome).

    Outcome is 'uploaded', 'duplicate', or an error reason. The file handle is
    reopened inside the retry loop so every attempt streams from offset 0.
    """
    size = path.stat().st_size
    if size < MIN_ROM_BYTES:
        return path, "", f"too_small ({size} B < {MIN_ROM_BYTES})"
    if size > MAX_ROM_BYTES:
        return path, "", f"too_large ({size} B > {MAX_ROM_BYTES})"

    data = path.read_bytes()
    rom_hash = hashlib.sha256(data).hexdigest()
    title = cartridge_title(data) or path.stem
    query = f"name={path.name[:255]}&title={title[:64]}" + ("&picked=1" if picked else "")
    url = f"{base_url}/api/roms/{rom_hash}?{query}"

    last_reason = "unknown error"
    for attempt in range(1, MAX_RETRIES + 1):
        response = None
        try:
            with open(path, "rb") as handle:
                response = session().put(
                    url,
                    data=handle,
                    timeout=TIMEOUT,
                    headers={"Content-Type": "application/octet-stream"},
                )
            if response.status_code == 200:
                return path, rom_hash, "uploaded"
            last_reason = f"HTTP {response.status_code}: {response.text[:200]}"
            if response.status_code in (409, 403):
                return path, rom_hash, last_reason
            if 400 <= response.status_code < 500 and response.status_code not in (408, 429):
                break
        except (requests.exceptions.RequestException, OSError) as exc:
            last_reason = f"{type(exc).__name__}: {exc}"
        if attempt < MAX_RETRIES:
            time.sleep(_backoff_seconds(attempt, response))
    return path, rom_hash, last_reason


def cmd_upload(base_url: str, directory: Path, concurrency: int) -> int:
    if not directory.is_dir():
        print(f"Error: directory '{directory}' does not exist.")
        return 2
    files = sorted(p for p in directory.iterdir() if p.is_file())
    if not files:
        print(f"No files found in '{directory}'.")
        return 2

    remote = list_roms(base_url)
    already = {rom["romHash"] for rom in remote.get("roms", [])}
    removed = set(remote.get("removed", []))
    quota = MAX_CLOUD_ROMS - len(already)

    todo: list[Path] = []
    duplicates = 0
    for path in files:
        size = path.stat().st_size
        if MIN_ROM_BYTES <= size <= MAX_ROM_BYTES:
            data_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            if data_hash in already:
                duplicates += 1
                continue
        if quota - len(todo) <= 0:
            print(f"Account library full ({MAX_CLOUD_ROMS}); stopping after {len(todo)} files.")
            break
        todo.append(path)

    print(f"{len(files)} files found, {duplicates} already in the account, {len(todo)} to upload.")
    if removed:
        print(f"{len(removed)} previously removed games: re-uploads use picked=1, so they go back in.")

    succeeded: list[str] = []
    skipped: list[tuple[str, str]] = []
    failed: list[tuple[str, str]] = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(upload_rom, base_url, path): path for path in todo}
        with tqdm(total=len(todo), desc="ROM library", unit="rom") as bar:
            for future in as_completed(futures):
                path, rom_hash, outcome = future.result()
                if outcome == "uploaded":
                    succeeded.append(path.name)
                elif outcome.startswith("HTTP 409"):
                    skipped.append((path.name, "removed (409)"))
                else:
                    failed.append((path.name, outcome))
                bar.update(1)
                bar.set_postfix(last=path.name[:24])

    print("\n--- Upload Summary ---")
    print(f"Total: {len(files)}  uploaded: {len(succeeded)}  skipped: {len(skipped)}  failed: {len(failed)}")
    for name, reason in skipped + failed:
        print(f"  {reason.split(' ')[0].upper():>10}  {name}: {reason}")
    return 1 if failed else 0


def cmd_saves(base_url: str, player_key: str) -> int:
    """Saves are the one surface the anonymous player key still reaches."""
    response = session().get(
        f"{base_url}/api/saves",
        headers={"Authorization": f"Bearer {player_key}"},
        timeout=30,
    )
    if response.status_code != 200:
        print(f"Error: {response.status_code} {response.text[:200]}")
        return 1
    for save in response.json().get("saves", []):
        print(f"{save['gameId']:<20} rev {save['revision']:<4} {save['sramSize'] // 1024:>4} KiB  {save['romHash'][:16]}…")
    return 0


def main() -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-url", default=DEFAULT_BASE, help=f"deployment base URL (default: {DEFAULT_BASE})")
    common.add_argument(
        "--cookie-file",
        type=Path,
        default=DEFAULT_COOKIE_FILE,
        help=f"cached session cookie path (default: {DEFAULT_COOKIE_FILE})",
    )

    parser = argparse.ArgumentParser(description="pocket-cloud bulk ROM library uploader")
    sub = parser.add_subparsers(dest="command", required=True)

    p_login = sub.add_parser("login", parents=[common], help="sign in with an email code")
    p_login.add_argument("--email", required=True)

    p_list = sub.add_parser("list", parents=[common], help="list the account's cloud ROM library")
    p_list.add_argument("--email", required=True)

    p_upload = sub.add_parser("upload", parents=[common], help="upload every file in a directory")
    p_upload.add_argument("directory", type=Path)
    p_upload.add_argument("--email", required=True)
    p_upload.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)

    p_saves = sub.add_parser("saves", parents=[common], help="list saves for an anonymous player key")
    p_saves.add_argument("--player-key", required=True)

    args = parser.parse_args()

    if args.command == "login":
        login(args.base_url, args.email)
        save_session_cookie(args.base_url, args.cookie_file)
        return 0
    if args.command == "list":
        ensure_session(args.base_url, args.email, args.cookie_file)
        for rom in list_roms(args.base_url).get("roms", []):
            print(f"{rom['title']:<24} {rom['size'] // 1024:>6} KiB  {rom['romHash'][:16]}…")
        return 0
    if args.command == "upload":
        ensure_session(args.base_url, args.email, args.cookie_file)
        return cmd_upload(args.base_url, args.directory, max(1, args.concurrency))
    return cmd_saves(args.base_url, args.player_key)


if __name__ == "__main__":
    sys.exit(main())
