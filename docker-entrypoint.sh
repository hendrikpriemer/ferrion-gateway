#!/bin/sh
set -e

# Runs as root (see Dockerfile - no USER directive, this script does the
# privilege drop itself) so it can fix up ownership of the *runtime*
# /app/data volume before anything touches it. A build-time `chown` in the
# Dockerfile only affects the image's own baked-in layer - it has no effect
# on a named volume that already existed (e.g. from an earlier root-run
# container) and is mounted over that layer at container start, so this has
# to happen here, on every start, not just once at build time.
chown -R ferrion:ferrion /app/data

exec su-exec ferrion "$@"
