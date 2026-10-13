#!/bin/bash
# Copyright 2026 Mike Simone
# SPDX-License-Identifier: AGPL-3.0-only

# Starts the virtual display, Signal and the Backchannel helper. If any of
# them exits, the container exits and Docker restarts it.
#
# BACKCHANNEL_ORIGIN: the HTTPS address the page is opened at
#   (e.g. https://chat.example.net)
# SIGNAL_EXTRA_ARGS: extra Signal command-line flags, if ever needed

set -euo pipefail

USER_DATA="$HOME/.config/Signal"
# The helper's token and key moved from signal-rambox (before the rename to
# Backchannel); keeping them keeps the page address and Signal's approval.
if [ -d "$HOME/signal-rambox" ] && [ ! -e "$HOME/backchannel" ]; then
  mv "$HOME/signal-rambox" "$HOME/backchannel"
fi
mkdir -p "$USER_DATA" "$HOME/backchannel"
ORIGIN="${BACKCHANNEL_ORIGIN:-${RAMBOX_ORIGIN:-}}"

# A stale lock from an unclean stop would keep Xvfb from starting.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &

for _ in $(seq 50); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done

# --password-store=basic: no desktop keyring in here; the database key is
# kept in the profile, which only this container's volume holds.
# --no-sandbox: Mike's choice (2026-10-10). Chromium's sandbox can't create
# its namespaces under Docker's default seccomp profile and capabilities.
/opt/Signal/signal-desktop --password-store=basic --no-sandbox \
  ${SIGNAL_EXTRA_ARGS:-} &

helper_args=(--user-data "$USER_DATA" --config "$HOME/backchannel"
  --bind 0.0.0.0 --port 8083)
if [ -n "$ORIGIN" ]; then
  helper_args+=(--origin "$ORIGIN")
fi
node /opt/backchannel/backchannel.mjs "${helper_args[@]}" &

wait -n
exit 1
