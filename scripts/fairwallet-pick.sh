#!/usr/bin/env bash
# Take FAIRWallet commits into packages/frontend, across the Biome reformat.
#
#   scripts/fairwallet-pick.sh <upstream-commit>...
#
# A plain `git cherry-pick` of an upstream commit conflicts on nearly every
# hunk: upstream lives at the repository root and is double-quoted Prettier
# style, while packages/frontend here is Biome-formatted (single quotes, width
# 100, `import type`). So for each commit this:
#
#   1. takes the files it touches, before and after, from the fairwallet remote;
#   2. moves them under packages/frontend/ and runs `biome check --write` on
#      BOTH versions with this repo's biome.json (format + safe fixes, the same
#      pass this tree went through);
#   3. writes the two results as two throwaway commits on top of HEAD, the
#      second carrying the upstream author and message;
#   4. cherry-picks the second one.
#
# The merge in step 4 then sees only what upstream changed, in our style, and a
# conflict is a real divergence between Peable and upstream, not quoting.
#
# Upstream files with no counterpart here (its CI, bun.lock, files Peable
# deleted) are skipped and listed; take those by hand if they matter. Run it on
# a clean tree after `bun install`. On a conflict it stops like cherry-pick
# does: resolve, `git cherry-pick --continue`, then rerun with the rest.
set -euo pipefail

PREFIX=packages/frontend
UPSTREAM_URL=https://github.com/FairCoinOfficial/FAIRWallet.git

die() {
  echo "fairwallet-pick: $*" >&2
  exit 1
}

[ $# -ge 1 ] || die "usage: scripts/fairwallet-pick.sh <upstream-commit>..."
root=$(git rev-parse --show-toplevel)
cd "$root"
biome="$root/node_modules/.bin/biome"
[ -x "$biome" ] || die "Biome is not installed here; run bun install first"
git diff --quiet && git diff --cached --quiet || die "the working tree has changes; commit them first"
[ ! -e "$(git rev-parse --git-path CHERRY_PICK_HEAD)" ] || die "a cherry-pick is in progress"

git remote get-url fairwallet > /dev/null 2>&1 || git remote add fairwallet "$UPSTREAM_URL"
git fetch --quiet fairwallet

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Format one side: Peable's biome.json, no VCS (the scratch dir is not a repo).
# Twice, because some member chains only settle on the second pass.
format_side() {
  cp "$root/biome.json" "$1/biome.json"
  for _ in 1 2; do
    (cd "$1" && "$biome" check --write --vcs-enabled=false . > "$1.log" 2>&1) || true
  done
  if ! (cd "$1" && "$biome" format --vcs-enabled=false . > /dev/null 2>&1); then
    echo "  warning: Biome could not format every file (see below); expect conflicts there" >&2
    grep -E '^\S+\.(ts|tsx|js|jsx|mjs|cjs|json|css)' "$1.log" | head -5 >&2 || true
  fi
}

# Stage one side's content for every picked path into the temp index.
stage_side() { # <dir> <commit>
  local p mode blob
  for p in "${picked[@]}"; do
    if [ -f "$1/$PREFIX/$p" ]; then
      mode=$(git ls-tree "$2" -- "$p" | awk '{print $1}')
      blob=$(git hash-object -w "$1/$PREFIX/$p")
      git update-index --add --cacheinfo "$mode,$blob,$PREFIX/$p"
    else
      git update-index --force-remove -- "$PREFIX/$p"
    fi
  done
}

for ref in "$@"; do
  commit=$(git rev-parse --verify --quiet "$ref^{commit}") || die "unknown commit: $ref"
  [ "$(git rev-list --parents -n 1 "$commit" | wc -w)" -eq 2 ] || die "$ref is a merge or a root commit"
  parent=$(git rev-parse "$commit^")
  subject=$(git log -1 --format=%s "$commit")
  echo "== ${commit:0:7} $subject"

  rm -rf "${work:?}"/*
  mkdir -p "$work/a" "$work/b"
  picked=()
  skipped=()
  while IFS=$'\t' read -r status path; do
    if [ "$status" != A ] && ! git cat-file -e "HEAD:$PREFIX/$path" 2> /dev/null; then
      skipped+=("$path")
      continue
    fi
    picked+=("$path")
    for side in a:"$parent" b:"$commit"; do
      if git cat-file -e "${side#*:}:$path" 2> /dev/null; then
        mkdir -p "$(dirname "$work/${side%%:*}/$PREFIX/$path")"
        git show "${side#*:}:$path" > "$work/${side%%:*}/$PREFIX/$path"
      fi
    done
  done < <(git diff-tree --no-commit-id -r --no-renames --name-status "$parent" "$commit")

  for p in "${skipped[@]}"; do echo "  skipped (no $PREFIX/$p here): $p"; done
  if [ ${#picked[@]} -eq 0 ]; then
    echo "  nothing to take"
    continue
  fi

  format_side "$work/a"
  format_side "$work/b"

  export GIT_INDEX_FILE="$work/index"
  git read-tree HEAD
  stage_side "$work/a" "$parent"
  base_tree=$(git write-tree)
  stage_side "$work/b" "$commit"
  pick_tree=$(git write-tree)
  unset GIT_INDEX_FILE

  if [ "$base_tree" = "$pick_tree" ]; then
    echo "  nothing left once formatted (a formatting-only change upstream)"
    continue
  fi
  base=$(git commit-tree "$base_tree" -p HEAD -m "fairwallet-pick: formatted parent of $commit")
  {
    git log -1 --format=%B "$commit" | git stripspace
    printf '\nUpstream: FairCoinOfficial/FAIRWallet@%s, taken with scripts/fairwallet-pick.sh\n' "$commit"
  } > "$work/message"
  pick=$(
    GIT_AUTHOR_NAME=$(git log -1 --format=%an "$commit") \
      GIT_AUTHOR_EMAIL=$(git log -1 --format=%ae "$commit") \
      GIT_AUTHOR_DATE=$(git log -1 --format=%aI "$commit") \
      git commit-tree "$pick_tree" -p "$base" -F "$work/message"
  )

  before=$(git rev-parse HEAD)
  if ! git cherry-pick --empty=drop "$pick"; then
    echo "fairwallet-pick: ${commit:0:7} conflicts. Resolve, run 'git cherry-pick --continue'," >&2
    echo "then rerun with the commits after it." >&2
    exit 1
  fi

  if [ "$(git rev-parse HEAD)" = "$before" ]; then
    echo "  already here: the change is in HEAD, nothing committed"
    continue
  fi

  # A clean merge of two formatted sides can still leave an unformatted line
  # (two edits meeting in one import list). Fold the fix into the same commit.
  mapfile -t present < <(cd "$root" && for p in "${picked[@]}"; do [ -f "$PREFIX/$p" ] && echo "$PREFIX/$p"; done)
  if [ ${#present[@]} -gt 0 ]; then
    "$biome" check --write --no-errors-on-unmatched "${present[@]}" > /dev/null 2>&1 || true
    if ! git diff --quiet; then
      git commit --quiet --amend --no-edit --all
      echo "  formatted the merged result"
    fi
  fi
done
