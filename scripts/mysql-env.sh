# TCMS env + MySQL wiring — SINGLE SOURCE OF TRUTH (sourced, never executed).
# Used by scripts/start-tcms.sh, scripts/boot-tcms-autostart.sh and the
# backup/restore scripts so every consumer parses .env the SAME safe way.
#
# WHY NOT `source .env`: MySQL URLs contain '&'. In an unquoted value bash
# parses `KEY=...&rest` as (background assignment) + command `rest` — the
# variable is set in a dead subshell and a stale exported value silently
# wins. load_env_file parses KEY=VALUE lines directly with NO shell
# interpretation, strips optional quotes, and NEVER clobbers a variable the
# caller already exported (explicit environment always beats .env).

load_env_file() { # load_env_file <file> — safe .env loader
  local file=$1
  [ -f "$file" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue # no '=' — not an assignment
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    if [ -z "${!key+x}" ]; then export "$key=$val"; fi
  done < "$file"
}

# Load .env (gap-filling: caller-exported variables always win).
load_env_file .env

# DB wiring: keep a caller-provided mysql:// URL; else whatever .env held
# (already loaded above); else the sandbox MySQL TEST schema. Anything
# non-mysql (e.g. a stale sqlite file: URL from the platform shell) is
# discarded — the app is MySQL-ONLY.
case "${DATABASE_URL:-}" in
  mysql://*) : ;;
  *) export DATABASE_URL="mysql://tcms_app:ChangeMe_local_only@127.0.0.1:5500/tcms_test?connection_limit=40&pool_timeout=10" ;;
esac
export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"
