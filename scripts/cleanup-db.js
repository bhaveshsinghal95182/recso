import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

function cleanup() {
  const appData = process.env.APPDATA;
  if (!appData) {
    console.error('Error: APPDATA environment variable is not defined.');
    process.exit(1);
  }

  const dbPath = path.join(appData, 'recso', 'recso.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`Error: Database file not found at ${dbPath}`);
    process.exit(1);
  }

  console.log(`Connecting to database at: ${dbPath}`);

  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    console.error('Failed to open database:', err);
    process.exit(1);
  }

  try {
    // Check current count
    const countStmt = db.prepare('SELECT count(*) as count FROM recordings');
    const beforeCount = countStmt.get().count;
    console.log(`Current recording count: ${beforeCount}`);

    if (beforeCount === 0) {
      console.log('No recordings to delete.');
      return;
    }

    // Delete all recordings
    // Note: mouse_events should be deleted automatically due to ON DELETE CASCADE foreign key
    const deleteStmt = db.prepare('DELETE FROM recordings');
    const result = deleteStmt.run();

    console.log(`Deleted ${result.changes} recordings.`);

    // Verify count
    const afterCount = countStmt.get().count;
    console.log(`Remaining recording count: ${afterCount}`);

    // Optional: Vacuum to reclaim space
    console.log('Vacuuming database...');
    db.exec('VACUUM');
    console.log('Database vacuumed.');
  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    if (db) {
      db.close();
      console.log('Database connection closed.');
    }
    process.exit(0);
  }
}

cleanup();
