#!/usr/bin/env python3
"""Puts the mod packs (and the Everest download) into the site's cloud storage.

Run by .github/workflows/upload-mods.yml after every deploy. For each pack it
works out the full list of mods (the chosen ones + everything they depend on,
from the community mod database at maddie480.ovh), and only uploads when that
list changed since the last upload. Each pack is one tar archive cut into
1.4 MB pieces, the same way the site stores the game; the browser unpacks it
into Celeste/Mods.

Needs SITE_PASSWORD in the environment; MY_CELESTE_URL is optional.
"""
import base64
import concurrent.futures as cf
import hashlib
import json
import os
import re
import sys
import tarfile
import tempfile
import time
import urllib.request

import xxhash
import yaml
import zipfile

BASE = os.environ.get("MY_CELESTE_URL", "https://my-celeste.pages.dev").rstrip("/")
PIECE = 1_400_000
UA = "my-celeste-pack-uploader"

# which mods each link gets (dependencies are added automatically)
PACKS = {
    "mods-sj": ["StrawberryJam2021", "foxhair (Bangs Only)"],
    "mods-ds": ["Monika's D-Sides", "foxhair (Bangs Only)"],
}
NOT_MODS = {"Everest", "EverestCore", "Celeste"}

# music/sound mods: put LAST in each pack, after a tiny stand-in ("stub") of
# each. The no-sound links download only up to the real ones, so they get the
# stubs (which satisfy the other mods' dependency on them) and no music.
SOUND_MODS = {
    "StrawberryJam2021AudioA",
    "StrawberryJam2021AudioB",
    "StrawberryJam2021AudioC",
    "Monika's D-Sides Audio",
}
LAYOUT = 2  # bump when the pack's layout changes, so packs are rebuilt


def get(url, tries=5, timeout=300):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if attempt == tries - 1:
                raise
            print(f"  retry {url}: {e}")
            time.sleep(5 * (attempt + 1))


def api(path, method="GET", body=None, token=None, content_type="application/json", tries=5):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(BASE + "/api/" + path, method=method, data=body)
            req.add_header("User-Agent", UA)
            if token:
                req.add_header("Authorization", "Bearer " + token)
            if body is not None:
                req.add_header("Content-Type", content_type)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors="replace")
            if e.code in (400, 401, 404, 413) or attempt == tries - 1:
                raise SystemExit(f"{method} {path} failed: {e.code} {msg}")
            print(f"  retry {method} {path}: {e.code} {msg}")
        except Exception as e:  # noqa: BLE001
            if attempt == tries - 1:
                raise
            print(f"  retry {method} {path}: {e}")
        time.sleep(3 * (attempt + 1))


def closure(roots, updates, graph):
    seen, stack = {}, list(roots)
    while stack:
        name = stack.pop()
        if name in seen or name in NOT_MODS:
            continue
        if name not in updates:
            raise SystemExit(f"mod not found in the mod database: {name}")
        seen[name] = updates[name]
        for dep in (graph.get(name) or {}).get("Dependencies") or []:
            stack.append(dep["Name"])
    return dict(sorted(seen.items()))


def safe(name):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:80] + ".zip"


def download_mod(name, info, folder):
    path = os.path.join(folder, safe(name))
    want = (info.get("xxHash") or [None])[0]
    urls = [info["URL"]]
    if info.get("MirrorName"):
        urls.append(f"https://celestemodupdater.0x0a.de/banana-mirror/{info['MirrorName']}.zip")
    for url in urls:
        try:
            data = get(url)
        except Exception as e:  # noqa: BLE001
            print(f"  {name}: {url} failed ({e})")
            continue
        got = xxhash.xxh64(data).hexdigest()
        if want and got != want:
            print(f"  {name}: checksum mismatch from {url}")
            continue
        with open(path, "wb") as f:
            f.write(data)
        return path, len(data)
    raise SystemExit(f"could not download {name}")


def make_tar(files, tar_path, sound_from_index=None):
    """Writes the tar; returns the byte where entry `sound_from_index` starts."""
    sound_from = None
    with tarfile.open(tar_path, "w", format=tarfile.USTAR_FORMAT) as t:
        for i, (arc, src) in enumerate(files):
            if i == sound_from_index:
                sound_from = t.offset
            t.add(src, arcname=arc, recursive=False)
    return sound_from


def make_stub(name, version, folder):
    """A mod that only says its name and version: enough for dependencies."""
    path = os.path.join(folder, "stub-" + safe(name))
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("everest.yaml", f"- Name: {json.dumps(name)}\n  Version: {version}\n")
    return path


def upload(pack, tar_path, version, extra, token):
    size = os.path.getsize(tar_path)
    pieces = (size + PIECE - 1) // PIECE
    print(f"  uploading {pack}: {size / 1e6:.0f} MB in {pieces} pieces")
    api(f"pack/{pack}/start", "POST", b"{}", token)

    def send(i):
        with open(tar_path, "rb") as f:
            f.seek(i * PIECE)
            chunk = f.read(PIECE)
        api(f"pack/{pack}/piece/{version}/{i}", "PUT", base64.b64encode(chunk), token, "text/plain")
        return i

    done = 0
    with cf.ThreadPoolExecutor(4) as ex:
        for _ in ex.map(send, range(pieces)):
            done += 1
            if done % 50 == 0 or done == pieces:
                print(f"    {done}/{pieces}")
    info = {"version": version, "pieces": pieces, "size": size, **extra}
    api(f"pack/{pack}/commit", "POST", json.dumps(info).encode(), token)


def current(pack, token):
    raw = api(f"pack/{pack}/info", token=token)
    return json.loads(raw) if raw else None


def main():
    password = os.environ.get("SITE_PASSWORD")
    if not password:
        raise SystemExit("SITE_PASSWORD is missing")
    token = json.loads(api("login", "POST", json.dumps({"password": password}).encode()))["token"]
    work = tempfile.mkdtemp(prefix="packs-")

    # --- the Everest download (the browser patches it into the game once) ---
    updater = get("https://everestapi.github.io/everestupdater.txt").decode().strip()
    builds = json.loads(get(updater + "?supportsNativeBuilds=true"))
    build = [b for b in builds if b.get("branch") == "stable"][0]
    ev_version = "e" + hashlib.sha1(build["mainDownload"].encode()).hexdigest()[:12]
    have = current("everestzip", token)
    if have and have.get("version") == ev_version:
        print(f"everestzip: up to date ({build.get('version')})")
    else:
        print(f"everestzip: Everest {build.get('version')} from {build['mainDownload']}")
        z = os.path.join(work, "everest.zip")
        with open(z, "wb") as f:
            f.write(get(build["mainDownload"]))
        tar_path = os.path.join(work, "everestzip.tar")
        make_tar([("everest.zip", z)], tar_path)
        upload("everestzip", tar_path, ev_version, {"everest": build.get("version")}, token)

    # --- mod packs ---
    updates = yaml.safe_load(get("https://maddie480.ovh/celeste/everest_update.yaml"))
    graph = yaml.safe_load(get("https://maddie480.ovh/celeste/mod_dependency_graph.yaml"))
    for pack, roots in PACKS.items():
        mods = closure(roots, updates, graph)
        manifest = [[n, m.get("Version"), (m.get("xxHash") or [""])[0]] for n, m in mods.items()]
        version = "m" + hashlib.sha1(json.dumps([LAYOUT, manifest]).encode()).hexdigest()[:12]
        total = sum(m.get("Size") or 0 for m in mods.values())
        print(f"{pack}: {len(mods)} mods, {total / 1e6:.0f} MB")
        have = current(pack, token)
        if have and have.get("version") == version:
            print("  up to date")
            continue
        folder = os.path.join(work, pack)
        os.makedirs(folder, exist_ok=True)
        files, sound = [], []
        for name, info in mods.items():
            path, n = download_mod(name, info, folder)
            entry = (f"Celeste/Mods/{safe(name)}", path)
            (sound if name in SOUND_MODS else files).append(entry)
            print(f"  got {name} {info.get('Version')} ({n / 1e6:.1f} MB)")
        # stand-ins first, then the real sound mods (same file names: the full
        # links overwrite the stand-in with the real one)
        stubs = [
            (f"Celeste/Mods/{safe(name)}", make_stub(name, mods[name].get("Version"), folder))
            for name in sorted(mods) if name in SOUND_MODS
        ]
        ordered = files + stubs + sound
        tar_path = os.path.join(work, pack + ".tar")
        sound_from = make_tar(ordered, tar_path, len(files) + len(stubs) if sound else None)
        for _, p in ordered:
            os.remove(p)
        extra = {"mods": [[n, v] for n, v, _ in manifest]}
        if sound_from is not None:
            extra["soundFrom"] = sound_from
            print(f"  no-sound links stop at {sound_from / 1e6:.0f} MB")
        upload(pack, tar_path, version, extra, token)
        os.remove(tar_path)
    print("all packs online")


if __name__ == "__main__":
    sys.exit(main())
