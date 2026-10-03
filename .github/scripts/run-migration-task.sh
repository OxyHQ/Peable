#!/usr/bin/env bash
#
# Run ONE migration phase as a one-shot ECS task and fail if it did not succeed.
#
# Usage: run-migration-task.sh <pre|post|all>
#
# In a script rather than inline YAML because the interesting part is the exit
# handling, and that is the part a reviewer must be able to read: an ECS task
# that fails is not an error from the AWS CLI's point of view — `run-task`
# returns 0 as soon as the task is ACCEPTED. A workflow that only checked the
# CLI's exit code would report a green deploy for a migration that threw, which
# is precisely the failure the phase split exists to prevent.
#
# Environment (set by the workflow):
#   CLUSTER, APP, PG_DATABASE     from the workflow's `env:` block
#   TASK_DEFINITION               the new digest-pinned candidate task definition ARN
#   CONTAINER_NAME                the container to override within it
#   NETWORK_CONFIGURATION         the service's awsvpc config, as compact JSON
set -euo pipefail

# Bound the complete CLI process as well as individual socket operations.
aws() {
  local deadline=60
  if [ "${1:-}" = ecs ] && [ "${2:-}" = wait ]; then
    deadline="${MIGRATION_WAIT_TIMEOUT_SECONDS:-660}"
    if ! [[ "$deadline" =~ ^[0-9]+$ ]] || [ "$deadline" -lt 1 ] || [ "$deadline" -gt 1800 ]; then
      echo '::error::migration wait deadline must be 1..1800 seconds' >&2
      return 1
    fi
  fi
  timeout "${deadline}s" "$(type -P aws)" "$@" --cli-connect-timeout 10 --cli-read-timeout 30
}
TASK_ARN=''
TASK_STOPPED=false
cleanup_task() {
  result=$?
  trap - EXIT
  if [ -n "$TASK_ARN" ] && [ "$TASK_ARN" != None ] && [ "$TASK_STOPPED" != true ]; then
    # Only the task ARN returned by this invocation is eligible. Validate its
    # definition and startedBy again before stopping it; never list/stop peers.
    details=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --include TAGS --output json) || exit 1
    if ! jq -e --arg arn "$TASK_ARN" --arg td "$TASK_DEFINITION" --arg owner "$MIGRATION_OWNER" --arg run "$RELEASE_RUN_ID" \
      '((.failures // []) | length) == 0 and (.tasks | length) == 1 and .tasks[0].taskArn == $arn and .tasks[0].taskDefinitionArn == $td and .tasks[0].startedBy == $owner and ((.tasks[0].tags | map({key:.key,value:.value}) | from_entries) as $tags | $tags.OxyOperation == "PeableMigration" and $tags.OxyTaskFamily == "oxy-peable" and $tags.OxyRunId == $run)' <<< "$details" >/dev/null; then
      echo '::error::migration cleanup ownership could not be verified'
      exit 1
    fi
    if [ "$(jq -r '.tasks[0].lastStatus' <<< "$details")" != STOPPED ]; then
      aws ecs stop-task --cluster "$CLUSTER" --task "$TASK_ARN" --reason 'Owned deployment migration exceeded its wait deadline' >/dev/null || exit 1
      aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" || exit 1
      state=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].lastStatus' --output text) || exit 1
      if [ "$state" != STOPPED ]; then
        echo '::error::owned migration task stop was not confirmed'
        exit 1
      fi
    fi
    echo 'Owned migration task cleanup confirmed STOPPED'
  fi
  exit "$result"
}
trap cleanup_task EXIT

# The three values `@oxy.so/db` accepts as a `run` (its MIGRATION_RUNS). `all` is
# the cutover escape hatch, not a normal release: it applies destructive
# migrations while the previous image is still serving, which is only safe when
# there is no previous image serving this schema.
PHASE="${1:?usage: run-migration-task.sh <pre|post|all>}"
case "$PHASE" in
  pre | post | all) ;;
  *)
    echo "::error::unknown migration phase '$PHASE' (expected pre, post or all)"
    exit 1
    ;;
esac

: "${CLUSTER:?CLUSTER is required}"
: "${APP:?APP is required}"
: "${PG_DATABASE:?PG_DATABASE is required}"
: "${TASK_DEFINITION:?TASK_DEFINITION is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${NETWORK_CONFIGURATION:?NETWORK_CONFIGURATION is required}"
: "${EXPECTED_IMAGE:?EXPECTED_IMAGE is required}"
: "${RELEASE_RUN_ID:?RELEASE_RUN_ID is required}"
if ! [[ "$RELEASE_RUN_ID" =~ ^[0-9]+-[0-9]+$ ]] || [ "${#RELEASE_RUN_ID}" -gt 64 ]; then
  echo '::error::release run identity must be a bounded numeric run-attempt pair'
  exit 1
fi
MIGRATION_OWNER="peable-${RELEASE_RUN_ID}-${PHASE}"
MIGRATION_TAGS=$(jq -nc --arg run "$RELEASE_RUN_ID" '[
  {key:"OxyOperation",value:"PeableMigration"},
  {key:"OxyTaskFamily",value:"oxy-peable"},
  {key:"OxyRunId",value:$run}
]')
[[ "$EXPECTED_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]]

# `bun` on the TypeScript SOURCE, not `node` on a compiled entrypoint. This
# image has no compiled JS at all — the Dockerfile's runtime stage copies
# `packages/backend/src/` and its CMD is `bun packages/backend/src/server.ts`,
# with `bun run build` used only as a type gate whose output is discarded. A
# `node dist/db/migrate.js` command here would fail with MODULE_NOT_FOUND.
#
# `--target-database` is the migrator's own guard: it refuses to run unless this
# name matches the database DATABASE_URL resolves to, so a task pointed at the
# wrong database fails instead of migrating it.
OVERRIDES=$(jq -nc \
  --arg name "$CONTAINER_NAME" \
  --arg db "$PG_DATABASE" \
  --arg phase "$PHASE" \
  '{containerOverrides: [{name: $name, command: [
      "bun", "packages/backend/src/db/migrate.ts",
      ("--target-database=" + $db),
      ("--phase=" + $phase)
  ]}]}')

echo "running $PHASE migration task on $CLUSTER using $TASK_DEFINITION"
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEFINITION" \
  --launch-type FARGATE \
  --count 1 \
  --network-configuration "$NETWORK_CONFIGURATION" \
  --overrides "$OVERRIDES" \
  --started-by "$MIGRATION_OWNER" \
  --tags "$MIGRATION_TAGS" \
  --query 'tasks[0].taskArn' --output text)

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "::error::the $PHASE migration task was not accepted by ECS"
  exit 1
fi
echo "task: $TASK_ARN"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
TASK_STOPPED=true

ACTUAL_DIGEST=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query "tasks[0].containers[?name=='$CONTAINER_NAME'].imageDigest | [0]" --output text)
if [ "$ACTUAL_DIGEST" != "${EXPECTED_IMAGE##*@}" ]; then
  echo "::error::migration task did not run the pinned candidate image"
  exit 1
fi

# Read the exit code of the container we overrode BY NAME. Indexing [0] would
# silently read a sidecar's status if one is ever added to the task definition.
EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query "tasks[0].containers[?name=='$CONTAINER_NAME'].exitCode | [0]" --output text)
STOP_REASON=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)

# A container that never started has NO exit code — `None`, not 0. Treating that
# as success is the single easiest way to ship an unmigrated database, so it is
# handled before the numeric comparison rather than falling into it.
if [ "$EXIT_CODE" = "None" ] || [ -z "$EXIT_CODE" ]; then
  echo "::error::the $PHASE migration container never ran (stoppedReason: $STOP_REASON)"
  exit 1
fi

if [ "$EXIT_CODE" != "0" ]; then
  echo "::error::the $PHASE migration failed with exit code $EXIT_CODE (stoppedReason: $STOP_REASON)"
  echo "::error::logs: /oxy/ecs, stream prefix $APP — the migrator prints what it applied and why it refused"
  exit 1
fi

echo "$PHASE migration completed"
