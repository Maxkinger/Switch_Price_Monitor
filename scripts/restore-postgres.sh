#!/usr/bin/env bash

# 此 NAS 运维入口只向显式指定的空目标数据库恢复一个已验证 custom archive；它拒绝运行中的 app，
# 因为应用的迁移器和调度器可能同时写入，恢复绝不以 --clean 覆盖任何已有业务数据。
set -Eeuo pipefail
umask 077

usage() {
  # 固定帮助文本不读取 `.env`，避免密码、DATABASE_URL 或 Telegram 值被误打印。
  printf '%s\n' 'usage: restore-postgres.sh --compose-file ABSOLUTE --project-name NAME --app-service NAME --database-service NAME --project-root ABSOLUTE --backup-dir ABSOLUTE --dump ABSOLUTE --database NAME' >&2
}

die() {
  # 恢复错误只返回固定分类，不把容器命令行、连接字符串或 pg 错误详情写到宿主终端。
  printf '%s\n' "$1" >&2
  exit 1
}

require_value() { [[ $# -eq 2 && -n "$2" ]] || { usage; die '参数缺少值'; }; }

canonical_existing_path() {
  # NAS GNU 与 M1 BSD realpath 都可无选项解析已存在绝对路径；避免 GNU 专属 -e 使 M1 验收在任何数据库操作前错误失败。
  [[ -e "$1" ]] || return 1
  realpath -- "$1"
}

compose_file=''; project_name=''; app_service=''; database_service=''; project_root=''; backup_dir=''; dump_file=''; target_database=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file|--project-name|--app-service|--database-service|--project-root|--backup-dir|--dump|--database)
      require_value "$1" "${2-}"
      case "$1" in
        --compose-file) compose_file="$2" ;; --project-name) project_name="$2" ;; --app-service) app_service="$2" ;;
        --database-service) database_service="$2" ;; --project-root) project_root="$2" ;; --backup-dir) backup_dir="$2" ;;
        --dump) dump_file="$2" ;; --database) target_database="$2" ;;
      esac
      shift 2 ;;
    *) usage; die '参数不受支持' ;;
  esac
done

# 先严格限制所有标识与绝对路径；数据库名只允许 PostgreSQL 未加引号安全子集，避免运维参数变成 SQL 或 shell 代码。
[[ "$compose_file" == /* && "$project_root" == /* && "$backup_dir" == /* && "$dump_file" == /* ]] || die '路径必须为绝对路径'
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die 'Compose project 名不合法'
[[ "$app_service" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$ && "$database_service" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$ ]] || die 'Compose 服务名不合法'
[[ "$target_database" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die '目标数据库名不合法'
compose_file="$(canonical_existing_path "$compose_file")" || die 'Compose 文件不存在'
project_root="$(canonical_existing_path "$project_root")" || die '项目根目录不存在'
backup_dir="$(canonical_existing_path "$backup_dir")" || die '备份目录不存在'
dump_file="$(canonical_existing_path "$dump_file")" || die '备份文件不存在'
[[ -f "$compose_file" && -d "$project_root" && -d "$backup_dir" && -f "$dump_file" ]] || die '路径类型不符合要求'
[[ "$project_root" != / && "$backup_dir" != / && "$backup_dir" != "$project_root" && "$backup_dir" == "$project_root"/* ]] || die '备份目录必须是项目根目录的严格子目录'
[[ "$(dirname -- "$dump_file")" == "$backup_dir" && "${dump_file##*/}" =~ ^switch-price-monitor-[a-z_][a-z0-9_]{0,62}-[0-9]{18}-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || die '只接受备份目录内的受控 custom archive'

docker compose -f "$compose_file" -p "$project_name" config -q >/dev/null 2>&1 || die 'Compose 配置无效'
lock_directory="$backup_dir/.switch-price-monitor-restore-$target_database.lock"
mkdir -- "$lock_directory" 2>/dev/null || die '恢复锁已被占用'
cleanup() {
  # lock 仅由本进程 mkdir 且不存放归档、错误或用户文件；退出时只 rmdir 这个精确空目录，
  # 禁止递归删除以免外部人为创建文件时扩大恢复脚本的破坏范围。
  if [[ -d "$lock_directory" ]]; then rmdir -- "$lock_directory"; fi
}
trap cleanup EXIT
docker compose -f "$compose_file" -p "$project_name" config --services 2>/dev/null | grep -Fx -- "$app_service" >/dev/null || die '应用服务不存在'
docker compose -f "$compose_file" -p "$project_name" config --services 2>/dev/null | grep -Fx -- "$database_service" >/dev/null || die '数据库服务不存在'

# app 运行时可能自动迁移或调度写入；必须在任何 archive 读取、建表检查和恢复前停止，避免并发造成不可审计的混合状态。
assert_app_stopped() {
  # all IDs 必须逐个属于 exited/dead；created、paused、restarting 或 running 也可能持有迁移/调度状态。
  local all_ids safe_ids identifier
  all_ids="$(docker compose -f "$compose_file" -p "$project_name" ps --all -q "$app_service" 2>/dev/null)"
  safe_ids="$(docker compose -f "$compose_file" -p "$project_name" ps --all --status exited -q "$app_service" 2>/dev/null; docker compose -f "$compose_file" -p "$project_name" ps --all --status dead -q "$app_service" 2>/dev/null)"
  while IFS= read -r identifier; do [[ -z "$identifier" ]] || grep -Fx -- "$identifier" <<<"$safe_ids" >/dev/null || die '应用服务仍非 exited/dead，拒绝恢复'; done <<<"$all_ids"
}
assert_app_stopped
# app 镜像是生产迁移字节的唯一部署来源；只读 run 不启动 HTTP/调度，固定 sort 和 sha256sum 格式使 manifest 可与账本逐字比较。
manifest="$(docker compose -f "$compose_file" -p "$project_name" run --rm --no-deps --entrypoint sh "$app_service" -ceu 'for f in /app/migrations/postgres/*.sql; do test -f "$f" || exit 1; line="$(sha256sum "$f")"; checksum="${line%% *}"; printf "%s|%s\\n" "${f##*/}" "$checksum"; done | LC_ALL=C sort' 2>/dev/null)" || die '迁移校验失败'
[[ -n "$manifest" && "$manifest" =~ ^[A-Za-z0-9_.-]+\|[0-9a-f]{64}($'\n'[A-Za-z0-9_.-]+\|[0-9a-f]{64})*$ ]] || die '迁移校验失败'

# 普通 app 角色必须拥有目标库。SQL 保持为单条只读 catalog 查询，避免逐对象探针之间出现竞态；
# 它排除系统 namespace 与新库自带的 plpgsql，但覆盖普通角色可恢复的 schema、关系、例程、类型、排序规则、
# 文本搜索、运算符/类/族、转换、publication、large object、扩展、默认权限、外部数据、event trigger 与 subscription。
# 重复计数不影响严格的“必须为零”安全合同，且探针只读对象元数据、不读取任何业务字节。
read_target_state() {
  docker compose -f "$compose_file" -p "$project_name" exec -T "$database_service" sh -ceu '
  exec env PGPASSWORD="$APP_DATABASE_PASSWORD" psql --host="$1" --username="$APP_DATABASE_USER" --dbname="$2" --quiet --no-psqlrc --tuples-only --no-align --command "
    WITH user_namespaces AS (
      SELECT oid,nspname FROM pg_namespace WHERE nspname <> '\''information_schema'\'' AND nspname !~ '\''^pg_'\''
    ), objects AS (
      SELECT nspname::text FROM user_namespaces WHERE nspname <> '\''public'\''
      UNION ALL SELECT c.relname::text FROM pg_class c JOIN user_namespaces n ON n.oid=c.relnamespace
      UNION ALL SELECT p.proname::text FROM pg_proc p JOIN user_namespaces n ON n.oid=p.pronamespace
      UNION ALL SELECT t.typname::text FROM pg_type t JOIN user_namespaces n ON n.oid=t.typnamespace
      UNION ALL SELECT c.collname::text FROM pg_collation c JOIN user_namespaces n ON n.oid=c.collnamespace
      UNION ALL SELECT c.cfgname::text FROM pg_ts_config c JOIN user_namespaces n ON n.oid=c.cfgnamespace
      UNION ALL SELECT d.dictname::text FROM pg_ts_dict d JOIN user_namespaces n ON n.oid=d.dictnamespace
      UNION ALL SELECT p.prsname::text FROM pg_ts_parser p JOIN user_namespaces n ON n.oid=p.prsnamespace
      UNION ALL SELECT t.tmplname::text FROM pg_ts_template t JOIN user_namespaces n ON n.oid=t.tmplnamespace
      UNION ALL SELECT o.oprname::text FROM pg_operator o JOIN user_namespaces n ON n.oid=o.oprnamespace
      UNION ALL SELECT o.opcname::text FROM pg_opclass o JOIN user_namespaces n ON n.oid=o.opcnamespace
      UNION ALL SELECT o.opfname::text FROM pg_opfamily o JOIN user_namespaces n ON n.oid=o.opfnamespace
      UNION ALL SELECT c.conname::text FROM pg_conversion c JOIN user_namespaces n ON n.oid=c.connamespace
      UNION ALL SELECT pubname::text FROM pg_publication
      UNION ALL SELECT oid::text FROM pg_largeobject_metadata
      UNION ALL SELECT extname::text FROM pg_extension WHERE extname <> '\''plpgsql'\''
      UNION ALL SELECT defaclobjtype::text FROM pg_default_acl
      UNION ALL SELECT fdwname::text FROM pg_foreign_data_wrapper
      UNION ALL SELECT srvname::text FROM pg_foreign_server
      UNION ALL SELECT evtname::text FROM pg_event_trigger
      UNION ALL SELECT subname::text FROM pg_subscription WHERE subdbid=(SELECT oid FROM pg_database WHERE datname=current_database())
      UNION ALL SELECT lanname::text FROM pg_language WHERE lanname NOT IN ('\''internal'\'','\''c'\'','\''sql'\'','\''plpgsql'\'')
    )
    SELECT ((SELECT datdba::regrole::text FROM pg_database WHERE datname=current_database())=current_user)::int
      || '\'':'\'' || (SELECT count(*) FROM objects)"
' sh "$database_service" "$target_database" 2>/dev/null
}

empty_guard="$(read_target_state)" || die '无法验证目标数据库所有者与对象'
[[ "$empty_guard" =~ ^1:0[[:space:]]*$ ]] || die '目标数据库所有者或用户对象不符合空库恢复要求'

# 在实际写入前再次检查 app，防止空库守卫后外部 compose up 造成迁移/调度并发。
assert_app_stopped
# custom archive 先由 postgres:17 内的 pg_restore --list 验证；输入从受控宿主文件流入容器临时文件，
# 不要求容器 UID 写 NAS 目录，远端 trap 只删除自己的 /tmp 文件。
if ! cat -- "$dump_file" | docker compose -f "$compose_file" -p "$project_name" exec -T "$database_service" sh -ceu '
  archive="$(mktemp /tmp/switch-price-monitor-restore.XXXXXXXX)"
  trap "rm -f -- \"$archive\"" EXIT
  cat >"$archive"
  pg_restore --list "$archive" >/dev/null
  env PGPASSWORD="$APP_DATABASE_PASSWORD" pg_restore --format=custom --no-owner --no-privileges --single-transaction --exit-on-error \
    --host="$1" --username="$APP_DATABASE_USER" --dbname="$2" "$archive"
' sh "$database_service" "$target_database" 2>/dev/null; then
  die '恢复失败，目标数据库未被声明为成功'
fi

# post-validation 发生在 pg_restore 事务提交后；若账本、核心表或管理员状态不合格，只能清理当前显式目标数据库。
# 目标在写入前已被证明为空、恢复锁仍持有，并再次确认 app 停止；typed cleanup 只删除当前库内由 app 可拥有的
# extension、event trigger、publication、foreign server/wrapper、large object、language 与用户 schema，
# 不使用会撤销其他数据库、表空间或配置参数共享授权的角色级清理命令。任何未覆盖 catalog 会被最终空库探针拒绝。
reset_failed_validation() {
  local cleaned_state
  assert_app_stopped
  if ! docker compose -f "$compose_file" -p "$project_name" exec -T "$database_service" sh -ceu '
    exec env PGPASSWORD="$APP_DATABASE_PASSWORD" psql --host="$1" --username="$APP_DATABASE_USER" --dbname="$2" \
      --quiet --no-psqlrc --set=ON_ERROR_STOP=1 --command "BEGIN;
      DO \$cleanup\$
      DECLARE item record;
      BEGIN
        FOR item IN
          SELECT extname AS name FROM pg_extension
          WHERE extname <> '\''plpgsql'\'' AND extowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        LOOP EXECUTE format('\''DROP EXTENSION %I CASCADE'\'', item.name); END LOOP;

        FOR item IN
          SELECT evtname AS name FROM pg_event_trigger
          WHERE evtowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        LOOP EXECUTE format('\''DROP EVENT TRIGGER %I'\'', item.name); END LOOP;

        FOR item IN
          SELECT pubname AS name FROM pg_publication
          WHERE pubowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        LOOP EXECUTE format('\''DROP PUBLICATION %I CASCADE'\'', item.name); END LOOP;

        FOR item IN
          SELECT srvname AS name FROM pg_foreign_server
          WHERE srvowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        LOOP EXECUTE format('\''DROP SERVER %I CASCADE'\'', item.name); END LOOP;

        FOR item IN
          SELECT fdwname AS name FROM pg_foreign_data_wrapper
          WHERE fdwowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        LOOP EXECUTE format('\''DROP FOREIGN DATA WRAPPER %I CASCADE'\'', item.name); END LOOP;

        FOR item IN
          SELECT oid FROM pg_largeobject_metadata
          WHERE lomowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        LOOP PERFORM lo_unlink(item.oid); END LOOP;

        FOR item IN
          SELECT lanname AS name FROM pg_language
          WHERE lanname NOT IN ('\''internal'\'','\''c'\'','\''sql'\'','\''plpgsql'\'')
            AND lanowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        LOOP EXECUTE format('\''DROP LANGUAGE %I CASCADE'\'', item.name); END LOOP;

        IF EXISTS (
          SELECT 1 FROM pg_namespace
          WHERE nspname <> '\''information_schema'\'' AND nspname !~ '\''^pg_'\''
            AND nspname <> '\''public'\''
            AND nspowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
        ) THEN
          RAISE EXCEPTION '\''目标库出现非 app 所有的并发 schema'\'';
        END IF;

        FOR item IN
          SELECT nspname AS name FROM pg_namespace
          WHERE nspname <> '\''information_schema'\'' AND nspname !~ '\''^pg_'\''
          ORDER BY (nspname='\''public'\'')::int
        LOOP EXECUTE format('\''DROP SCHEMA %I CASCADE'\'', item.name); END LOOP;
      END
      \$cleanup\$;
      CREATE SCHEMA public AUTHORIZATION CURRENT_USER;
      COMMIT;"
  ' sh "$database_service" "$target_database" >/dev/null 2>&1; then
    die '恢复后验证失败且目标空库清理失败'
  fi
  cleaned_state="$(read_target_state)" || die '恢复后验证失败且无法复核目标空库'
  [[ "$cleaned_state" =~ ^1:0[[:space:]]*$ ]] || die '恢复后验证失败且目标未恢复为空库'
}

fail_post_validation() {
  # 先恢复可重试空库，再报告原始固定分类；错误文字不携带 SQL、archive 内容、账号或秘密。
  local message="$1"
  reset_failed_validation
  die "$message"
}

# 此处是迁移验证模式：恢复后必须有非空不可变迁移账本，且认证、设置、商品、地区商品和价格历史核心表完整；
# 任何缺表或空账本均视为失败，避免仅 pg_restore 退出零就把旧/不完整备份当作可启动数据库。
if ! validation="$(docker compose -f "$compose_file" -p "$project_name" exec -T "$database_service" sh -ceu '
  exec env PGPASSWORD="$APP_DATABASE_PASSWORD" psql --host="$1" --username="$APP_DATABASE_USER" --dbname="$2" \
    --quiet --no-psqlrc --tuples-only --no-align --command "SELECT (SELECT count(*) FROM schema_migrations) || '\'':'\'' || count(*) FROM pg_tables WHERE schemaname = '\''public'\'' AND tablename IN ('\''settings'\'', '\''admin_credentials'\'', '\''games'\'', '\''regional_products'\'', '\''price_snapshots'\'')"
' sh "$database_service" "$target_database" 2>/dev/null)"; then
  fail_post_validation '恢复后的迁移验证失败'
fi
[[ "$validation" =~ ^[1-9][0-9]*:5[[:space:]]*$ ]] || fail_post_validation '恢复后的迁移或核心表验证失败'
if ! restored_manifest="$(docker compose -f "$compose_file" -p "$project_name" exec -T "$database_service" sh -ceu 'exec env PGPASSWORD="$APP_DATABASE_PASSWORD" psql --host="$1" --username="$APP_DATABASE_USER" --dbname="$2" --quiet --no-psqlrc --tuples-only --no-align --command "SELECT version || '\''|'\'' || checksum FROM schema_migrations ORDER BY version"' sh "$database_service" "$target_database" 2>/dev/null)"; then
  fail_post_validation '迁移校验失败'
fi
[[ "$restored_manifest" == "$manifest" ]] || fail_post_validation '迁移校验失败'
# 认证恢复只允许尚未初始化的 0 行或单管理员 id=1；查询只返回计数与布尔状态，绝不读取哈希、盐或恢复材料。
if ! admin_state="$(docker compose -f "$compose_file" -p "$project_name" exec -T "$database_service" sh -ceu 'exec env PGPASSWORD="$APP_DATABASE_PASSWORD" psql --host="$1" --username="$APP_DATABASE_USER" --dbname="$2" --quiet --no-psqlrc --tuples-only --no-align --command "SELECT count(*) || '\'':'\'' || coalesce(bool_and(id = 1), true)::int FROM admin_credentials"' sh "$database_service" "$target_database" 2>/dev/null)"; then
  fail_post_validation '管理员认证状态验证失败'
fi
[[ "$admin_state" =~ ^0:1[[:space:]]*$ || "$admin_state" =~ ^1:1[[:space:]]*$ ]] || fail_post_validation '管理员认证状态验证失败'

# 成功提示不包含 archive 内容、账号或密码；调用方仅能据此得知显式目标库已通过最低可启动性验证。
printf '%s\n' '恢复完成并通过迁移与核心表验证'
