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
from urllib.parse import urlencode, urlparse

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

_cookie: dict[str, str] | None = None
_host: str = ""
_local = threading.local()


def session() -> requests.Session:
    """This thread's Session, with the current session cookie applied."""
    if not hasattr(_local, "session"):
        _local.session = requests.Session()
    if _cookie:
        _local.session.cookies.set(_cookie["name"], _cookie["value"], domain=_host, path="/")
    return _local.session


def _adopt_set_cookie(header: str) -> None:
    """Take name=value from the Set-Cookie header; ignore the attributes
    (Secure/HttpOnly are browser enforcement, and we manage persistence)."""
    global _cookie
    pair = header.split(";", 1)[0]
    name, _, value = pair.partition("=")
    if not name or not value:
        print("Sign-in failed: verify response carried no usable session cookie.")
        sys.exit(1)
    _cookie = {"name": name.strip(), "value": value.strip()}


def _session_key(base_url: str, email: str) -> str:
    """Cached sessions are keyed by email AND deployment, so working across
    accounts or preview/production can never cross the wires."""
    return f"{urlparse(base_url).hostname}|{email}"


def _load_cookie_map(cookie_file: Path) -> dict:
    try:
        data = json.loads(cookie_file.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_cookie_map(cookie_file: Path, map_: dict) -> None:
    """Create the file 0600 from the start — never a world-readable moment."""
    cookie_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(cookie_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(map_, handle)


def save_session_cookie(base_url: str, email: str, cookie_file: Path) -> None:
    map_ = _load_cookie_map(cookie_file)
    map_[_session_key(base_url, email)] = _cookie
    _write_cookie_map(cookie_file, map_)


def forget_session_cookie(base_url: str, email: str, cookie_file: Path) -> None:
    map_ = _load_cookie_map(cookie_file)
    if map_.pop(_session_key(base_url, email), None) is not None:
        _write_cookie_map(cookie_file, map_)


def restore_session(base_url: str, email: str, cookie_file: Path) -> bool:
    """Reuse a cached cookie only when /api/auth/me confirms the SAME email;
    anything else (missing, expired, signed-out, wrong account) means a fresh
    sign-in. The record is dropped when it proves bad."""
    global _cookie
    record = _load_cookie_map(cookie_file).get(_session_key(base_url, email))
    if not isinstance(record, dict) or not record.get("name") or not record.get("value"):
        return False
    _cookie = {"name": record["name"], "value": record["value"]}
    try:
        response = session().get(f"{base_url}/api/auth/me", timeout=30)
    except requests.exceptions.RequestException:
        _cookie = None
        return False
    if response.status_code == 200:
        try:
            me = response.json()
        except ValueError:
            me = {}
        if me.get("email") == email:
            print(f"Signed in as {email} (cached session).")
            return True
    _cookie = None
    forget_session_cookie(base_url, email, cookie_file)
    return False


def ensure_session(base_url: str, email: str, cookie_file: Path) -> None:
    if restore_session(base_url, email, cookie_file):
        return
    login(base_url, email)
    save_session_cookie(base_url, email, cookie_file)

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
    """Run the email code flow and adopt the session cookie manually, so it
    works over http://localhost too (jars refuse Secure cookies on http)."""
    temp = requests.Session()
    response = temp.post(f"{base_url}/api/auth/request", json={"email": email}, timeout=30)
    if response.status_code != 200:
        print(f"Sign-in failed: {_auth_error(response)}")
        sys.exit(1)
    code = normalize_code(getpass.getpass("Sign-in code (check your email): "))
    response = temp.post(f"{base_url}/api/auth/verify", json={"email": email, "code": code}, timeout=30)
    if response.status_code != 200:
        print(f"Sign-in failed: {_auth_error(response)}")
        sys.exit(1)
    set_cookie = response.headers.get("Set-Cookie")
    if not set_cookie:
        print("Sign-in failed: verify response carried no session cookie.")
        sys.exit(1)
    _adopt_set_cookie(set_cookie)
    print(f"Signed in as {email}.")

def list_roms(base_url: str) -> dict:
    response = session().get(f"{base_url}/api/roms", timeout=30)
    response.raise_for_status()
    return response.json()


def _http_failure(action: str, exc: Exception) -> int:
    """One clean line instead of a raw traceback; distinguishes expired
    sessions from server errors."""
    if isinstance(exc, requests.exceptions.HTTPError):
        status = exc.response.status_code if exc.response is not None else "?"
        hint = " (session expired: delete the cookie file or re-run login)" if status == 401 else ""
        print(f"Error: {action} failed: HTTP {status}{hint}")
    else:
        print(f"Error: {action} failed: {type(exc).__name__}: {exc}")
    return 1


GB_LOGO_PREFIX = bytes.fromhex("ceed6666cc0d000b")
MIN_GB_ROM_SIZE = 0x8000
MAX_GB_ROM_SIZE = 8 * 1024 * 1024
GBA_HEADER_SIZE = 0xC0
GBA_LOGO_PREFIX = bytes.fromhex("24ffae51699aa221")


def classify_rom(data: bytes) -> str | None:
    """'gb'/'gbc' or 'gba' when the header evidence matches rom.ts; None when
    the file is not a ROM this emulator runs. The server counts any accepted
    body against the 100-game cap, so this check is what keeps .sav/.zip/
    image files out of the library."""
    if MIN_GB_ROM_SIZE <= len(data) <= MAX_GB_ROM_SIZE and data[0x104:0x104 + len(GB_LOGO_PREFIX)] == GB_LOGO_PREFIX:
        return "gbc" if data[0x143] in (0x80, 0xC0) else "gb"
    if (
        GBA_HEADER_SIZE <= len(data) <= MAX_ROM_BYTES
        and data[0x04:0x04 + len(GBA_LOGO_PREFIX)] == GBA_LOGO_PREFIX
        and data[0xB2] == 0x96
    ):
        return "gba"
    return None


def _ascii_field(raw: bytes) -> str:
    """Printable ASCII up to the first NUL, trimmed — rom.ts's asciiField."""
    text = raw.split(b"\x00", 1)[0]
    return bytes(c for c in text if 0x20 <= c <= 0x7E).decode("ascii").strip()


def cartridge_title(data: bytes) -> str:
    """Header title, mirroring src/client/emulator/rom.ts: GBA carts carry a
    12-byte title at 0xA0 (fixed 0x96 byte at 0xB2); Game Boy carts carry
    16 bytes at 0x134, shortened to 0x143 on CGB-era cartridges."""
    if MIN_GB_ROM_SIZE <= len(data) <= MAX_GB_ROM_SIZE and data[0x104:0x104 + len(GB_LOGO_PREFIX)] == GB_LOGO_PREFIX:
        end = 0x143 if data[0x143] in (0x80, 0xC0) else 0x144
        return _ascii_field(data[0x134:end])
    if (
        GBA_HEADER_SIZE <= len(data) <= MAX_ROM_BYTES
        and data[0x04:0x04 + len(GBA_LOGO_PREFIX)] == GBA_LOGO_PREFIX
        and data[0xB2] == 0x96
    ):
        return _ascii_field(data[0xA0:0xAC])
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


def upload_rom(base_url: str, path: Path, rom_hash: str, title: str, picked: bool = True) -> tuple[Path, str]:
    """Upload one ROM (hash computed once in the scan pass). Returns
    (path, outcome): 'uploaded', or an error reason. The file handle is
    reopened inside the retry loop so every attempt streams from offset 0."""
    query = urlencode({"name": path.name[:255], "title": title[:64], **({"picked": "1"} if picked else {})})
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
                return path, "uploaded"
            last_reason = f"HTTP {response.status_code}: {response.text[:200]}"
            if response.status_code in (409, 403):  # removed / library_full / sign-in required
                return path, last_reason
            if 400 <= response.status_code < 500 and response.status_code not in (408, 429):
                break  # permanent rejection — retrying cannot fix it
        except (requests.exceptions.RequestException, OSError) as exc:
            last_reason = f"{type(exc).__name__}: {exc}"
        if attempt < MAX_RETRIES:
            time.sleep(_backoff_seconds(attempt, response))
    return path, last_reason


def cmd_upload(base_url: str, directory: Path, concurrency: int) -> int:
    if not directory.is_dir():
        print(f"Error: directory '{directory}' does not exist.")
        return 2
    files = sorted(p for p in directory.iterdir() if p.is_file())
    if not files:
        print(f"No files found in '{directory}'.")
        return 2

    try:
        remote = list_roms(base_url)
    except requests.exceptions.RequestException as exc:
        return _http_failure("library listing", exc)
    already = {rom["romHash"] for rom in remote.get("roms", [])}
    removed = set(remote.get("removed", []))
    quota = MAX_CLOUD_ROMS - len(already)

    
    todo: list[tuple[Path, str, str]] = []
    duplicates = 0
    skipped: list[tuple[str, str]] = []
    for path in files:
        size = path.stat().st_size
        if size < MIN_ROM_BYTES:
            skipped.append((path.name, f"too_small ({size} B < {MIN_ROM_BYTES})"))
            continue
        if size > MAX_ROM_BYTES:
            skipped.append((path.name, f"too_large ({size} B > {MAX_ROM_BYTES})"))
            continue
        data = path.read_bytes()
        if classify_rom(data) is None:
            skipped.append((path.name, "not a GB/GBC/GBA ROM (no cartridge header)"))
            continue
        rom_hash = hashlib.sha256(data).hexdigest()
        if rom_hash in already:
            duplicates += 1
            continue
        if len(todo) >= quota:
            print(f"Account library full ({MAX_CLOUD_ROMS}); stopping after {len(todo)} files.")
            break
        todo.append((path, rom_hash, cartridge_title(data) or path.stem))

    print(f"{len(files)} files found, {duplicates} already in the account, {len(skipped)} skipped, {len(todo)} to upload.")
    if removed:
        print(f"{len(removed)} previously removed games: re-uploads use picked=1, so they go back in.")

    succeeded: list[str] = []
    failed: list[tuple[str, str]] = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(upload_rom, base_url, path, rom_hash, title): path for path, rom_hash, title in todo}
        with tqdm(total=len(todo), desc="ROM library", unit="rom") as bar:
            for future in as_completed(futures):
                path, outcome = future.result()
                if outcome == "uploaded":
                    succeeded.append(path.name)
                else:
                    failed.append((path.name, outcome))
                bar.update(1)
                bar.set_postfix(last=path.name[:24])

    print("\n--- Upload Summary ---")
    print(
        f"Total: {len(files)}  uploaded: {len(succeeded)}  duplicates: {duplicates}  "
        f"skipped: {len(skipped)}  failed: {len(failed)}"
    )
    for name, reason in skipped:
        print(f"  {'SKIPPED':>10}  {name}: {reason}")
    for name, reason in failed:
        print(f"  {'FAILED':>10}  {name}: {reason}")
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
    try:
        body = response.json()
    except ValueError:
        print(f"Error: unexpected response from /api/saves: {response.text[:200]}")
        return 1
    for save in body.get("saves", []):
        print(f"{save['gameId']:<20} rev {save['revision']:<4} {save['sramSize'] // 1024:>4} KiB  {save['romHash'][:16]}…")
    return 0


def main() -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-url", default=DEFAULT_BASE, help=f"deployment base URL (default: {DEFAULT_BASE})")
    common.add_argument(
        "--cookie-file",
        type=Path,
        default=DEFAULT_COOKIE_FILE,
        help=f"cached session cookie map (default: {DEFAULT_COOKIE_FILE})",
    )

    parser = argparse.ArgumentParser(description="pocket-cloud bulk ROM library uploader")
    sub = parser.add_subparsers(dest="command", required=True)

    p_login = sub.add_parser("login", parents=[common], help="sign in with an email code")
    p_login.add_argument("--email", required=True)

    p_list = sub.add_parser("list", parents=[common], help="list the account's cloud ROM library")
    p_list.add_argument("--email", required=True)

    p_upload = sub.add_parser("upload", parents=[common], help="upload every ROM in a directory")
    p_upload.add_argument("directory", type=Path)
    p_upload.add_argument("--email", required=True)
    p_upload.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)

    p_saves = sub.add_parser("saves", parents=[common], help="list saves for an anonymous player key")
    p_saves.add_argument("--player-key", required=True)

    args = parser.parse_args()
    args.base_url = args.base_url.rstrip("/")
    global _host
    _host = urlparse(args.base_url).hostname or ""
    if urlparse(args.base_url).scheme == "http" and _host not in ("localhost", "127.0.0.1", "::1"):
        print(f"Warning: {args.base_url} is plain http; the session cookie will travel unencrypted.")

    if args.command == "login":
        login(args.base_url, args.email)
        save_session_cookie(args.base_url, args.email, args.cookie_file)
        return 0
    if args.command == "list":
        ensure_session(args.base_url, args.email, args.cookie_file)
        try:
            roms = list_roms(args.base_url).get("roms", [])
        except requests.exceptions.RequestException as exc:
            return _http_failure("library listing", exc)
        for rom in roms:
            print(f"{rom['title']:<24} {rom['size'] // 1024:>6} KiB  {rom['romHash'][:16]}…")
        return 0
    if args.command == "upload":
        ensure_session(args.base_url, args.email, args.cookie_file)
        return cmd_upload(args.base_url, args.directory, max(1, args.concurrency))
    return cmd_saves(args.base_url, args.player_key)


if __name__ == "__main__":
    sys.exit(main())
