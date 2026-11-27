#!/bin/sh
# Writes version.js with the current time as YY.MM.DD.HH.MM (UTC).
# Run it right before committing a change, so the stamp shown next to the
# app name tells you which version a browser has loaded:
#   sh tools/stamp-version.sh && git add version.js
set -e
cd "$(dirname "$0")/.."
V=$(date -u +%y.%m.%d.%H.%M)
ISO=$(date -u +%Y-%m-%dT%H:%MZ)
cat > version.js <<JS
// Build stamp shown next to the app name, so you can tell which version a
// browser has loaded. Set by tools/stamp-version.sh before each commit;
// times are UTC.
export const VERSION = '$V';
export const BUILT_UTC = '$ISO';
JS
echo "version.js -> $V (UTC)"
