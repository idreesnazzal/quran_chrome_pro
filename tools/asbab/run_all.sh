#!/usr/bin/env bash
# Rebuild the sabab an-nuzul data end to end — tools/asbab/run_all.sh
#   ./run_all.sh          pipeline + repo unit tests
#   ./run_all.sh --ui     also run the headless browser test (needs a server on :8000)
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/4 download: verify raw + generated files against MANIFEST.sha256"
python3 download.py --check

echo "== 2/4 align: match every entry to a real ayah of data/quran_data.js"
python3 align.py | grep -E '^align' || true

echo "== 3/4 check: the six rules on the summaries and grades"
python3 check.py

echo "== 4/4 merge: data/asbab_data.js (+ sw.js VERSION bump, atomic replace)"
python3 merge.py

echo "== repo unit tests"
node ../../tests/run_tests.js | tail -3

if [[ "${1:-}" == "--ui" ]]; then
  echo "== headless browser test (desktop + 375px, dark + light)"
  node ui_test.js
fi

echo "asbab: pipeline green"
