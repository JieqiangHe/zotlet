#!/bin/sh
cd "$(dirname "$0")"
echo "Starting zotlet…"
# Open browser after a short delay
(sleep 1.5 && (xdg-open "http://127.0.0.1:23121/" 2>/dev/null || open "http://127.0.0.1:23121/" 2>/dev/null || start "http://127.0.0.1:23121/" 2>/dev/null)) &
exec node zotlet.js web
