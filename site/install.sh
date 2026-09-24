#!/usr/bin/env bash
# Install or update Foreman without changing the current project.
set -euo pipefail

fail() { printf 'Foreman: %s\n' "$*" >&2; exit 1; }
for tool in node npm git; do
  command -v "$tool" >/dev/null 2>&1 || fail "Install $tool first, then rerun this command."
done
command -v opencode >/dev/null 2>&1 || fail 'Install OpenCode first, then rerun this command.'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 13) || major >= 24 ? 0 : 1)' \
  || fail 'Node.js 22.13+ on 22.x or 24+ is required.'

install_dir="${FOREMAN_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode-foreman}"
case "$install_dir" in
  /*) ;;
  *) fail 'FOREMAN_INSTALL_DIR must be an absolute path.' ;;
esac
# Strip trailing slashes so the lock and replacement refer to the same directory.
while [[ "$install_dir" == */ && "$install_dir" != / ]]; do install_dir="${install_dir%/}"; done
[[ "$install_dir" != / ]] || fail 'Cannot install into the filesystem root.'
[[ ! -L "$install_dir" ]] || fail 'The installation directory must not be a symlink.'
if [[ -e "$install_dir" ]]; then
  [[ -d "$install_dir" && -f "$install_dir/.foreman-managed-install" ]] \
    || fail "Refusing to replace an unmanaged directory: $install_dir"
fi
mkdir -p "$(dirname "$install_dir")"
lock_dir="${install_dir}.install-lock"
mkdir "$lock_dir" 2>/dev/null || fail "Another installation may be running (lock: $lock_dir)."
work_dir=''
replacing=0
cleanup() {
  result=$?
  trap - EXIT
  if [[ "$replacing" == 1 && "$result" != 0 ]]; then
    rm -rf -- "$install_dir"
    if [[ -d "$work_dir/previous" ]]; then mv -- "$work_dir/previous" "$install_dir"; fi
    printf 'Foreman: installation failed; restored the previous installation if present.\n' >&2
  fi
  if [[ -n "$work_dir" ]]; then rm -rf -- "$work_dir"; fi
  rmdir "$lock_dir"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
work_dir=$(mktemp -d "${install_dir}.install.XXXXXX")
printf 'Downloading Foreman…\n'
git clone --quiet --depth 1 --branch main https://github.com/Harrison97/opencode-foreman.git "$work_dir/new"
(
  cd "$work_dir/new"
  npm ci --no-audit --no-fund
  npm run build
)
printf 'Managed by Foreman install.sh. Rerunning the installer replaces this directory.\n' > "$work_dir/new/.foreman-managed-install"
if [[ -d "$install_dir" ]]; then mv -- "$install_dir" "$work_dir/previous"; fi
replacing=1
mv -- "$work_dir/new" "$install_dir"
node "$install_dir/scripts/install.mjs"
replacing=0
printf '\nForeman installed in %s\n' "$install_dir"
printf 'Set TYPESAFE_API_KEY in the environment that starts OpenCode, then restart OpenCode.\n'
printf 'Run this same install command again to update. Keep custom workflows in your projects.\n'
