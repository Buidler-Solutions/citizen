#!/usr/bin/env bash

INPUT="$1"
OUTPUT="$2"
START="$3"   # start second (inclusive)
END="$4"     # end second (inclusive)

if [[ -z "$INPUT" || -z "$OUTPUT" || -z "$START" || -z "$END" ]]; then
  echo "Usage: ./trim-asciinema-range.sh input.cast output.cast start_seconds end_seconds"
  exit 1
fi

awk -v start="$START" -v end="$END" '
BEGIN { first=1 }
{
  # Print header line unchanged
  if ($0 ~ /^\{/) {
    print
    next
  }

  # Process event lines
  if ($0 ~ /^\[/) {
    split($0, a, ",")
    time = a[1]
    gsub(/\[/, "", time)

    if (time >= start && time <= end) {
      if (first) {
        offset = time
        first = 0
      }

      newtime = time - offset
      sub(/\[[^,]+/, "[" newtime)
      print
    }
  }
}
' "$INPUT" > "$OUTPUT"

echo "Trimmed recording saved to $OUTPUT"
