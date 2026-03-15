const express = require('express')
const { DatabaseSync } = require('node:sqlite')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const os = require('os')
const QRCode = require('qrcode')
const crypto = require('crypto')

const app = express()
const PORT = process.env.PORT || 3737

// ─── DB 초기화 ────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = path.join(DATA_DIR, 'cowork.db')
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT 'Untitled Board',
    description TEXT NOT NULL DEFAULT '',
    columns     TEXT NOT NULL DEFAULT '[]',
    master_password TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rows (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    member_name TEXT NOT NULL DEFAULT '',
    member_id   TEXT NOT NULL DEFAULT '',
    data        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id            TEXT PRIMARY KEY,
    row_id        TEXT NOT NULL REFERENCES rows(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL,
    size          INTEGER NOT NULL DEFAULT 0,
    uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// ─── 파일 업로드 설정 ─────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext}`)
  }
})
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }) // 50MB

// ─── 미들웨어 ─────────────────────────────────────────────────────────────────

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// ─── SSE 클라이언트 관리 ──────────────────────────────────────────────────────

const sseClients = new Map() // boardId → Set<res>

function notifyBoard(boardId) {
  const clients = sseClients.get(boardId)
  if (!clients) return
  const data = `data: update\n\n`
  for (const res of clients) {
    try { res.write(data) } catch {}
  }
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

function getLocalIP() {
  const interfaces = os.networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) return info.address
    }
  }
  return '127.0.0.1'
}

function verifyMaster(boardId, password) {
  const board = db.prepare('SELECT master_password FROM boards WHERE id = ?').get(boardId)
  return board && board.master_password === password
}

// ─── API: 보드 ────────────────────────────────────────────────────────────────

// 보드 생성 (Master)
app.post('/api/boards', (req, res) => {
  const { title, description, columns, master_password } = req.body
  if (!master_password) return res.status(400).json({ error: 'master_password required' })

  const id = newId()
  db.prepare(`
    INSERT INTO boards (id, title, description, columns, master_password)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, title || 'Untitled Board', description || '', JSON.stringify(columns || []), master_password)

  res.json({ id })
})

// 보드 정보 조회
app.get('/api/boards/:id', (req, res) => {
  const board = db.prepare('SELECT id, title, description, columns, created_at FROM boards WHERE id = ?')
    .get(req.params.id)
  if (!board) return res.status(404).json({ error: 'Board not found' })
  board.columns = JSON.parse(board.columns)
  res.json(board)
})

// 보드 수정 (Master 전용)
app.put('/api/boards/:id', (req, res) => {
  const { title, description, columns, master_password } = req.body
  if (!verifyMaster(req.params.id, master_password))
    return res.status(403).json({ error: 'Invalid master password' })

  db.prepare(`
    UPDATE boards SET title = ?, description = ?, columns = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(title, description, JSON.stringify(columns), req.params.id)

  notifyBoard(req.params.id)
  res.json({ ok: true })
})

// ─── API: 행 ──────────────────────────────────────────────────────────────────

// 전체 행 + 파일 조회
app.get('/api/boards/:id/rows', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, GROUP_CONCAT(
      f.id || '|' || f.original_name || '|' || f.stored_name || '|' || f.size, ';;'
    ) AS files_raw
    FROM rows r
    LEFT JOIN files f ON f.row_id = r.id
    WHERE r.board_id = ?
    GROUP BY r.id
    ORDER BY r.created_at ASC
  `).all(req.params.id)

  const result = rows.map(row => ({
    ...row,
    data: JSON.parse(row.data),
    files: row.files_raw
      ? row.files_raw.split(';;').map(f => {
          const [id, original_name, stored_name, size] = f.split('|')
          return { id, original_name, stored_name, size: Number(size), url: `/uploads/${stored_name}` }
        })
      : []
  }))
  delete result.forEach(r => delete r.files_raw)
  result.forEach(r => delete r.files_raw)

  res.json(result)
})

// 행 추가 (Master 전용)
app.post('/api/boards/:id/rows', (req, res) => {
  const { member_name, member_id, master_password } = req.body
  if (!verifyMaster(req.params.id, master_password))
    return res.status(403).json({ error: 'Invalid master password' })

  const rowId = newId()
  db.prepare(`
    INSERT INTO rows (id, board_id, member_name, member_id, data)
    VALUES (?, ?, ?, ?, '{}')
  `).run(rowId, req.params.id, member_name || '', member_id || '')

  notifyBoard(req.params.id)
  res.json({ id: rowId })
})

// 행 삭제 (Master 전용)
app.delete('/api/boards/:id/rows/:rowId', (req, res) => {
  const { master_password } = req.body
  if (!verifyMaster(req.params.id, master_password))
    return res.status(403).json({ error: 'Invalid master password' })

  // 첨부파일도 삭제
  const files = db.prepare('SELECT stored_name FROM files WHERE row_id = ?').all(req.params.rowId)
  for (const f of files) {
    try { fs.unlinkSync(path.join(__dirname, 'uploads', f.stored_name)) } catch {}
  }
  db.prepare('DELETE FROM rows WHERE id = ? AND board_id = ?').run(req.params.rowId, req.params.id)

  notifyBoard(req.params.id)
  res.json({ ok: true })
})

// 행 데이터 수정 (Member — 자기 행만)
app.put('/api/boards/:id/rows/:rowId', (req, res) => {
  const { data, master_password } = req.body

  // master이거나, 해당 row가 이 board에 속하는지만 확인 (member는 패스워드 없이 rowId로)
  const row = db.prepare('SELECT id FROM rows WHERE id = ? AND board_id = ?')
    .get(req.params.rowId, req.params.id)
  if (!row) return res.status(404).json({ error: 'Row not found' })

  db.prepare(`
    UPDATE rows SET data = ?, updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(data), req.params.rowId)

  notifyBoard(req.params.id)
  res.json({ ok: true })
})

// ─── API: 파일 업로드 ─────────────────────────────────────────────────────────

app.post('/api/boards/:id/rows/:rowId/files', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  const row = db.prepare('SELECT id FROM rows WHERE id = ? AND board_id = ?')
    .get(req.params.rowId, req.params.id)
  if (!row) return res.status(404).json({ error: 'Row not found' })

  const fileId = newId()
  db.prepare(`
    INSERT INTO files (id, row_id, original_name, stored_name, size)
    VALUES (?, ?, ?, ?, ?)
  `).run(fileId, req.params.rowId, req.file.originalname, req.file.filename, req.file.size)

  notifyBoard(req.params.id)
  res.json({
    id: fileId,
    original_name: req.file.originalname,
    stored_name: req.file.filename,
    url: `/uploads/${req.file.filename}`
  })
})

// 파일 삭제
app.delete('/api/boards/:id/rows/:rowId/files/:fileId', (req, res) => {
  const file = db.prepare(`
    SELECT f.stored_name FROM files f
    JOIN rows r ON r.id = f.row_id
    WHERE f.id = ? AND r.board_id = ?
  `).get(req.params.fileId, req.params.id)

  if (!file) return res.status(404).json({ error: 'File not found' })

  try { fs.unlinkSync(path.join(__dirname, 'uploads', file.stored_name)) } catch {}
  db.prepare('DELETE FROM files WHERE id = ?').run(req.params.fileId)

  notifyBoard(req.params.id)
  res.json({ ok: true })
})

// ─── API: SSE ─────────────────────────────────────────────────────────────────

app.get('/api/boards/:id/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const boardId = req.params.id
  if (!sseClients.has(boardId)) sseClients.set(boardId, new Set())
  sseClients.get(boardId).add(res)

  // 연결 확인 ping
  res.write('data: connected\n\n')

  req.on('close', () => {
    sseClients.get(boardId)?.delete(res)
  })
})

// ─── API: QR 코드 ─────────────────────────────────────────────────────────────

app.get('/api/boards/:id/qr', async (req, res) => {
  const ip = getLocalIP()
  const url = `http://${ip}:${PORT}/board.html?id=${req.params.id}`
  try {
    const qr = await QRCode.toDataURL(url, { width: 200, margin: 1 })
    res.json({ url, qr })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── CSV 내보내기 (Master) ────────────────────────────────────────────────────

app.get('/api/boards/:id/export', (req, res) => {
  if (!verifyMaster(req.params.id, req.query.master_password))
    return res.status(403).json({ error: 'Invalid master password' })

  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id)
  const columns = JSON.parse(board.columns)
  const rows = db.prepare(`
    SELECT r.member_name, r.member_id, r.data,
      GROUP_CONCAT(f.original_name, ', ') AS file_names
    FROM rows r
    LEFT JOIN files f ON f.row_id = r.id
    WHERE r.board_id = ?
    GROUP BY r.id
    ORDER BY r.created_at ASC
  `).all(req.params.id)

  const headers = ['이름', 'ID', ...columns.map(c => c.label), '첨부파일']
  const csvRows = rows.map(row => {
    const data = JSON.parse(row.data)
    const vals = [row.member_name, row.member_id, ...columns.map(c => data[c.key] || ''), row.file_names || '']
    return vals.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  })

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="board_${req.params.id}.csv"`)
  res.send('\uFEFF' + [headers.join(','), ...csvRows].join('\r\n'))
})

// ─── 페이지 라우팅 ────────────────────────────────────────────────────────────

app.get('/board.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'board.html'))
})
app.get('/master.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'master.html'))
})

// ─── 서버 시작 ────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP()
  console.log('')
  console.log('┌─────────────────────────────────────────────┐')
  console.log('│           CoworkBoard 서버 시작              │')
  console.log('├─────────────────────────────────────────────┤')
  console.log(`│  Master  http://${ip}:${PORT}/master.html`.padEnd(46) + '│')
  console.log(`│  로컬    http://localhost:${PORT}/master.html`.padEnd(46) + '│')
  console.log('│                                             │')
  console.log('│  보드 URL은 Master 화면에서 확인/공유하세요  │')
  console.log('└─────────────────────────────────────────────┘')
  console.log('')
})
