#!/bin/sh
# Chrome ウェブストア提出用の zip を dist/ に作る
set -eu
cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="dist/webrtc-analyzer-$version.zip"
mkdir -p dist
rm -f "$out"
zip -r -X "$out" manifest.json LICENSE icons src -x '*.DS_Store'
echo "$out"
