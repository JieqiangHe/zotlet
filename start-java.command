#!/bin/bash
# macOS: double-click this file in Finder to start zotlet with Java (no Node needed).
# The Terminal window shows the server output; it stays open after zotlet stops.
exec /bin/bash "$(dirname "$0")/start-java.sh" "$@"
