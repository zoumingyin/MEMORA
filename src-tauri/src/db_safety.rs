use chrono::Local;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{Connection, Row};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const SCHEMA_VERSION: i64 = 10;
pub const AUTO_BACKUP_KEEP: usize = 7;
const MAX_RESTORE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

const STATUS_PENDING: &str = "pending";
const STATUS_READY: &str = "ready";
const STATUS_READONLY: &str = "readonly";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbGateStatus {
    pub status: String,
    pub error_type: Option<String>,
    pub message: Option<String>,
    pub db_path: String,
    pub schema_version: i64,
    pub migration_pending: bool,
    pub pre_migration_backup: Option<String>,
}

impl Default for DbGateStatus {
    fn default() -> Self {
        Self {
            status: STATUS_PENDING.to_string(),
            error_type: None,
            message: None,
            db_path: String::new(),
            schema_version: 0,
            migration_pending: false,
            pre_migration_backup: None,
        }
    }
}

pub struct DbGateState(pub Mutex<DbGateStatus>);

#[derive(Default)]
pub struct AutoBackupState(pub Mutex<Option<String>>);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMetadata {
    pub kind: String,
    pub program_version: String,
    pub schema_version: i64,
    pub backup_at: i64,
    pub backup_at_text: String,
    pub local_date: String,
    pub source_path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub quick_check: String,
    pub integrity_check: String,
    pub required_tables: bool,
    pub journal_mode: String,
    pub wal_handled: String,
    pub valid: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBackupStatus {
    pub enabled: bool,
    pub dir: String,
    pub last_backup_at: Option<i64>,
    pub count: usize,
    pub last_error: Option<String>,
    pub last_backup: Option<BackupMetadata>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub backup: BackupMetadata,
    pub pre_restore_snapshot: Option<String>,
    pub schema_version: i64,
}

#[derive(Clone, Debug)]
struct Inspection {
    schema_version: i64,
    has_version_column: bool,
    journal_mode: String,
    quick_check: String,
    integrity_check: String,
    tables: Vec<String>,
}

#[derive(Debug)]
pub struct InspectError {
    pub kind: String,
    pub message: String,
}

impl InspectError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
        }
    }
}

pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(dir.join("bianqian.db"))
}

pub fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(db_path(app)?
        .parent()
        .ok_or_else(|| "无法解析数据库目录".to_string())?
        .join("backups"))
}

fn sidecar(db: &Path, suffix: &str) -> PathBuf {
    let mut value = db.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn json_path(db: &Path) -> PathBuf {
    db.with_extension("json")
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn stamp() -> String {
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

fn local_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| format!("读取文件失败：{error}"))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取文件失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

async fn connect_readonly(path: &Path) -> Result<SqliteConnection, InspectError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| InspectError::new("open_failed", format!("无法打开数据库：{error}")))
}

async fn connect_readwrite(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(false)
        .create_if_missing(false);
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("无法打开数据库：{error}"))
}

async fn read_schema_version(conn: &mut SqliteConnection) -> i64 {
    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *conn)
        .await
        .unwrap_or(0);
    if user_version > 0 {
        return user_version;
    }
    let has_migrations: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap_or(0);
    if has_migrations > 0 {
        return sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
            .fetch_one(&mut *conn)
            .await
            .unwrap_or(0);
    }
    let has_entries: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'entries'",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap_or(0);
    if has_entries > 0 {
        let columns = table_columns(conn, "entries").await;
        return if columns.iter().any(|name| name == "version") {
            SCHEMA_VERSION
        } else {
            9
        };
    }
    0
}

async fn table_columns(conn: &mut SqliteConnection, table: &str) -> Vec<String> {
    let sql = format!("PRAGMA table_info({table})");
    let rows = sqlx::query(&sql).fetch_all(&mut *conn).await.unwrap_or_default();
    rows.into_iter()
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect()
}

async fn inspect_database(path: &Path) -> Result<Inspection, InspectError> {
    if !path.is_file() {
        return Err(InspectError::new("missing", "数据库文件不存在"));
    }
    let mut conn = connect_readonly(path).await?;

    let quick_rows: Vec<String> = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_all(&mut conn)
        .await
        .map_err(|error| InspectError::new("integrity_failed", format!("quick_check 失败：{error}")))?;
    let quick_check = quick_rows.join("; ");
    if quick_check.trim().to_ascii_lowercase() != "ok" {
        return Err(InspectError::new(
            "integrity_failed",
            format!("quick_check 未通过：{quick_check}"),
        ));
    }

    let integrity_rows: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut conn)
        .await
        .map_err(|error| {
            InspectError::new("integrity_failed", format!("integrity_check 失败：{error}"))
        })?;
    let integrity_check = integrity_rows.join("; ");
    if integrity_check.trim().to_ascii_lowercase() != "ok" {
        return Err(InspectError::new(
            "integrity_failed",
            format!("integrity_check 未通过：{integrity_check}"),
        ));
    }

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .fetch_all(&mut conn)
    .await
    .map_err(|error| InspectError::new("structure_invalid", format!("读取表结构失败：{error}")))?;
    if !tables.iter().any(|name| name == "entries") {
        return Err(InspectError::new("missing_table", "缺少 entries 表"));
    }

    let schema_version = read_schema_version(&mut conn).await;
    if schema_version > SCHEMA_VERSION {
        return Err(InspectError::new(
            "future_schema",
            format!("数据库 schema 版本 {schema_version} 高于当前支持的 {SCHEMA_VERSION}"),
        ));
    }
    let columns = table_columns(&mut conn, "entries").await;
    if columns.is_empty() {
        return Err(InspectError::new("structure_invalid", "entries 表结构不可读"));
    }
    let has_version_column = columns.iter().any(|name| name == "version");
    if schema_version >= SCHEMA_VERSION && !has_version_column {
        return Err(InspectError::new(
            "structure_invalid",
            "schema 版本为 10 但 entries 缺少 version 列",
        ));
    }

    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut conn)
        .await
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(Inspection {
        schema_version,
        has_version_column,
        journal_mode,
        quick_check,
        integrity_check,
        tables,
    })
}

fn read_metadata(path: &Path) -> Result<BackupMetadata, String> {
    let raw = fs::read_to_string(json_path(path)).map_err(|error| format!("缺少备份元数据：{error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("备份元数据损坏：{error}"))
}

fn write_metadata(path: &Path, metadata: &BackupMetadata) -> Result<(), String> {
    let target = json_path(path);
    let tmp = target.with_extension("json.tmp");
    let raw = serde_json::to_vec_pretty(metadata).map_err(|error| error.to_string())?;
    fs::write(&tmp, raw).map_err(|error| format!("写入备份元数据失败：{error}"))?;
    if target.exists() {
        fs::remove_file(&target).map_err(|error| format!("替换备份元数据失败：{error}"))?;
    }
    fs::rename(&tmp, &target).map_err(|error| format!("保存备份元数据失败：{error}"))
}

fn verify_metadata(path: &Path, metadata: &BackupMetadata) -> Result<(), String> {
    if !metadata.valid {
        return Err("备份元数据标记为无效".to_string());
    }
    let size = fs::metadata(path)
        .map_err(|error| format!("备份文件不可读：{error}"))?
        .len();
    if size != metadata.size_bytes {
        return Err("备份文件大小与元数据不一致".to_string());
    }
    let digest = sha256_file(path)?;
    if !digest.eq_ignore_ascii_case(&metadata.sha256) {
        return Err("备份文件 SHA256 与元数据不一致".to_string());
    }
    Ok(())
}

fn unique_backup_path(dir: &Path, prefix: &str) -> PathBuf {
    let base = format!("{prefix}-{}", stamp());
    let mut candidate = dir.join(format!("{base}.db"));
    let mut index = 2;
    while candidate.exists() || json_path(&candidate).exists() {
        candidate = dir.join(format!("{base}-{index}.db"));
        index += 1;
    }
    candidate
}

/// 使用 `VACUUM INTO` 生成一致性快照；SQLite 会把 WAL 中已提交内容纳入快照。
pub async fn create_backup(
    app: &AppHandle,
    destination: &Path,
    kind: &str,
) -> Result<BackupMetadata, String> {
    let source = db_path(app)?;
    backup_to_path(
        &source,
        destination,
        kind,
        &app.package_info().version.to_string(),
    )
    .await
}

/// 备份核心：只依赖文件路径，便于在无窗口环境下做一致性/恢复验收。
pub(crate) async fn backup_to_path(
    source: &Path,
    destination: &Path,
    kind: &str,
    program_version: &str,
) -> Result<BackupMetadata, String> {
    if !source.is_file() {
        return Err("当前数据库不存在，无法备份".to_string());
    }
    if destination == source {
        return Err("备份目标不能是当前数据库".to_string());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "备份目标目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建备份目录失败：{error}"))?;

    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("backup.db");
    let temp = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    if temp.exists() {
        let _ = fs::remove_file(&temp);
    }

    let mut conn = connect_readwrite(source).await?;
    let temp_literal = temp.to_string_lossy().replace('\'', "''");
    let result = sqlx::query(&format!("VACUUM INTO '{temp_literal}'"))
        .execute(&mut conn)
        .await;
    drop(conn);
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("SQLite 一致性备份失败：{error}"));
    }

    let inspection = match inspect_database(&temp).await {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(&temp);
            return Err(format!("备份校验失败（{}）：{}", error.kind, error.message));
        }
    };
    let size_bytes = fs::metadata(&temp).map_err(|error| error.to_string())?.len();
    let sha256 = sha256_file(&temp)?;
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| format!("替换旧备份失败：{error}"))?;
    }
    fs::rename(&temp, destination).map_err(|error| format!("保存备份文件失败：{error}"))?;

    let metadata = BackupMetadata {
        kind: kind.to_string(),
        program_version: program_version.to_string(),
        schema_version: inspection.schema_version,
        backup_at: now_millis(),
        backup_at_text: Local::now().to_rfc3339(),
        local_date: local_date(),
        source_path: source.to_string_lossy().to_string(),
        file_name: file_name.to_string(),
        size_bytes,
        sha256,
        quick_check: inspection.quick_check,
        integrity_check: inspection.integrity_check,
        required_tables: inspection.tables.iter().any(|name| name == "entries"),
        journal_mode: inspection.journal_mode,
        wal_handled: "vacuum_into_snapshot".to_string(),
        valid: true,
    };
    if let Err(error) = write_metadata(destination, &metadata) {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(metadata)
}

async fn create_named_backup(
    app: &AppHandle,
    prefix: &str,
    kind: &str,
) -> Result<(PathBuf, BackupMetadata), String> {
    let dir = backup_dir(app)?;
    create_named_backup_in(
        &db_path(app)?,
        &dir,
        prefix,
        kind,
        &app.package_info().version.to_string(),
    )
    .await
}

async fn create_named_backup_in(
    source: &Path,
    dir: &Path,
    prefix: &str,
    kind: &str,
    program_version: &str,
) -> Result<(PathBuf, BackupMetadata), String> {
    fs::create_dir_all(dir).map_err(|error| format!("创建备份目录失败：{error}"))?;
    let path = unique_backup_path(dir, prefix);
    let metadata = backup_to_path(source, &path, kind, program_version).await?;
    Ok((path, metadata))
}

fn list_backup_paths(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix) && name.ends_with(".db"))
        })
        .collect();
    paths.sort();
    paths.reverse();
    paths
}

fn valid_backups(app: &AppHandle, prefix: &str) -> Vec<(PathBuf, BackupMetadata)> {
    let Ok(dir) = backup_dir(app) else {
        return Vec::new();
    };
    valid_backups_in(&dir, prefix)
}

fn valid_backups_in(dir: &Path, prefix: &str) -> Vec<(PathBuf, BackupMetadata)> {
    list_backup_paths(dir, prefix)
        .into_iter()
        .filter_map(|path| {
            let metadata = read_metadata(&path).ok()?;
            verify_metadata(&path, &metadata).ok()?;
            Some((path, metadata))
        })
        .collect()
}

fn prune_auto_backups(app: &AppHandle) {
    let Ok(dir) = backup_dir(app) else {
        return;
    };
    prune_auto_backups_in(&dir);
}

fn prune_auto_backups_in(dir: &Path) {
    let backups = list_backup_paths(dir, "bianqian-");
    for (_, path) in backups.into_iter().skip(AUTO_BACKUP_KEEP).enumerate() {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(json_path(&path));
    }
}

async fn run_daily_backup_at(
    source: &Path,
    dir: &Path,
    enabled: bool,
    program_version: &str,
) -> Result<Option<BackupMetadata>, String> {
    if !enabled {
        return Ok(None);
    }
    if valid_backups_in(dir, "bianqian-")
        .into_iter()
        .any(|(_, metadata)| metadata.local_date == local_date())
    {
        return Ok(None);
    }
    let (_, metadata) = create_named_backup_in(source, dir, "bianqian", "auto", program_version).await?;
    prune_auto_backups_in(dir);
    Ok(Some(metadata))
}

pub async fn run_daily_backup(
    app: &AppHandle,
    enabled: bool,
    state: &AutoBackupState,
) -> Result<Option<BackupMetadata>, String> {
    if !enabled {
        return Ok(None);
    }
    let source = db_path(app)?;
    let dir = backup_dir(app)?;
    let metadata = run_daily_backup_at(
        &source,
        &dir,
        enabled,
        &app.package_info().version.to_string(),
    )
    .await?;
    if metadata.is_some() {
        *state.0.lock().unwrap() = None;
    }
    Ok(metadata)
}

pub fn auto_backup_status(
    app: &AppHandle,
    enabled: bool,
    state: &AutoBackupState,
) -> AutoBackupStatus {
    let dir = backup_dir(app)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let backups = valid_backups(app, "bianqian-");
    let last = backups.first().map(|(_, metadata)| metadata.clone());
    AutoBackupStatus {
        enabled,
        dir,
        last_backup_at: last.as_ref().map(|metadata| metadata.backup_at),
        count: backups.len(),
        last_error: state.0.lock().unwrap().clone(),
        last_backup: last,
    }
}

pub async fn prepare_gate(app: &AppHandle, state: &DbGateState) {
    let path = match db_path(app) {
        Ok(path) => path,
        Err(error) => {
            set_readonly(state, &path_or_empty(app), "path_failed", &error, 0, None);
            return;
        }
    };
    let dir = match backup_dir(app) {
        Ok(dir) => dir,
        Err(error) => {
            set_readonly(
                state,
                &path.to_string_lossy(),
                "backup_failed",
                &format!("迁移前备份失败，已阻止迁移：{error}"),
                0,
                None,
            );
            return;
        }
    };
    prepare_gate_at(&path, &dir, &app.package_info().version.to_string(), state).await;
}

/// 迁移前闸门核心：只依赖数据库与备份目录路径，便于在临时目录中验收整条启动链。
pub(crate) async fn prepare_gate_at(
    path: &Path,
    backup_dir: &Path,
    program_version: &str,
    state: &DbGateState,
) {
    let db_text = path.to_string_lossy().to_string();

    if !path.exists() {
        *state.0.lock().unwrap() = DbGateStatus {
            status: STATUS_READY.to_string(),
            error_type: None,
            message: None,
            db_path: db_text,
            schema_version: 0,
            migration_pending: true,
            pre_migration_backup: None,
        };
        return;
    }

    let inspection = match inspect_database(&path).await {
        Ok(value) => value,
        Err(error) => {
            set_readonly(state, &db_text, &error.kind, &error.message, 0, None);
            return;
        }
    };

    if inspection.schema_version >= SCHEMA_VERSION && inspection.has_version_column {
        *state.0.lock().unwrap() = DbGateStatus {
            status: STATUS_READY.to_string(),
            error_type: None,
            message: None,
            db_path: db_text,
            schema_version: inspection.schema_version,
            migration_pending: false,
            pre_migration_backup: None,
        };
        return;
    }

    let backup = match create_named_backup_in(
        path,
        backup_dir,
        "pre-migration",
        "pre-migration",
        program_version,
    )
    .await
    {
        Ok((path, metadata)) => {
            if !metadata.valid {
                set_readonly(
                    state,
                    &db_text,
                    "backup_failed",
                    "迁移前备份校验未通过",
                    inspection.schema_version,
                    None,
                );
                return;
            }
            path
        }
        Err(error) => {
            set_readonly(
                state,
                &db_text,
                "backup_failed",
                &format!("迁移前备份失败，已阻止迁移：{error}"),
                inspection.schema_version,
                None,
            );
            return;
        }
    };

    *state.0.lock().unwrap() = DbGateStatus {
        status: STATUS_READY.to_string(),
        error_type: None,
        message: None,
        db_path: db_text,
        schema_version: inspection.schema_version,
        migration_pending: true,
        pre_migration_backup: Some(backup.to_string_lossy().to_string()),
    };
}

fn path_or_empty(app: &AppHandle) -> String {
    db_path(app)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn set_readonly(
    state: &DbGateState,
    db_path: &str,
    error_type: &str,
    message: &str,
    schema_version: i64,
    pre_migration_backup: Option<String>,
) {
    *state.0.lock().unwrap() = DbGateStatus {
        status: STATUS_READONLY.to_string(),
        error_type: Some(error_type.to_string()),
        message: Some(summarize(message)),
        db_path: db_path.to_string(),
        schema_version,
        migration_pending: false,
        pre_migration_backup,
    };
}

fn summarize(message: &str) -> String {
    let compact = message.replace(['\r', '\n'], " ");
    compact.chars().take(400).collect()
}

pub fn mark_migration_complete(state: &DbGateState, schema_version: i64) {
    let mut guard = state.0.lock().unwrap();
    if guard.status == STATUS_READY {
        guard.schema_version = schema_version;
        guard.migration_pending = false;
    }
}

pub fn mark_load_failed(state: &DbGateState, message: &str) {
    let mut guard = state.0.lock().unwrap();
    guard.status = STATUS_READONLY.to_string();
    guard.error_type = Some("load_failed".to_string());
    guard.message = Some(summarize(message));
    guard.migration_pending = false;
}

pub async fn recover_pre_migration_backup(
    app: &AppHandle,
    state: &DbGateState,
) -> Result<Option<String>, String> {
    let backup = state
        .0
        .lock()
        .unwrap()
        .pre_migration_backup
        .clone()
        .ok_or_else(|| "没有可用的迁移前备份".to_string())?;
    let source = PathBuf::from(&backup);
    let result = restore_from_path(app, &source, state, true).await?;
    Ok(result.pre_restore_snapshot)
}

async fn validate_restore_source_capped(
    path: &Path,
    max_bytes: u64,
) -> Result<BackupMetadata, String> {
    if !path.is_file() {
        return Err("备份文件不存在".to_string());
    }
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("db"))
    {
        return Err("只允许恢复 .db 备份文件".to_string());
    }
    let size = fs::metadata(path)
        .map_err(|error| format!("备份文件不可读：{error}"))?
        .len();
    if size == 0 {
        return Err("备份文件为空".to_string());
    }
    if size > max_bytes {
        return Err("备份文件超过允许的大小上限".to_string());
    }

    let metadata = match read_metadata(path) {
        Ok(metadata) => {
            verify_metadata(path, &metadata)?;
            metadata
        }
        Err(_) => BackupMetadata {
            kind: "external".to_string(),
            program_version: String::new(),
            schema_version: 0,
            backup_at: 0,
            backup_at_text: String::new(),
            local_date: String::new(),
            source_path: path.to_string_lossy().to_string(),
            file_name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string(),
            size_bytes: size,
            sha256: sha256_file(path)?,
            quick_check: String::new(),
            integrity_check: String::new(),
            required_tables: false,
            journal_mode: "unknown".to_string(),
            wal_handled: "external_file".to_string(),
            valid: true,
        },
    };
    let inspection = inspect_database(path).await.map_err(|error| {
        format!("备份校验失败（{}）：{}", error.kind, error.message)
    })?;
    let mut metadata = metadata;
    metadata.schema_version = inspection.schema_version;
    metadata.quick_check = inspection.quick_check;
    metadata.integrity_check = inspection.integrity_check;
    metadata.required_tables = inspection.tables.iter().any(|name| name == "entries");
    metadata.journal_mode = inspection.journal_mode;
    metadata.size_bytes = size;
    metadata.sha256 = sha256_file(path)?;
    Ok(metadata)
}

async fn restore_from_path(
    app: &AppHandle,
    source: &Path,
    state: &DbGateState,
    skip_pre_restore: bool,
) -> Result<RestoreResult, String> {
    let destination = db_path(app)?;
    let snapshot_dir = backup_dir(app).ok();
    let result = restore_into_path(
        source,
        &destination,
        snapshot_dir.as_deref(),
        &app.package_info().version.to_string(),
        skip_pre_restore,
    )
    .await?;
    prepare_gate(app, state).await;
    Ok(result)
}

/// 恢复核心：只依赖文件路径，便于在无窗口环境下验收快照、回滚与失败注入。
pub(crate) async fn restore_into_path(
    source: &Path,
    destination: &Path,
    snapshot_dir: Option<&Path>,
    program_version: &str,
    skip_pre_restore: bool,
) -> Result<RestoreResult, String> {
    restore_into_path_capped(
        source,
        destination,
        snapshot_dir,
        program_version,
        skip_pre_restore,
        MAX_RESTORE_BYTES,
    )
    .await
}

pub(crate) async fn restore_into_path_capped(
    source: &Path,
    destination: &Path,
    snapshot_dir: Option<&Path>,
    program_version: &str,
    skip_pre_restore: bool,
    max_restore_bytes: u64,
) -> Result<RestoreResult, String> {
    let metadata = validate_restore_source_capped(source, max_restore_bytes).await?;
    if source == destination {
        return Err("不能从当前数据库自身恢复".to_string());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "数据库目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建数据库目录失败：{error}"))?;

    let temp = parent.join(format!(".restore-{}.tmp", stamp()));
    fs::copy(source, &temp).map_err(|error| format!("写入恢复临时文件失败：{error}"))?;
    if let Err(error) = inspect_database(&temp).await {
        let _ = fs::remove_file(&temp);
        return Err(format!("恢复临时文件校验失败（{}）：{}", error.kind, error.message));
    }
    #[cfg(test)]
    if failpoints::take(1) {
        let _ = fs::remove_file(&temp);
        return Err("注入中断：恢复临时文件校验后".to_string());
    }

    let pre_restore = if skip_pre_restore || !destination.exists() {
        None
    } else {
        let dir = snapshot_dir.ok_or_else(|| "恢复前快照目录不可用".to_string())?;
        fs::create_dir_all(dir).map_err(|error| format!("创建恢复前快照失败：{error}"))?;
        let path = unique_backup_path(dir, "pre-restore");
        match backup_to_path(destination, &path, "pre-restore", program_version).await {
            Ok(metadata) => {
                if !metadata.valid {
                    let _ = fs::remove_file(&temp);
                    return Err("恢复前快照校验失败，已取消恢复".to_string());
                }
                Some(path.to_string_lossy().to_string())
            }
            Err(error) => {
                let _ = fs::remove_file(&temp);
                return Err(format!("创建恢复前快照失败，已取消恢复：{error}"));
            }
        }
    };

    #[cfg(test)]
    if failpoints::take(2) {
        let _ = fs::remove_file(&temp);
        return Err("注入中断：替换数据库之前".to_string());
    }

    let rollback = parent.join(format!(".restore-rollback-{}.db", stamp()));
    let wal = sidecar(destination, "-wal");
    let shm = sidecar(destination, "-shm");
    if rollback.exists() {
        let _ = fs::remove_file(&rollback);
    }
    if destination.exists() {
        fs::rename(destination, &rollback).map_err(|error| {
            let _ = fs::remove_file(&temp);
            format!("数据库被占用或无法替换，已取消恢复：{error}")
        })?;
    }
    let _ = fs::remove_file(&wal);
    let _ = fs::remove_file(&shm);
    #[cfg(test)]
    if failpoints::take(3) {
        let _ = fs::remove_file(&temp);
    }

    if let Err(error) = fs::rename(&temp, destination) {
        if rollback.exists() {
            let _ = fs::rename(&rollback, destination);
        }
        return Err(format!("替换数据库失败，已回退：{error}"));
    }
    #[cfg(test)]
    if failpoints::take(4) {
        let _ = fs::write(destination, b"injected-corruption");
    }

    if let Err(error) = inspect_database(destination).await {
        let _ = fs::remove_file(destination);
        if rollback.exists() {
            let _ = fs::rename(&rollback, destination);
        }
        return Err(format!("恢复后校验失败，已回退：{}：{}", error.kind, error.message));
    }

    let _ = fs::remove_file(&rollback);
    let _ = fs::remove_file(&wal);
    let _ = fs::remove_file(&shm);
    let inspection = inspect_database(destination)
        .await
        .map_err(|error| format!("恢复后数据库不可用：{}", error.message))?;
    Ok(RestoreResult {
        backup: metadata,
        pre_restore_snapshot: pre_restore,
        schema_version: inspection.schema_version,
    })
}

pub async fn restore_database(
    app: &AppHandle,
    source_path: String,
    state: &DbGateState,
) -> Result<RestoreResult, String> {
    let source = PathBuf::from(source_path);
    restore_from_path(app, &source, state, false).await
}

pub async fn retry_gate(app: &AppHandle, state: &DbGateState) -> DbGateStatus {
    *state.0.lock().unwrap() = DbGateStatus {
        status: STATUS_PENDING.to_string(),
        db_path: path_or_empty(app),
        ..DbGateStatus::default()
    };
    prepare_gate(app, state).await;
    gate_snapshot(state)
}

pub fn gate_snapshot(state: &DbGateState) -> DbGateStatus {
    state.0.lock().unwrap().clone()
}

pub async fn run_backup_now(
    app: &AppHandle,
    enabled: bool,
    state: &AutoBackupState,
) -> Result<AutoBackupStatus, String> {
    if enabled {
        let (_, metadata) = create_named_backup(app, "bianqian", "manual").await?;
        prune_auto_backups(app);
        *state.0.lock().unwrap() = None;
        let _ = metadata;
    }
    Ok(auto_backup_status(app, enabled, state))
}

#[cfg(test)]
pub(crate) mod failpoints {
    use std::sync::atomic::{AtomicU8, Ordering};

    static STAGE: AtomicU8 = AtomicU8::new(0);

    pub fn set(stage: u8) {
        STAGE.store(stage, Ordering::SeqCst);
    }

    pub fn take(stage: u8) -> bool {
        STAGE
            .compare_exchange(stage, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

#[cfg(test)]
mod acceptance;

#[cfg(test)]
mod acceptance_data;
