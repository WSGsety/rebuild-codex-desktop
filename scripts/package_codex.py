#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path


REPO_API = "https://api.github.com/repos/openai/codex/releases/latest"
ARCH_TAGS = {
    "amd64": "win_amd64",
    "arm64": "win_arm64",
}


def urlopen(url):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "rebuild-codex-desktop"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers))


def fetch_latest_release():
    with urlopen(REPO_API) as response:
        return json.load(response)


def select_wheel(release, arch):
    marker = ARCH_TAGS[arch]
    for asset in release["assets"]:
        name = asset["name"]
        if name.startswith("openai_codex_cli_bin-") and name.endswith(f"-{marker}.whl"):
            return asset
    raise RuntimeError(f"没有找到 Windows {arch} wheel")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, path):
    with urlopen(url) as response, path.open("wb") as file:
        shutil.copyfileobj(response, file)


def version_from_asset(name):
    prefix = "openai_codex_cli_bin-"
    suffix = "-py3-none-"
    if not name.startswith(prefix) or suffix not in name:
        raise RuntimeError(f"无法从资产名解析版本: {name}")
    return name[len(prefix):name.index(suffix)]


def extract_portable(wheel, work_dir, version, arch):
    package_dir = work_dir / f"codex-portable-windows-{arch}-{version}"
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        prefix = "codex_cli_bin/"
        needed = [name for name in names if name.startswith(prefix) and not name.endswith("/")]
        if "codex_cli_bin/bin/codex.exe" not in names:
            raise RuntimeError("wheel 里没有 codex_cli_bin/bin/codex.exe")
        for name in needed:
            target = package_dir / name[len(prefix):]
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(name) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)

    (package_dir / "run-codex.cmd").write_text("@echo off\r\n\"%~dp0bin\\codex.exe\" %*\r\n", encoding="utf-8")
    (package_dir / "VERSION.txt").write_text(f"{version}\n", encoding="utf-8")
    (package_dir / "README.txt").write_text(
        "Codex portable package for Windows.\r\n"
        "Run bin\\codex.exe or run-codex.cmd.\r\n"
        "This package is rebuilt from the official openai/codex release wheel.\r\n",
        encoding="utf-8",
    )
    return package_dir


def make_zip(package_dir, output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    zip_path = output_dir / f"{package_dir.name}.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(package_dir.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(package_dir.parent))
    digest = sha256(zip_path)
    sha_path = zip_path.with_suffix(zip_path.suffix + ".sha256")
    sha_path.write_text(f"{digest}  {zip_path.name}\n", encoding="utf-8")
    return zip_path, sha_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arch", choices=sorted(ARCH_TAGS), default="amd64")
    parser.add_argument("--output", type=Path, default=Path("dist"))
    parser.add_argument("--keep-work", action="store_true")
    args = parser.parse_args()

    release = fetch_latest_release()
    asset = select_wheel(release, args.arch)
    version = version_from_asset(asset["name"])
    expected_digest = asset.get("digest", "").removeprefix("sha256:")

    with tempfile.TemporaryDirectory() as temp:
        temp_dir = Path(temp)
        wheel = temp_dir / asset["name"]
        download(asset["browser_download_url"], wheel)

        actual_digest = sha256(wheel)
        if expected_digest and actual_digest != expected_digest:
            raise RuntimeError(f"sha256 校验失败: {actual_digest} != {expected_digest}")

        package_dir = extract_portable(wheel, temp_dir, version, args.arch)
        zip_path, sha_path = make_zip(package_dir, args.output)

        if args.keep_work:
            kept = args.output / package_dir.name
            if kept.exists():
                shutil.rmtree(kept)
            shutil.copytree(package_dir, kept)

    print(f"version={version}")
    print(f"upstream_tag={release['tag_name']}")
    print(f"artifact={zip_path}")
    print(f"checksum={sha_path}")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as file:
            file.write(f"version={version}\n")
            file.write(f"upstream_tag={release['tag_name']}\n")
            file.write(f"artifact={zip_path}\n")
            file.write(f"checksum={sha_path}\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)

