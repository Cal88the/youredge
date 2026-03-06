#!/bin/bash
# Launch Chrome with remote debugging enabled
# Log into HouseSigma in this browser window, then run the enrichment script

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="/tmp/chrome-enrichment-profile" \
  --no-first-run \
  --no-default-browser-check \
  "https://housesigma.com/login" &

echo ""
echo "Chrome launched with remote debugging on port 9222"
echo "1. Log into HouseSigma in the browser window"
echo "2. Then run: node enrich.js '305 Queen St E, Toronto ON'"
echo ""
