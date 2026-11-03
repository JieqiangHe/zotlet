#!/bin/bash
cd "$(dirname "$0")"
echo "Starting zotlet…"
(sleep 1.5 && open "http://127.0.0.1:23121/") &
exec node zotlet.js web
