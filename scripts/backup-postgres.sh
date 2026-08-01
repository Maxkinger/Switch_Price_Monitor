#!/usr/bin/env bash

# 此 NAS 运维入口只备份显式指定 Compose 项目的 PostgreSQL 17 服务；所有目标必须由调用方传入，
# 不能从当前目录、Docker 默认 project、$HOME 或环境秘密推断生产库，避免误操作其他项目。
set -Eeuo pipefail
umask 077

usage() {
  # 固定用法不回显任何环境变量；数据库和应用密码始终只在 postgres 容器环境内被 pg_dump 读取。
  printf '%s\n' 'usage: backup-postgres.sh --compose-file ABSOLUTE --env-file ABSOLUTE --project-name NAME --database-service NAME --database NAME --project-root ABSOLUTE --backup-dir ABSOLUTE --retention POSITIVE_INTEGER' >&2
}

die() {
  # 错误分类仅包含固定文字，防止 Docker、shell 或 SQL 错误把连接 URL/密码带到运维终端。
  printf '%s\n' "$1" >&2
  exit 1
}

require_value() {
  [[ $# -eq 2 && -n "$2" ]] || { usage; die '参数缺少值'; }
}

canonical_existing_path() {
  # macOS BSD realpath 不支持 GNU 的 -e，但两端对“既有路径直接 canonicalize”语义一致；输入已限定为绝对路径，
  # 因此不传额外选项既能拒绝不存在对象，又不会把 NAS 备份边界降级为未解析字符串。
  [[ -e "$1" ]] || return 1
  realpath -- "$1"
}

increment_sequence() {
  # Bash 整数会在 18 位序列溢出；逐字符进位只计算 0..10，保证 NAS/M1 上完整 18 位排序不会回绕。
  local digits="$1" index digit value carry=1 result=''
  for ((index = ${#digits} - 1; index >= 0; index -= 1)); do
    digit="${digits:index:1}"
    value=$((10#$digit + carry))
    if (( value == 10 )); then result="0$result"; carry=1; else result="$value$result"; carry=0; fi
  done
  (( carry == 0 )) || die '备份 sequence 已达到上限'
  printf '%s\n' "$result"
}

compose_file=''
env_file=''
project_name=''
database_service=''
database_name=''
project_root=''
backup_dir=''
retention=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file|--env-file|--project-name|--database-service|--database|--project-root|--backup-dir|--retention)
      require_value "$1" "${2-}"
      case "$1" in
        --compose-file) compose_file="$2" ;;
        --env-file) env_file="$2" ;;
        --project-name) project_name="$2" ;;
        --database-service) database_service="$2" ;;
        --database) database_name="$2" ;;
        --project-root) project_root="$2" ;;
        --backup-dir) backup_dir="$2" ;;
        --retention) retention="$2" ;;
      esac
      shift 2
      ;;
    *) usage; die '参数不受支持' ;;
  esac
done

# 所有路径先要求绝对形式再 canonicalize 既有对象；符号链接、.. 和相对路径都不能绕过项目目录边界。
[[ "$compose_file" == /* && "$env_file" == /* && "$project_root" == /* && "$backup_dir" == /* ]] || die '路径必须为绝对路径'
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die 'Compose project 名不合法'
[[ "$database_service" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$ ]] || die '数据库服务名不合法'
[[ "$database_name" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die '数据库名不合法'
[[ "$retention" =~ ^[1-9][0-9]*$ && ( ${#retention} -lt 5 || ( ${#retention} -eq 5 && "$retention" < 10001 ) ) ]] || die '保留份数必须为 1..10000'

compose_file="$(canonical_existing_path "$compose_file")" || die 'Compose 文件不存在'
env_file="$(canonical_existing_path "$env_file")" || die 'Compose env 文件不存在'
project_root="$(canonical_existing_path "$project_root")" || die '项目根目录不存在'
backup_dir="$(canonical_existing_path "$backup_dir")" || die '备份目录不存在'
[[ -f "$compose_file" && -f "$env_file" && -d "$project_root" && -d "$backup_dir" ]] || die '路径类型不符合要求'
[[ "$project_root" != / && "$backup_dir" != / && "$backup_dir" != "$project_root" && "$backup_dir" == "$project_root"/* ]] || die '备份目录必须是项目根目录的严格子目录'

# 所有 Compose 子命令都显式携带同一绝对 env 文件；DSM 计划任务无论从哪个 cwd 启动都不能退回自动发现 `.env`。
# 函数只转发固定前缀和本脚本已校验的参数，不打印展开后的数据库或 Telegram 秘密。
compose() { docker compose --env-file "$env_file" -f "$compose_file" -p "$project_name" "$@"; }

# 先让 Compose 解析显式文件、env 和 project；失败时还没有创建临时归档或改动任何旧备份。
compose config -q >/dev/null 2>&1 || die 'Compose 配置无效'

# mkdir 是同一文件系统上的原子互斥原语；同一数据库的两个备份绝不能并发计算相同 sequence 或交叉删除归档。
lock_directory="$backup_dir/.switch-price-monitor-backup-$database_name.lock"
mkdir -- "$lock_directory" 2>/dev/null || die '同一数据库备份锁已被占用'
temporary_file=''
error_file=''
final_file=''
cleanup() {
  # 仅删除 mktemp 返回的精确临时文件；绝不递归删除、展开通配符或触碰备份目录外对象。
  if [[ -n "$temporary_file" && -e "$temporary_file" ]]; then rm -f -- "$temporary_file"; fi
  if [[ -n "$error_file" && -e "$error_file" ]]; then rm -f -- "$error_file"; fi
  # 锁目录由本进程成功 mkdir 且始终为空；只 rmdir 该精确路径，不递归删除任何管理员文件。
  if [[ -n "${lock_directory-}" && -d "$lock_directory" ]]; then rmdir -- "$lock_directory"; fi
}
trap cleanup EXIT
# 锁一旦取得立刻注册 trap；即使第一个 mktemp 失败也会释放本进程创建的精确空目录，不能造成永久拒绝服务。
temporary_file="$(mktemp "$backup_dir/.switch-price-monitor-backup.XXXXXXXX")" || die '无法创建受限权限临时备份'
error_file="$(mktemp "$backup_dir/.switch-price-monitor-backup-error.XXXXXXXX")" || die '无法创建受限权限错误文件'

# 归档字节经 stdout 直接流到同目录临时文件；pg_dump 与服务器同在 postgres:17 容器，主机无需安装客户端。
# PGPASSWORD 只在容器内 pg_dump 子进程环境存在，不作为 host 参数、日志或归档内容的一部分。
if ! compose exec -T "$database_service" sh -ceu '
  exec env PGPASSWORD="$APP_DATABASE_PASSWORD" pg_dump \
    --format=custom --compress=9 --no-owner --no-acl \
    --host="$1" --username="$APP_DATABASE_USER" --dbname="$2"
' sh "$database_service" "$database_name" >"$temporary_file" 2>"$error_file"; then
  die '备份失败，旧备份保持不变'
fi

# 在同一 PostgreSQL 17 容器内验证 custom archive；远端临时文件由 trap 精确清理，避免把未验证字节改名为成功备份。
if ! cat -- "$temporary_file" | compose exec -T "$database_service" sh -ceu '
  archive="$(mktemp /tmp/switch-price-monitor-backup.XXXXXXXX)"
  trap "rm -f -- \"$archive\"" EXIT
  cat >"$archive"
  pg_restore --list "$archive" >/dev/null
' 2>"$error_file"; then
  die '备份归档校验失败，旧备份保持不变'
fi

# 名称包含安全数据库标识、18 位单调 sequence 和 UTC 展示时刻；库名可让多库 NAS 的保留策略互不误删，
# 同时只在同一已验证目录内 rename，因此成功文件不会暴露部分写入。
# 在锁内从受控归档取得最大 18 位 sequence；UTC 仅供人工阅读，保留顺序永远不依赖可被 touch 改写的 mtime。
max_sequence=000000000000000000
while IFS= read -r candidate; do
  candidate_name="${candidate##*/}"
  if [[ "$candidate_name" =~ ^switch-price-monitor-$database_name-([0-9]{18})-[0-9]{8}T[0-9]{6}Z\.dump$ ]] && [[ "${BASH_REMATCH[1]}" > "$max_sequence" ]]; then max_sequence="${BASH_REMATCH[1]}"; fi
done < <(find "$backup_dir" -maxdepth 1 -type f -name "switch-price-monitor-$database_name-*.dump" -print)
next_sequence="$(increment_sequence "$max_sequence")"
final_file="$backup_dir/switch-price-monitor-$database_name-$next_sequence-$(date -u +%Y%m%dT%H%M%SZ).dump"
[[ ! -e "$final_file" ]] || die '备份文件名冲突'
mv -- "$temporary_file" "$final_file"
temporary_file=''

# 只枚举符合本脚本固定契约且 canonical parent 仍为备份目录的普通文件；保留排序使用成功 sequence，
# 不用 shell glob 或递归删除，因此管理员放入的其他文件和路径技巧都不会被清理。
files=()
sequences=()
while IFS= read -r -d '' candidate; do
  name="${candidate##*/}"
  [[ "$name" =~ ^switch-price-monitor-$database_name-([0-9]{18})-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || continue
  resolved="$(canonical_existing_path "$candidate")" || continue
  [[ "$(dirname -- "$resolved")" == "$backup_dir" && -f "$resolved" ]] || continue
  files+=("$resolved")
  sequences+=("${BASH_REMATCH[1]}")
done < <(find "$backup_dir" -maxdepth 1 -type f -name "switch-price-monitor-$database_name-*.dump" -print0)

# 18 位 sequence 固定等宽，纯字符串降序就是数值成功顺序；绝不使用 Bash 算术，前导零不能被误作八进制。
for ((left = 0; left < ${#files[@]}; left += 1)); do
  newest="$left"
  for ((right = left + 1; right < ${#files[@]}; right += 1)); do
    if [[ "${sequences[right]}" > "${sequences[newest]}" ]]; then newest="$right"; fi
  done
  if (( newest != left )); then
    swap_file="${files[left]}"; files[left]="${files[newest]}"; files[newest]="$swap_file"
    swap_sequence="${sequences[left]}"; sequences[left]="${sequences[newest]}"; sequences[newest]="$swap_sequence"
  fi
done
for ((index = retention; index < ${#files[@]}; index += 1)); do
  # 每个删除目标在枚举时已解析并校验父目录；这里不会把不受控文本传给 rm。
  rm -f -- "${files[index]}"
done

# 成功时仅输出可公开的最终归档路径；路径可含已验证数据库标识，但不含账号、密码、token 或容器环境值。
printf '%s\n' "$final_file"
