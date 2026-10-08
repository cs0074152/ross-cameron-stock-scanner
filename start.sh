#!/usr/bin/env bash
set -eu
SCRIPT_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_ROOT"
exec node "$SCRIPT_ROOT/scripts/launch.cjs"
