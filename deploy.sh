#!/bin/sh
# Redeploy the agent wallet on Coolify and report what came back up.
#
# The image itself is built by GitHub Actions; this only tells Coolify to pull
# the new one. Never point this at a Dockerfile that compiles — see README.
#
# This used to declare success as soon as $BARKD_URL/ping answered, which it
# always did: Coolify starts the replacement container only after the deploy job
# has run, so the pong came from the *old* container, minutes before the new one
# existed. A deploy that had not happened yet read as finished.
#
# So it now follows the deployment itself, and only then asks the wallet whether
# maintenance has actually run — /health reports the keeper's last success, so a
# true answer there means the new process is up and its first pass completed.
#
# Needs $COOLIFY_URL and $COOLIFY_TOKEN in the environment.
set -e
APP_UUID=qumjaakttw4qav9pmeupgksu
BARKD_URL=${BARKD_URL:-https://pay.gaboe.xyz}

[ -n "$COOLIFY_TOKEN" ] || { echo "COOLIFY_TOKEN not set"; exit 1; }
[ -n "$COOLIFY_URL" ] || { echo "COOLIFY_URL not set"; exit 1; }

api() { curl -sS --max-time 60 -H "Authorization: Bearer $COOLIFY_TOKEN" "$@"; }

echo "triggering deploy..."
deployment=$(api -X POST "$COOLIFY_URL/api/v1/deploy?uuid=$APP_UUID" | python3 -c '
import json, sys
body = json.load(sys.stdin)
deployments = body.get("deployments") or []
if not deployments:
    raise SystemExit(f"coolify did not queue a deployment: {json.dumps(body)[:200]}")
print(deployments[0]["deployment_uuid"])
')
echo "deployment $deployment"

# Poll the deployment, not the wallet. `queued` and `in_progress` are the states
# it passes through; anything else is terminal.
i=0
while [ $i -lt 120 ]; do
    status=$(api "$COOLIFY_URL/api/v1/deployments/$deployment" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status","?"))')
    case "$status" in
        finished) echo "deployment finished"; break ;;
        failed|cancelled)
            echo "deployment $status" >&2
            echo "the API serves no logs for a failed deployment; the exception is in" >&2
            echo "coolify's own database — see the README." >&2
            exit 1 ;;
    esac
    i=$((i + 1))
    sleep 10
done
if [ "$status" != "finished" ]; then
    echo "deployment still $status after 20 minutes" >&2
    exit 1
fi

# The keeper's first pass is scheduled 30s after boot, so a fresh container
# answers `"ok":false` until then. Waiting for true is what distinguishes the new
# process from the old one still serving.
echo "waiting for the keeper's first pass on $BARKD_URL/health ..."
i=0
while [ $i -lt 30 ]; do
    health=$(curl -s --max-time 10 "$BARKD_URL/health" 2>/dev/null || true)
    case "$health" in
        *'"ok":true'*) echo "$health"; exit 0 ;;
    esac
    i=$((i + 1))
    sleep 10
done

echo "the wallet is answering but maintenance has not succeeded within 5 minutes:" >&2
echo "${health:-no answer at all}" >&2
echo "the container may be up with a keeper that cannot reach barkd or esplora." >&2
exit 1
