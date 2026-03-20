import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import XLSX from 'xlsx';
import mysql from 'mysql2/promise';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'ems_db';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let pool;
const tokenStore = new Map();
const hashPassword = (password) => crypto.createHash('sha256').update(String(password || '')).digest('hex');

const initDb = async () => {
  const bootstrap = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    charset: 'utf8mb4',
  });
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootstrap.end();

  pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ems_records (
      id BIGINT PRIMARY KEY,
      saved_at DATETIME NOT NULL,
      payload LONGTEXT NOT NULL,
      INDEX idx_saved_at (saved_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ems_users (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(128) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'operator',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [adminRows] = await pool.query('SELECT id FROM ems_users WHERE username = ? LIMIT 1', [ADMIN_USERNAME]);
  if (adminRows.length === 0) {
    await pool.query(
      'INSERT INTO ems_users (username, password_hash, role) VALUES (?, ?, ?)',
      [ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD), 'admin']
    );
  }
};

const getLatestRecord = async () => {
  const [rows] = await pool.query('SELECT id, saved_at, payload FROM ems_records ORDER BY id DESC LIMIT 1');
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    savedAt: new Date(row.saved_at).toISOString(),
    payload: JSON.parse(row.payload),
  };
};

const authRequired = async (req, res, next) => {
  const token = req.headers['x-auth-token'];
  if (!token || !tokenStore.has(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const session = tokenStore.get(token);
  const [rows] = await pool.query('SELECT id, username, role FROM ems_users WHERE id = ? LIMIT 1', [session.userId]);
  if (rows.length === 0) {
    tokenStore.delete(token);
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.user = rows[0];
  req.authToken = token;
  next();
};

const adminRequired = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
};

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: 'missing credentials' });
    const [rows] = await pool.query('SELECT id, username, role, password_hash FROM ems_users WHERE username = ? LIMIT 1', [username]);
    if (rows.length === 0) return res.status(401).json({ error: 'invalid credentials' });
    const user = rows[0];
    if (user.password_hash !== hashPassword(password)) return res.status(401).json({ error: 'invalid credentials' });
    const token = crypto.randomBytes(24).toString('hex');
    tokenStore.set(token, { userId: user.id, createdAt: Date.now() });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role } });
});

app.post('/api/auth/logout', authRequired, async (req, res) => {
  tokenStore.delete(req.authToken);
  res.json({ ok: true });
});

app.get('/api/users', authRequired, adminRequired, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, role, created_at FROM ems_users ORDER BY id ASC');
    res.json({ users: rows.map(r => ({ id: r.id, username: r.username, role: r.role, createdAt: new Date(r.created_at).toISOString() })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users', authRequired, adminRequired, async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'operator').trim() || 'operator';
    if (!username || !password) return res.status(400).json({ error: 'missing username or password' });
    await pool.query(
      'INSERT INTO ems_users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hashPassword(password), role]
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/users/:id', authRequired, adminRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid user id' });
    if (id === req.user.id) return res.status(400).json({ error: 'cannot delete current user' });
    await pool.query('DELETE FROM ems_users WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/save-all', authRequired, async (req, res) => {
  try {
    const payload = req.body?.payload;
    if (!payload) return res.status(400).json({ error: 'payload required' });
    const id = Date.now();
    const savedAt = new Date();
    await pool.query(
      'INSERT INTO ems_records (id, saved_at, payload) VALUES (?, ?, ?)',
      [id, savedAt, JSON.stringify(payload)]
    );
    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/load-latest', authRequired, async (req, res) => {
  try {
    const record = await getLatestRecord();
    if (!record) return res.status(404).json({ error: 'no latest data' });
    res.json(record);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, saved_at FROM ems_records ORDER BY id DESC LIMIT 200');
    res.json({ items: rows.map(r => ({ id: String(r.id), savedAt: new Date(r.saved_at).toISOString() })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history/:id', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, saved_at, payload FROM ems_records WHERE id = ? LIMIT 1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'record not found' });
    const row = rows[0];
    res.json({
      id: row.id,
      savedAt: new Date(row.saved_at).toISOString(),
      payload: JSON.parse(row.payload),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/download/invigilator.xlsx', authRequired, async (req, res) => {
  try {
    const latest = await getLatestRecord();
    if (!latest) return res.status(404).json({ error: 'no latest data' });
    const payload = latest.payload || {};
    const invResult = payload.invResult || [];
    const invTeachers = payload.invTeachers || [];
    const teacherMap = new Map(invTeachers.map(t => [t.id, t]));
    const rows = invResult.map(r => ({
      考试名称: r.examName,
      学科: r.subject,
      开始时间: r.startTime,
      结束时间: r.endTime,
      考场: r.roomNo,
      监考安排: (r.invigilatorIds || []).map(id => teacherMap.get(id)?.name || '未分配').join('、')
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '监考总表');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="invigilator.xlsx"');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/download/seat.xlsx', authRequired, async (req, res) => {
  try {
    const latest = await getLatestRecord();
    if (!latest) return res.status(404).json({ error: 'no latest data' });
    const payload = latest.payload || {};
    const rows = (payload.arrangementResult || []).map(r => ({
      考号: r.examNumber,
      姓名: r.name,
      班级: r.class,
      考场: r.classroomName,
      考场号: r.classroomNumber,
      座位号: r.seatNumber
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '考场编排');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="seat.xlsx"');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use(express.static(projectRoot));

app.get('/', (req, res) => {
  res.sendFile(path.resolve(projectRoot, '考场编排系统（原始文件） .html'));
});

const port = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`EMS backend running at http://localhost:${port}`);
      console.log(`MariaDB: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`);
    });
  })
  .catch((error) => {
    console.error('MariaDB init failed:', error.message);
    process.exit(1);
  });
