use super::*;
use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
use sqlx::sqlite::{SqliteJournalMode, SqlitePoolOptions};
use std::borrow::Cow;
use std::sync::atomic::{AtomicU32, Ordering};

static SEQ: AtomicU32 = AtomicU32::new(0);

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "memora-acceptance-data-{label}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

async fn open(path: &Path) -> SqliteConnection {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal);
    SqliteConnection::connect_with(&options).await.unwrap()
}

async fn open_plain(path: &Path) -> SqliteConnection {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    SqliteConnection::connect_with(&options).await.unwrap()
}

async fn exec(conn: &mut SqliteConnection, sql: &str) {
    sqlx::raw_sql(sql).execute(&mut *conn).await.unwrap();
}

async fn title_of(path: &Path, id: &str) -> String {
    let mut conn = connect_readonly(path).await.unwrap();
    sqlx::query_scalar("SELECT title FROM entries WHERE id = ?1")
        .bind(id)
        .fetch_one(&mut conn)
        .await
        .unwrap()
}

async fn count_of(path: &Path, id: &str) -> i64 {
    let mut conn = connect_readonly(path).await.unwrap();
    sqlx::query_scalar("SELECT COUNT(*) FROM entries WHERE id = ?1")
        .bind(id)
        .fetch_one(&mut conn)
        .await
        .unwrap()
}

fn legacy_insert(title: &str) -> String {
    format!(
        "INSERT INTO entries (id, kind, title, content, created_at, updated_at) \
         VALUES ('n-legacy', 'note', '{title}', '正文', 1000, 1000);"
    )
}

async fn v9_fixture(dir: &Path, file_name: &str) -> PathBuf {
    let path = dir.join(file_name);
    let mut conn = open(&path).await;
    for migration in crate::database_migrations()
        .into_iter()
        .filter(|migration| migration.version <= 9)
    {
        exec(&mut conn, migration.sql).await;
    }
    exec(
        &mut conn,
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
           version INTEGER PRIMARY KEY,
           description TEXT NOT NULL DEFAULT '',
           installed_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           success INTEGER NOT NULL DEFAULT 1,
           checksum BLOB NOT NULL DEFAULT X'',
           execution_time INTEGER NOT NULL DEFAULT 0
         );",
    )
    .await;
    for version in 1..=9 {
        exec(
            &mut conn,
            &format!("INSERT INTO _sqlx_migrations (version) VALUES ({version});"),
        )
        .await;
    }
    exec(&mut conn, &legacy_insert("0.9 数据")).await;
    conn.close().await.unwrap();
    path
}

async fn pool_at(path: &Path) -> sqlx::SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap()
}

/// 使用与安装包完全相同的迁移 SQL 构造 sqlx Migrator，最多应用到指定版本。
fn migrator_upto(max_version: i64) -> Migrator {
    let migrations: Vec<SqlxMigration> = crate::database_migrations()
        .into_iter()
        .filter(|migration| migration.version <= max_version)
        .map(|migration| {
            SqlxMigration::new(
                migration.version,
                Cow::Borrowed(migration.description),
                MigrationType::Simple,
                Cow::Borrowed(migration.sql),
                false,
            )
        })
        .collect();
    Migrator {
        migrations: Cow::Owned(migrations),
        ignore_missing: false,
        locking: false,
        no_tx: false,
    }
}

fn gate_state() -> DbGateState {
    DbGateState(Mutex::new(DbGateStatus::default()))
}

/// 由真实 Migrator 生成的 v9 数据库，`_sqlx_migrations` 校验和与安装包一致。
async fn v9_migrated_fixture(dir: &Path, file_name: &str) -> PathBuf {
    let path = dir.join(file_name);
    let pool = pool_at(&path).await;
    migrator_upto(9).run(&pool).await.unwrap();
    sqlx::raw_sql(&legacy_insert("0.9 数据"))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    path
}

#[tokio::test]
async fn daily_auto_backup_deduplicates_and_retention_keeps_latest_seven() {
    let dir = temp_dir("daily-backup");
    let db = v9_migrated_fixture(&dir, "bianqian.db").await;
    let backups = dir.join("backups");

    let skipped = run_daily_backup_at(&db, &backups, false, "1.0.0")
        .await
        .unwrap();
    assert!(skipped.is_none(), "关闭自动备份时不应写入");
    assert!(!backups.exists());

    let first = run_daily_backup_at(&db, &backups, true, "1.0.0")
        .await
        .unwrap()
        .expect("首次启动必须自动备份");
    assert!(first.valid);
    assert_eq!(first.kind, "auto");
    assert_eq!(first.schema_version, 9);
    assert_eq!(valid_backups_in(&backups, "bianqian-").len(), 1);

    let second = run_daily_backup_at(&db, &backups, true, "1.0.0")
        .await
        .unwrap();
    assert!(second.is_none(), "同一天重复启动不得重复备份");
    assert_eq!(valid_backups_in(&backups, "bianqian-").len(), 1);

    // 把已有备份改成“昨天”，验证跨天启动会补一次
    let (path, mut metadata) = valid_backups_in(&backups, "bianqian-")[0].clone();
    metadata.local_date = "1999-01-01".to_string();
    write_metadata(&path, &metadata).unwrap();
    let third = run_daily_backup_at(&db, &backups, true, "1.0.0")
        .await
        .unwrap();
    assert!(third.is_some(), "新的一天必须重新备份");
    assert_eq!(valid_backups_in(&backups, "bianqian-").len(), 2);

    // 再补 7 份可排序的自动备份，总计 9 份，裁剪后必须只剩最新 7 份
    let mut manual_paths = Vec::new();
    for index in 0..7 {
        let path = backups.join(format!("bianqian-2000-0101-000000{index}.db"));
        backup_to_path(&db, &path, "auto", "1.0.0").await.unwrap();
        manual_paths.push(path);
    }
    prune_auto_backups_in(&backups);
    let remaining = list_backup_paths(&backups, "bianqian-");
    assert_eq!(remaining.len(), AUTO_BACKUP_KEEP);
    assert!(!manual_paths[0].exists(), "最旧备份必须被裁剪");
    assert!(!manual_paths[1].exists(), "次旧备份必须被裁剪");
    for path in &manual_paths[2..] {
        assert!(path.exists(), "较新的备份必须保留");
    }
    assert!(
        !json_path(&manual_paths[0]).exists(),
        "裁剪时必须同时删除 sidecar 元数据"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn auto_backup_reports_unwritable_directory_without_touching_database() {
    let dir = temp_dir("backup-blocked");
    let db = v9_migrated_fixture(&dir, "bianqian.db").await;
    let blocked = dir.join("blocked");
    fs::write(&blocked, b"not a directory").unwrap();
    let before = sha256_file(&db).unwrap();

    let error = run_daily_backup_at(&db, &blocked, true, "1.0.0")
        .await
        .unwrap_err();
    assert!(
        error.contains("备份目录") || error.contains("创建备份目录失败"),
        "必须显式报告备份目录不可写：{error}"
    );
    assert_eq!(sha256_file(&db).unwrap(), before);
    inspect_database(&db).await.unwrap();

    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_rejects_missing_table_and_oversized_source_without_touching_database() {
    let dir = temp_dir("restore-reject");
    let dest = v9_fixture(&dir, "current.db").await;
    let before = sha256_file(&dest).unwrap();
    let snapshots = dir.join("snapshots");

    let missing = dir.join("missing-table.db");
    let mut conn = open_plain(&missing).await;
    exec(&mut conn, "CREATE TABLE notes (id TEXT PRIMARY KEY);").await;
    conn.close().await.unwrap();
    let error = restore_into_path(&missing, &dest, Some(&snapshots), "1.0.0", false)
        .await
        .unwrap_err();
    assert!(
        error.contains("missing_table") || error.contains("缺少 entries"),
        "缺少 entries 表必须拒绝恢复：{error}"
    );
    assert_eq!(sha256_file(&dest).unwrap(), before);
    assert!(
        !snapshots.exists() || fs::read_dir(&snapshots).unwrap().next().is_none(),
        "拒绝恢复时不得创建快照"
    );

    let oversized = dir.join("oversized.db");
    fs::write(&oversized, vec![0u8; 4096]).unwrap();
    let error = restore_into_path_capped(&oversized, &dest, Some(&snapshots), "1.0.0", false, 1024)
        .await
        .unwrap_err();
    assert!(
        error.contains("大小上限"),
        "超过大小上限必须拒绝恢复：{error}"
    );
    assert_eq!(sha256_file(&dest).unwrap(), before);

    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_failpoints_roll_back_to_original_database() {
    let dir = temp_dir("restore-failpoints");
    let source_fixture = v9_fixture(&dir, "source.db").await;
    let source = dir.join("restore-source.db");
    backup_to_path(&source_fixture, &source, "manual", "1.0.0")
        .await
        .unwrap();

    let dest = v9_fixture(&dir, "current.db").await;
    let mut conn = open_plain(&dest).await;
    exec(
        &mut conn,
        "UPDATE entries SET title = '当前库标题' WHERE id = 'n-legacy';",
    )
    .await;
    exec(
        &mut conn,
        "INSERT INTO entries (id, kind, title, content, created_at, updated_at) \
         VALUES ('n-current', 'note', '当前库新增', '', 3000, 3000);",
    )
    .await;
    conn.close().await.unwrap();
    let original = fs::read(&dest).unwrap();
    let snapshots = dir.join("snapshots");

    for stage in 1u8..=4 {
        failpoints::set(stage);
        let result = restore_into_path(&source, &dest, Some(&snapshots), "1.0.0", false).await;
        failpoints::set(0);
        let error = result.expect_err("注入中断必须失败");
        assert!(
            error.contains("注入中断") || error.contains("回退"),
            "第 {stage} 个注入点必须报告失败：{error}"
        );
        assert_eq!(
            fs::read(&dest).unwrap(),
            original,
            "第 {stage} 个注入点后原数据库字节必须保持不变"
        );
        assert_eq!(title_of(&dest, "n-legacy").await, "当前库标题");
        assert_eq!(count_of(&dest, "n-current").await, 1);
        inspect_database(&dest).await.unwrap();
        assert_eq!(count_of(&source, "n-legacy").await, 1, "恢复源不应被修改");
    }

    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn gate_backs_up_then_allows_migration_and_marks_readonly_on_failures() {
    let dir = temp_dir("gate-order");
    let db = v9_migrated_fixture(&dir, "bianqian.db").await;
    let backups = dir.join("backups");
    let state = gate_state();

    let gate_start = now_millis();
    prepare_gate_at(&db, &backups, "1.0.0", &state).await;
    let gate_end = now_millis();
    let status = gate_snapshot(&state);
    assert_eq!(status.status, STATUS_READY);
    assert!(status.migration_pending);
    assert_eq!(status.schema_version, 9);
    let backup = PathBuf::from(
        status
            .pre_migration_backup
            .clone()
            .expect("迁移前必须生成备份"),
    );
    let metadata = read_metadata(&backup).unwrap();
    assert!(metadata.valid);
    assert_eq!(metadata.kind, "pre-migration");
    assert_eq!(metadata.schema_version, 9);
    assert!(
        metadata.backup_at >= gate_start && metadata.backup_at <= gate_end,
        "备份时间必须落在闸门执行期间"
    );
    assert_eq!(title_of(&backup, "n-legacy").await, "0.9 数据");

    let migration_started = now_millis();
    assert!(
        metadata.backup_at <= migration_started,
        "备份时间必须早于迁移开始"
    );
    let pool = pool_at(&db).await;
    migrator_upto(SCHEMA_VERSION).run(&pool).await.unwrap();
    pool.close().await;
    let after = inspect_database(&db).await.unwrap();
    assert_eq!(after.schema_version, SCHEMA_VERSION);
    assert!(after.has_version_column);
    assert_eq!(title_of(&db, "n-legacy").await, "0.9 数据");

    // 修复后的闸门在重启后不再要求迁移
    let state = gate_state();
    prepare_gate_at(&db, &backups, "1.0.0", &state).await;
    let status = gate_snapshot(&state);
    assert_eq!(status.status, STATUS_READY);
    assert!(!status.migration_pending);

    // 损坏数据库：闸门必须转为只读并给出错误
    let corrupt = dir.join("corrupt.db");
    fs::write(&corrupt, vec![9u8; 4096]).unwrap();
    let state = gate_state();
    prepare_gate_at(&corrupt, &backups, "1.0.0", &state).await;
    let status = gate_snapshot(&state);
    assert_eq!(status.status, STATUS_READONLY);
    assert!(status.error_type.is_some());
    assert!(status.message.is_some());
    assert!(!status.migration_pending);

    // 迁移前备份失败：必须阻止迁移并转只读，原库不变
    let blocked_dir = temp_dir("gate-blocked");
    let blocked_db = v9_migrated_fixture(&blocked_dir, "bianqian.db").await;
    let blocked_backups = blocked_dir.join("blocked");
    fs::write(&blocked_backups, b"not a directory").unwrap();
    let before = sha256_file(&blocked_db).unwrap();
    let state = gate_state();
    prepare_gate_at(&blocked_db, &blocked_backups, "1.0.0", &state).await;
    let status = gate_snapshot(&state);
    assert_eq!(status.status, STATUS_READONLY);
    assert_eq!(status.error_type.as_deref(), Some("backup_failed"));
    assert_eq!(sha256_file(&blocked_db).unwrap(), before);
    let inspection = inspect_database(&blocked_db).await.unwrap();
    assert_eq!(inspection.schema_version, 9);

    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&blocked_dir);
}

#[tokio::test]
async fn migration_10_failure_rolls_back_and_repeat_start_is_idempotent() {
    let dir = temp_dir("migration-rollback");
    let failing = dir.join("failing.db");
    let pool = pool_at(&failing).await;
    migrator_upto(9).run(&pool).await.unwrap();
    sqlx::raw_sql(&legacy_insert("0.9 数据"))
        .execute(&pool)
        .await
        .unwrap();
    // 注入冲突：v9 数据里已存在 version 列，第 10 号迁移的 ALTER 必然失败
    sqlx::raw_sql("ALTER TABLE entries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;")
        .execute(&pool)
        .await
        .unwrap();
    let _ = migrator_upto(SCHEMA_VERSION)
        .run(&pool)
        .await
        .expect_err("冲突的 v10 迁移必须失败");
    let applied: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 10")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(applied, 0, "失败的第 10 号迁移不得被记录为已应用");
    let title: String = sqlx::query_scalar("SELECT title FROM entries WHERE id = 'n-legacy'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(title, "0.9 数据", "迁移失败不得损坏既有数据");
    pool.close().await;
    let state = inspect_database(&failing).await.unwrap();
    assert_eq!(state.schema_version, 9, "迁移失败后 schema 必须停留在 v9");

    // 无冲突的 v9 数据库：首次与重复启动都必须成功且幂等
    let healthy = dir.join("healthy.db");
    let pool = pool_at(&healthy).await;
    migrator_upto(9).run(&pool).await.unwrap();
    sqlx::raw_sql(&legacy_insert("0.9 数据"))
        .execute(&pool)
        .await
        .unwrap();
    let migrator = migrator_upto(SCHEMA_VERSION);
    migrator.run(&pool).await.unwrap();
    migrator.run(&pool).await.unwrap();
    let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(applied, 10);
    let (title, version): (String, i64) =
        sqlx::query_as("SELECT title, version FROM entries WHERE id = 'n-legacy'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(title, "0.9 数据");
    assert_eq!(version, 1);
    pool.close().await;
    let state = inspect_database(&healthy).await.unwrap();
    assert_eq!(state.schema_version, SCHEMA_VERSION);
    assert!(state.has_version_column);

    let _ = fs::remove_dir_all(&dir);
}
