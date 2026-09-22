#!/usr/bin/env bash
# Runs one command and records it as evidence without echoing environment values.
# Usage: capture.sh DIR NAME -- COMMAND [ARGS...]
# Writes DIR/NAME.cmd, DIR/NAME.stdout, DIR/NAME.stderr, and DIR/NAME.exit, then prints a one-line summary.
# The command's exit code is recorded, and capture.sh itself exits 0 so expected failures can be captured.
set -u
if [ "$#" -lt 4 ] || [ "$3" != "--" ]; then
  echo "Usage: capture.sh DIR NAME -- COMMAND [ARGS...]" >&2
  exit 2
fi
dir=$1 name=$2
shift 3
mkdir -p "$dir"
printf '%q ' "$@" > "$dir/$name.cmd"
printf '\n' >> "$dir/$name.cmd"
"$@" > "$dir/$name.stdout" 2> "$dir/$name.stderr"
code=$?
printf '%s\n' "$code" > "$dir/$name.exit"
printf '%s exit=%s stdout=%sB stderr=%sB\n' "$name" "$code" "$(wc -c < "$dir/$name.stdout")" "$(wc -c < "$dir/$name.stderr")"
