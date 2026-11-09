#!/bin/sh
# Installs or reinstalls MoonerADE from the latest GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/Mooner510/mooner-ade/master/scripts/install-mac.sh | sh
# curl adds no quarantine flag, so Gatekeeper never blocks the ad-hoc signed app. After this the in-app updater takes over.
set -eu
[ "$(uname -s)" = Darwin ] || { echo "macOS 전용 설치 스크립트입니다." >&2; exit 1; }
# A Rosetta shell reports x86_64 on Apple Silicon, so ask the hardware instead of uname -m.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; else arch=x64; fi
dest=/Applications
[ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "MoonerADE ($arch) 다운로드 중..."
curl -fL --progress-bar -o "$tmp/app.zip" "https://github.com/Mooner510/mooner-ade/releases/latest/download/MoonerADE-darwin-$arch.zip" \
  || { echo "최신 릴리스에 MoonerADE-darwin-$arch.zip이 없습니다. Intel Mac은 README의 '소스에서 실행'을 따라 주세요." >&2; exit 1; }
/usr/bin/ditto -x -k "$tmp/app.zip" "$tmp/out"
osascript -e 'quit app "MoonerADE"' 2>/dev/null || true
rm -rf "$dest/MoonerADE.app"
mv "$tmp/out/MoonerADE.app" "$dest/"
/usr/bin/xattr -cr "$dest/MoonerADE.app" 2>/dev/null || true
echo "설치 완료: $dest/MoonerADE.app"
open "$dest/MoonerADE.app"
