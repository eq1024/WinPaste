use rusqlite::{Connection, params};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use crate::domain::sticky::StickyEntry;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub trait StickyRepository {
    fn create(&self, entry: &StickyEntry) -> Result<i64, String>;
    fn get_all(&self) -> Result<Vec<StickyEntry>, String>;
    fn get_by_id(&self, id: i64) -> Result<Option<StickyEntry>, String>;
    fn update_position(&self, id: i64, x: i32, y: i32) -> Result<(), String>;
    fn update_size(&self, id: i64, width: i32, height: i32) -> Result<(), String>;
    fn update_content(&self, id: i64, content: &str) -> Result<(), String>;
    fn update_always_on_top(&self, id: i64, enabled: bool) -> Result<(), String>;
    fn delete(&self, id: i64) -> Result<(), String>;
}

pub struct SqliteStickyRepository {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStickyRepository {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }
}

impl StickyRepository for SqliteStickyRepository {
    fn create(&self, entry: &StickyEntry) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = now_ms();
        conn.execute(
            "INSERT INTO sticky_windows (content, content_type, x, y, width, height, always_on_top, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry.content,
                entry.content_type,
                entry.x,
                entry.y,
                entry.width,
                entry.height,
                entry.always_on_top as i32,
                now,
            ],
        ).map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    fn get_all(&self) -> Result<Vec<StickyEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, content, content_type, x, y, width, height, always_on_top, created_at
                 FROM sticky_windows ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let entries = stmt
            .query_map([], |row| {
                Ok(StickyEntry {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    content_type: row.get(2)?,
                    x: row.get(3)?,
                    y: row.get(4)?,
                    width: row.get(5)?,
                    height: row.get(6)?,
                    always_on_top: row.get::<_, i32>(7)? != 0,
                    created_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(entries)
    }

    fn get_by_id(&self, id: i64) -> Result<Option<StickyEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, content, content_type, x, y, width, height, always_on_top, created_at
             FROM sticky_windows WHERE id = ?1",
            params![id],
            |row| {
                Ok(StickyEntry {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    content_type: row.get(2)?,
                    x: row.get(3)?,
                    y: row.get(4)?,
                    width: row.get(5)?,
                    height: row.get(6)?,
                    always_on_top: row.get::<_, i32>(7)? != 0,
                    created_at: row.get(8)?,
                })
            },
        );
        match result {
            Ok(entry) => Ok(Some(entry)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn update_position(&self, id: i64, x: i32, y: i32) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sticky_windows SET x = ?1, y = ?2 WHERE id = ?3",
            params![x, y, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn update_size(&self, id: i64, width: i32, height: i32) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sticky_windows SET width = ?1, height = ?2 WHERE id = ?3",
            params![width, height, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn update_content(&self, id: i64, content: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sticky_windows SET content = ?1 WHERE id = ?2",
            params![content, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn update_always_on_top(&self, id: i64, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sticky_windows SET always_on_top = ?1 WHERE id = ?2",
            params![enabled as i32, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn delete(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM sticky_windows WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
