use super::*;
use sqlx::sqlite::SqliteJournalMode;
use std::sync::atomic::{AtomicU32, Ordering};

static SEQ: AtomicU32 = AtomicU32::new(0);

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "memora-acceptance-{label}-{}-{}",
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

/// 构造与 0.9.0 等价的数据库：迁移 1-9 + `_sqlx_migrations` 记录 + 真实业务行
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

#[tokio::test]
async fn migration_10_upgrades_v9_fixture_and_preserves_rows() {
    let dir = temp_dir("migration");
    let path = v9_fixture(&dir, "bianqian.db").await;

    let before = inspect_database(&path).await.unwrap();
    assert_eq!(before.schema_version, 9);
    assert!(!before.has_version_column);

    let mut conn = open(&path).await;
    let migration = crate::database_migrations()
        .into_iter()
        .find(|migration| migration.version == 10)
        .expect("必须存在第 10 号迁移");
    exec(&mut conn, migration.sql).await;
    exec(
        &mut conn,
        "INSERT INTO _sqlx_migrations (version, description) VALUES (10, 'test');",
    )
    .await;
    let (title, version): (String, i64) =
        sqlx::query_as("SELECT title, version FROM entries WHERE id = 'n-legacy'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
    assert_eq!(title, "0.9 数据");
    assert_eq!(version, 1, "旧行必须获得默认版本 1");
    conn.close().await.unwrap();

    let after = inspect_database(&path).await.unwrap();
    assert_eq!(after.schema_version, SCHEMA_VERSION);
    assert!(after.has_version_column);
    assert_eq!(after.quick_check.to_ascii_lowercase(), "ok");
    assert_eq!(after.integrity_check.to_ascii_lowercase(), "ok");

    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn wal_committed_rows_are_captured_in_consistent_backup() {
    let dir = temp_dir("wal");
    let path = v9_fixture(&dir, "bianqian.db").await;

    // 保持写入连接不关闭，模拟未检查点的 WAL 状态
    let mut live = open(&path).await;
    exec(
        &mut live,
        "INSERT INTO entries (id, kind, title, content, created_at, updated_at) \
         VALUES ('n-wal', 'note', 'WAL 未检查点', 'x', 2000, 2000);",
    )
    .await;
    assert_eq!(count_of(&path, "n-wal").await, 1);

    let backup = dir.join("backup-wal.db");
    let metadata = backup_to_path(&path, &backup, "manual", "1.0.0")
        .await
        .unwrap();
    assert!(metadata.valid);
    assert!(metadata.required_tables);
    assert_eq!(metadata.schema_version, 9);
    assert_eq!(metadata.size_bytes, fs::metadata(&backup).unwrap().len());
    assert_eq!(metadata.sha256, sha256_file(&backup).unwrap());
    assert!(json_path(&backup).is_file(), "备份必须带 sidecar 元数据");
    // 源库保持 WAL，快照本身由 VACUUM INTO 生成独立文件
    let source_state = inspect_database(&path).await.unwrap();
    assert_eq!(source_state.journal_mode.to_ascii_lowercase(), "wal");
    assert!(!metadata.journal_mode.is_empty());

    // 快照中必须包含已提交但尚未检查点的 WAL 行
    assert_eq!(count_of(&backup, "n-wal").await, 1);
    assert_eq!(title_of(&backup, "n-legacy").await, "0.9 数据");

    live.close().await.unwrap();
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn restore_creates_snapshot_and_replaces_database() {
    let dir = temp_dir("restore");
    let source = v9_fixture(&dir, "bianqian.db").await;
    let dest = dir.join("current.db");
    fs::copy(&source, &dest).unwrap();

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

    let restore_source = dir.join("restore-source.db");
    backup_to_path(&source, &restore_source, "manual", "1.0.0")
        .await
        .unwrap();

    let snapshots = dir.join("snapshots");
    let result = restore_into_path(&restore_source, &dest, Some(&snapshots), "1.0.0", false)
        .await
        .unwrap();
    assert_eq!(result.schema_version, 9);

    let snapshot = result.pre_restore_snapshot.expect("恢复前必须生成快照");
    let snapshot_meta = read_metadata(Path::new(&snapshot)).unwrap();
    assert!(snapshot_meta.valid);

    // 当前库已被备份内容替换，新增行消失
    assert_eq!(title_of(&dest, "n-legacy").await, "0.9 数据");
    assert_eq!(count_of(&dest, "n-current").await, 0);
    // 快照保留恢复前状态
    assert_eq!(
        title_of(Path::new(&snapshot), "n-legacy").await,
        "当前库标题"
    );
    assert_eq!(count_of(Path::new(&snapshot), "n-current").await, 1);

    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn corrupt_restore_source_is_rejected_without_touching_database() {
    let dir = temp_dir("restore-corrupt");
    let dest = v9_fixture(&dir, "bianqian.db").await;

    let corrupt = dir.join("corrupt.db");
    fs::write(&corrupt, vec![7u8; 4096]).unwrap();
    let snapshots = dir.join("snapshots");
    let error = restore_into_path(&corrupt, &dest, Some(&snapshots), "1.0.0", false)
        .await
        .unwrap_err();
    assert!(
        error.contains("校验失败")
            || error.contains("备份文件")
            || error.contains("database")
            || error.contains("malformed"),
        "应按校验失败拒绝：{error}"
    );
    assert_eq!(title_of(&dest, "n-legacy").await, "0.9 数据");
    assert!(
        !snapshots.exists() || fs::read_dir(&snapshots).unwrap().next().is_none(),
        "校验失败时不应创建恢复前快照"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn gate_blocks_future_schema_and_versionless_v10() {
    let dir = temp_dir("gate-future");
    let future = dir.join("future.db");
    fs::copy(v9_fixture(&dir, "bianqian.db").await, &future).unwrap();
    let mut conn = open_plain(&future).await;
    exec(&mut conn, "PRAGMA user_version = 11;").await;
    conn.close().await.unwrap();
    let error = inspect_database(&future).await.unwrap_err();
    assert_eq!(error.kind, "future_schema");

    let broken_dir = temp_dir("gate-broken");
    let broken = broken_dir.join("broken.db");
    let source = v9_fixture(&broken_dir, "bianqian.db").await;
    fs::copy(&source, &broken).unwrap();
    let mut conn = open_plain(&broken).await;
    exec(
        &mut conn,
        "UPDATE _sqlx_migrations SET version = 10 WHERE version = 9;",
    )
    .await;
    conn.close().await.unwrap();
    let error = inspect_database(&broken).await.unwrap_err();
    assert_eq!(error.kind, "structure_invalid");

    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&broken_dir);
}
