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
`);

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

const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
app.register(multipart, { limits: { fileSize: 250 * 1024 * 1024, files: 20 } });
app.register(fastifyStatic, { root: path.join(ROOT, 'public'), prefix: '/' });
app.register(fastifyStatic, { root: AUDIO_DIR, prefix: '/audio/', decorateReply: false });

app.get('/api/health', async () => ({ ok: true, service: 'radiostore' }));
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
