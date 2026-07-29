#!/usr/bin/env bash

# 本脚本只由官方 postgres:17 在全新空数据目录的 initdb 阶段执行；重复容器启动不会再次处理 initdb.d 文件。
# bootstrap 管理角色保留在 postgres 容器内部，应用从第一条迁移 SQL 起只使用下面创建的普通数据库所有者。
set -Eeuo pipefail

# 只检查存在与非空，不打印任何变量值；错误由 shell 固定变量名分类，密码绝不能进入普通初始化日志。
: "${POSTGRES_DB:?POSTGRES_DB_REQUIRED}"
: "${POSTGRES_USER:?POSTGRES_USER_REQUIRED}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD_REQUIRED}"
: "${APP_DATABASE_USER:?APP_DATABASE_USER_REQUIRED}"
: "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD_REQUIRED}"

# 角色名限制为 PostgreSQL 未加引号的小写安全子集，避免健康检查或运维命令需要拼接任意标识符。
[[ "${APP_DATABASE_USER}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || exit 1
[[ "${POSTGRES_USER}" != "${APP_DATABASE_USER}" ]] || exit 1
[[ "${APP_DATABASE_USER}" != "postgres" ]] || exit 1
# bootstrap 管理密码与普通应用密码必须不同；比较发生在 psql 前且不输出值，避免一份泄漏同时取得集群管理和业务权限。
[[ "${POSTGRES_PASSWORD}" != "${APP_DATABASE_PASSWORD}" ]] || exit 1

# psql 从环境取得应用用户名与密码，不把密码放入命令行参数；%I/%L 分别进行标识符与 SQL 字面量引用。
# CREATE ROLE、数据库所有权和 public schema 所有权位于同一事务，任一步失败都不会留下半配置角色或权限。
psql \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --no-psqlrc \
  --quiet \
  --set=ON_ERROR_STOP=1 <<'BOOTSTRAP_SQL'
\getenv app_database_user APP_DATABASE_USER
\getenv app_database_password APP_DATABASE_PASSWORD

BEGIN;

SELECT format(
  'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS',
  :'app_database_user',
  :'app_database_password'
)
\gexec

-- 项目普通角色成为专属数据库与 public schema 所有者，足以执行版本化 DDL 和业务 SQL，但没有跨数据库集群管理能力。
SELECT format(
  'ALTER DATABASE %I OWNER TO %I',
  current_database(),
  :'app_database_user'
)
\gexec

SELECT format(
  'ALTER SCHEMA public OWNER TO %I',
  :'app_database_user'
)
\gexec

COMMIT;
BOOTSTRAP_SQL
