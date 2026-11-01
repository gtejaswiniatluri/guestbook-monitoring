#!/usr/bin/env bash
set -euo pipefail

# Generates load against the Guestbook frontend (either port-forward or cluster service)
URL="${1:-http://localhost:8080}"
DURATION="${2:-120}"

echo "Starting traffic generation against $URL for ${DURATION}s..."
echo "Press Ctrl+C to stop early."

END=$((SECONDS + DURATION))
COUNT=0

while [ $SECONDS -lt $END ]; do
  curl -s "$URL/guestbook.php?cmd=set&key=messages&value=local-$COUNT,test-$((COUNT % 20))" > /dev/null || true
  curl -s "$URL/guestbook.php?cmd=get&key=messages" > /dev/null || true
  curl -s "$URL/" > /dev/null || true
  COUNT=$((COUNT + 1))
  if [ $((COUNT % 25)) -eq 0 ]; then
    echo "Sent $COUNT request cycles..."
  fi
  sleep 0.1
done

echo "Traffic generation finished ($COUNT cycles)."
