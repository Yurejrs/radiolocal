const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Fastify = require('fastify');
const multipart = require('@fastify/multipart');
const fastifyStatic = require('@fastify/static');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const DATA_DIR = process.env.RADIO_DATA_DIR || path.join(ROOT, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const DB_PATH = path.join(DATA_DIR, 'radiostore.db');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const startedAt = Date.now();
const history = { music: [], ad: [] };
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac']);
const SESSION_COOKIE = 'radiostore_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();

fs.mkdirSync(AUDIO_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('music','ad')),
    priority_weight INTEGER NOT NULL DEFAULT 10
  );
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT 'Artista desconhecido',
    file_path TEXT NOT NULL,
    duration REAL NOT NULL DEFAULT 0,
    type TEXT NOT NULL CHECK(type IN ('music','ad')),
    category_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(category_id) REFERENCES categories(id)
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS playback_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(track_id) REFERENCES tracks(id)
  );
  CREATE TABLE IF NOT EXISTS auth_users (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);
db.prepare("UPDATE auth_users SET username='radio' WHERE id=1 AND username='admin'").run();

const seed = db.prepare('INSERT INTO categories (name, type, priority_weight) VALUES (?, ?, ?)');
const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
if (!count) {
  seed.run('Alta', 'ad', 70); seed.run('Média', 'ad', 20); seed.run('Baixa', 'ad', 10);
  seed.run('Músicas', 'music', 100);
}
const putSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
putSetting.run('music_before_ad', '3');
putSetting.run('uptime_started_at', new Date().toISOString());

function safeName(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'audio';
}
function titleFrom(filename) { return path.basename(filename, path.extname(filename)).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Áudio sem título'; }
function validateUploadFile(file) {
  const filename = String(file.filename || '').trim();
  const ext = path.extname(filename).toLowerCase();
  if (!filename) throw new Error('O arquivo não possui um nome válido.');
  if (!AUDIO_EXTENSIONS.has(ext)) throw new Error(`Formato não suportado (${ext || 'sem extensão'}).`);
  if (!file.buffer?.length) throw new Error('O arquivo está vazio.');
}
function categoryPayload(body) {
  const name = String(body?.name || '').trim();
  const priority = Number(body?.priority_weight);
  if (!name) throw new Error('Informe um nome para a categoria.');
  if (name.length > 60) throw new Error('O nome da categoria deve ter no máximo 60 caracteres.');
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new Error('A prioridade deve ser um inteiro entre 0 e 100.');
  return { name, priority };
}
function ffmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-i', input, '-af', 'loudnorm=I=-14:TP=-1:LRA=11', '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error += data.toString(); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(error.slice(-600) || `FFmpeg saiu com código ${code}`)));
  });
}
function probeDuration(input) {
  return new Promise((resolve) => {
    const child = spawn(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; child.stdout.on('data', data => { output += data.toString(); });
    child.on('close', () => resolve(Number.isFinite(Number(output.trim())) ? Number(output.trim()) : 0));
    child.on('error', () => resolve(0));
  });
}
function setting(key) { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value; }
function randomWeighted(items) {
  const total = items.reduce((sum, item) => sum + Math.max(0, Number(item.priority_weight || 0)), 0);
  if (!total) return items[Math.floor(Math.random() * items.length)];
  let cursor = Math.random() * total;
  for (const item of items) { cursor -= Math.max(0, Number(item.priority_weight || 0)); if (cursor <= 0) return item; }
  return items.at(-1);
}
function candidates(type) {
  const all = db.prepare(`SELECT t.*, c.name AS category_name, c.priority_weight FROM tracks t LEFT JOIN categories c ON c.id=t.category_id WHERE t.type=? ORDER BY RANDOM()`).all(type);
  const fresh = all.filter(t => !history[type].includes(t.id));
  return fresh.length ? fresh : all;
}
function chooseNext(type) {
  const items = candidates(type);
  if (!items.length) return null;
  const selected = type === 'ad' ? randomWeighted(items) : items[0];
  history[type].push(selected.id); if (history[type].length > 10) history[type].shift();
  db.prepare('INSERT INTO playback_history (track_id) VALUES (?)').run(selected.id);
  return { ...selected, url: `/audio/${encodeURIComponent(path.basename(selected.file_path))}` };
}
function normalizeTrack(row) { return row ? { ...row, url: `/audio/${encodeURIComponent(path.basename(row.file_path))}` } : row; }

function hashSessionToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function passwordHash(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(derived.toString('hex'))));
}
async function makePasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: await passwordHash(password, salt) };
}
function validPassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 200; }
function authConfigured() { return Boolean(db.prepare('SELECT id FROM auth_users WHERE id=1').get()); }
function cookieValue(request) {
  const cookies = String(request.headers.cookie || '').split(';').map(item => item.trim());
  const entry = cookies.find(item => item.startsWith(`${SESSION_COOKIE}=`));
  return entry ? decodeURIComponent(entry.slice(SESSION_COOKIE.length + 1)) : '';
}
function currentUser(request) {
  const token = cookieValue(request); if (!token) return null;
  const now = new Date();
  const session = db.prepare('SELECT username, expires_at FROM auth_sessions WHERE token_hash=?').get(hashSessionToken(token));
  if (!session || new Date(session.expires_at) <= now) {
    if (session) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hashSessionToken(token));
    return null;
  }
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('UPDATE auth_sessions SET last_seen_at=?, expires_at=? WHERE token_hash=?').run(now.toISOString(), expires, hashSessionToken(token));
  return { username: session.username };
}
function setSessionCookie(reply, token, maxAge = SESSION_TTL_MS / 1000) {
  reply.header('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge)}`);
}
function clearSessionCookie(reply) { setSessionCookie(reply, '', 0); }
function loginKey(request) { return request.ip || request.headers['x-forwarded-for'] || 'unknown'; }
function loginBlocked(request) {
  const entry = loginAttempts.get(loginKey(request));
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) { loginAttempts.delete(loginKey(request)); return false; }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}
function recordLoginFailure(request) {
  const key = loginKey(request); const current = loginAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) loginAttempts.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else current.count += 1;
}
function clearLoginFailures(request) { loginAttempts.delete(loginKey(request)); }
function publicPage(file) { return fs.createReadStream(path.join(ROOT, 'public', file)); }

const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
app.register(multipart, { limits: { fileSize: 250 * 1024 * 1024, files: 20 } });
app.addHook('onRequest', async (request, reply) => {
  const pathname = request.url.split('?')[0];
  const publicApi = ['/api/health', '/api/auth/status', '/api/auth/setup', '/api/auth/login'];
  const protectedPath = pathname.startsWith('/audio/') || (pathname.startsWith('/api/') && !publicApi.includes(pathname)) || pathname === '/index.html';
  if (protectedPath && !currentUser(request)) {
    if (pathname.startsWith('/api/') || pathname.startsWith('/audio/')) return reply.code(401).send({ error: 'Autenticação necessária.' });
    return reply.redirect('/');
  }
});
app.get('/', async (request, reply) => {
  return reply.type('text/html').send(publicPage(currentUser(request) ? 'index.html' : 'login.html'));
});
app.register(fastifyStatic, { root: path.join(ROOT, 'public'), prefix: '/' });
app.register(fastifyStatic, { root: AUDIO_DIR, prefix: '/audio/', decorateReply: false });

app.get('/api/health', async () => ({ ok: true, service: 'radiostore' }));
app.get('/api/auth/status', async request => ({ configured: authConfigured(), authenticated: Boolean(currentUser(request)), user: currentUser(request)?.username || null }));
app.post('/api/auth/setup', async (request, reply) => {
  if (authConfigured()) return reply.code(409).send({ error: 'A configuração inicial já foi concluída.' });
  const password = request.body?.password; const confirmation = request.body?.confirmation;
  if (!validPassword(password)) return reply.code(400).send({ error: 'A senha deve ter entre 8 e 200 caracteres.' });
  if (password !== confirmation) return reply.code(400).send({ error: 'A confirmação da senha não confere.' });
  const record = await makePasswordRecord(password);
  db.prepare('INSERT INTO auth_users (id, username, password_hash, password_salt) VALUES (1,?,?,?)').run('radio', record.hash, record.salt);
  return reply.code(201).send({ configured: true });
});
app.post('/api/auth/login', async (request, reply) => {
  if (!authConfigured()) return reply.code(409).send({ error: 'Configure a senha de administrador antes de entrar.' });
  if (loginBlocked(request)) return reply.code(429).send({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
  const username = String(request.body?.username || '').trim(); const password = request.body?.password;
  const user = db.prepare('SELECT * FROM auth_users WHERE username=?').get(username);
  const computedHash = user && validPassword(password) ? await passwordHash(password, user.password_salt) : '';
  const storedBuffer = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(0);
  const computedBuffer = Buffer.from(computedHash, 'hex');
  const valid = Boolean(user && storedBuffer.length === computedBuffer.length && crypto.timingSafeEqual(storedBuffer, computedBuffer));
  if (!valid) { recordLoginFailure(request); return reply.code(401).send({ error: 'Usuário ou senha inválidos.' }); }
  clearLoginFailures(request);
  const token = crypto.randomBytes(32).toString('base64url'); const now = new Date(); const expires = new Date(Date.now() + SESSION_TTL_MS);
  db.prepare('INSERT INTO auth_sessions (token_hash, username, last_seen_at, expires_at) VALUES (?,?,?,?)').run(hashSessionToken(token), user.username, now.toISOString(), expires.toISOString());
  setSessionCookie(reply, token); return { authenticated: true, user: user.username };
});
app.post('/api/auth/logout', async (request, reply) => {
  const token = cookieValue(request); if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hashSessionToken(token));
  clearSessionCookie(reply); return { authenticated: false };
});
app.get('/api/tracks', async () => db.prepare(`SELECT t.*, c.name AS category_name, c.priority_weight FROM tracks t LEFT JOIN categories c ON c.id=t.category_id ORDER BY t.created_at DESC`).all().map(normalizeTrack));
app.delete('/api/tracks/:id', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: 'Identificador de faixa inválido.' });
  const track = db.prepare('SELECT id, file_path FROM tracks WHERE id=?').get(id);
  if (!track) return reply.code(404).send({ error: 'Faixa não encontrada.' });
  const remove = db.transaction(() => { db.prepare('DELETE FROM playback_history WHERE track_id=?').run(id); db.prepare('DELETE FROM tracks WHERE id=?').run(id); });
  remove();
  await fsp.rm(track.file_path, { force: true });
  history.music = history.music.filter(item => item !== id); history.ad = history.ad.filter(item => item !== id);
  return reply.code(204).send();
});
app.get('/api/categories', async () => db.prepare(`SELECT c.*, COUNT(t.id) AS track_count FROM categories c LEFT JOIN tracks t ON t.category_id=c.id GROUP BY c.id ORDER BY c.type, c.priority_weight DESC, c.name COLLATE NOCASE`).all());
app.post('/api/categories', async (request, reply) => {
  let payload; try { payload = categoryPayload(request.body); } catch (error) { return reply.code(400).send({ error: error.message }); }
  if (db.prepare('SELECT id FROM categories WHERE type=? AND name COLLATE NOCASE=?').get('ad', payload.name)) return reply.code(409).send({ error: 'Já existe uma categoria de anúncio com esse nome.' });
  const result = db.prepare('INSERT INTO categories (name,type,priority_weight) VALUES (?,\'ad\',?)').run(payload.name, payload.priority);
  return reply.code(201).send(db.prepare('SELECT *, 0 AS track_count FROM categories WHERE id=?').get(result.lastInsertRowid));
});
app.put('/api/categories/:id', async (request, reply) => {
  const id = Number(request.params.id); const category = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
  if (!Number.isInteger(id) || !category || category.type !== 'ad') return reply.code(404).send({ error: 'Categoria de anúncio não encontrada.' });
  let payload; try { payload = categoryPayload(request.body); } catch (error) { return reply.code(400).send({ error: error.message }); }
  if (db.prepare('SELECT id FROM categories WHERE type=? AND name COLLATE NOCASE=? AND id<>?').get('ad', payload.name, id)) return reply.code(409).send({ error: 'Já existe uma categoria de anúncio com esse nome.' });
  db.prepare('UPDATE categories SET name=?, priority_weight=? WHERE id=?').run(payload.name, payload.priority, id);
  return db.prepare('SELECT c.*, COUNT(t.id) AS track_count FROM categories c LEFT JOIN tracks t ON t.category_id=c.id WHERE c.id=? GROUP BY c.id').get(id);
});
app.delete('/api/categories/:id', async (request, reply) => {
  const id = Number(request.params.id); const category = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
  if (!Number.isInteger(id) || !category || category.type !== 'ad') return reply.code(404).send({ error: 'Categoria de anúncio não encontrada.' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE category_id=?').get(id).n;
  if (count) return reply.code(409).send({ error: `Não é possível excluir “${category.name}”: ${count} anúncio(s) ainda estão associados. Mova-os antes de excluir.` });
  if (db.prepare('SELECT COUNT(*) AS n FROM categories WHERE type=\'ad\'').get().n <= 1) return reply.code(409).send({ error: 'Mantenha pelo menos uma categoria de anúncio disponível.' });
  db.prepare('DELETE FROM categories WHERE id=?').run(id); return reply.code(204).send();
});
app.put('/api/tracks/:id/category', async (request, reply) => {
  const id = Number(request.params.id); const track = db.prepare('SELECT id,type FROM tracks WHERE id=?').get(id);
  if (!Number.isInteger(id) || !track) return reply.code(404).send({ error: 'Faixa não encontrada.' });
  if (track.type !== 'ad') return reply.code(400).send({ error: 'Somente anúncios podem ter categoria alterada.' });
  const rawCategoryId = request.body?.category_id;
  if (rawCategoryId === '' || rawCategoryId === null || rawCategoryId === undefined) {
    db.prepare('UPDATE tracks SET category_id=NULL WHERE id=?').run(id);
  } else {
    const categoryId = Number(rawCategoryId); const category = db.prepare('SELECT id FROM categories WHERE id=? AND type=\'ad\'').get(categoryId);
    if (!category) return reply.code(400).send({ error: 'Categoria de anúncio inválida.' });
    db.prepare('UPDATE tracks SET category_id=? WHERE id=?').run(categoryId, id);
  }
  return normalizeTrack(db.prepare(`SELECT t.*, c.name AS category_name, c.priority_weight FROM tracks t LEFT JOIN categories c ON c.id=t.category_id WHERE t.id=?`).get(id));
});
app.get('/api/history', async () => db.prepare(`SELECT h.played_at, t.id, t.title, t.artist, t.type, c.name AS category_name FROM playback_history h JOIN tracks t ON t.id=h.track_id LEFT JOIN categories c ON c.id=t.category_id ORDER BY h.id DESC LIMIT 12`).all());
app.get('/api/settings', async () => ({ music_before_ad: Number(setting('music_before_ad') || 3), uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) }));
app.put('/api/settings', async (request, reply) => {
  const value = Number(request.body?.music_before_ad);
  if (!Number.isInteger(value) || value < 1 || value > 20) return reply.code(400).send({ error: 'A regra deve ser um inteiro entre 1 e 20.' });
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('music_before_ad', String(value));
  return { music_before_ad: value };
});
app.get('/api/queue/next', async (request, reply) => {
  const musicBeforeAd = Number(setting('music_before_ad') || 3);
  const playedMusic = Number(request.query?.played_music || 0);
  const type = playedMusic > 0 && playedMusic % musicBeforeAd === 0 ? 'ad' : 'music';
  const track = chooseNext(type);
  if (!track) return reply.code(404).send({ error: `Nenhum item do tipo ${type === 'ad' ? 'anúncio' : 'música'} disponível.` });
  return { track: normalizeTrack(track), type, played_music: playedMusic, music_before_ad: musicBeforeAd };
});
app.post('/api/upload', async (request, reply) => {
  const fields = {}; const files = [];
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') files.push({ filename: part.filename, buffer: await part.toBuffer() });
      else fields[part.fieldname] = part.value;
    }
  } catch (error) {
    request.log.warn({ err: error }, 'Upload interrompido antes de concluir o lote');
    return reply.code(400).send({ error: 'O envio foi interrompido antes de concluir o lote. Tente novamente.' });
  }
  if (!files.length) return reply.code(400).send({ error: 'Envie pelo menos um arquivo de áudio.' });
  if (fields.type && !['music', 'ad'].includes(fields.type)) return reply.code(400).send({ error: 'Tipo de upload inválido.' });
  const type = fields.type === 'ad' ? 'ad' : 'music';
  const processed = [];
  const errors = [];
  for (const file of files) {
    const ext = '.mp3'; const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`; const raw = path.join(AUDIO_DIR, `${id}-raw-${safeName(file.filename)}`); const output = path.join(AUDIO_DIR, `${id}${ext}`);
    try {
      validateUploadFile(file);
      await fsp.writeFile(raw, file.buffer); await ffmpeg(raw, output); const duration = await probeDuration(output); await fsp.rm(raw, { force: true });
      const category = fields.category_id ? db.prepare('SELECT id FROM categories WHERE id=? AND type=?').get(Number(fields.category_id), type) : db.prepare('SELECT id FROM categories WHERE type=? ORDER BY id LIMIT 1').get(type);
      const info = db.prepare('INSERT INTO tracks (title,artist,file_path,duration,type,category_id) VALUES (?,?,?,?,?,?)').run(fields.title?.trim() || titleFrom(file.filename), fields.artist?.trim() || 'Artista desconhecido', output, duration, type, category?.id || null);
      processed.push(normalizeTrack(db.prepare('SELECT * FROM tracks WHERE id=?').get(info.lastInsertRowid)));
    } catch (error) { await fsp.rm(raw, { force: true }); await fsp.rm(output, { force: true }); errors.push({ filename: file.filename, error: `Não foi possível processar ${file.filename}: ${error.message}` }); }
  }
  if (errors.length && !processed.length) return reply.code(422).send({ error: errors[0].error, errors });
  return reply.code(errors.length ? 207 : 201).send({ tracks: processed, track: processed[0], errors });
});

if (require.main === module) app.listen({ port: PORT, host: HOST }).catch(error => { app.log.error(error); process.exit(1); });
module.exports = { app, db, AUDIO_DIR };
