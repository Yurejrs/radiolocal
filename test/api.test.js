const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('smoke: servidor sobe e expõe health/schema', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiostore-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV:'test', PORT:'3187', RADIO_DATA_DIR:dir }, stdio:'ignore' });
  try { for(let i=0;i<30;i++){ try{ const res=await fetch('http://127.0.0.1:3187/api/health'); if(res.ok){assert.deepEqual(await res.json(),{ok:true,service:'radiostore'}); break;} }catch{} await new Promise(r=>setTimeout(r,100)); } assert.equal(fs.existsSync(path.join(dir,'radiostore.db')),true); }
  finally { child.kill('SIGTERM'); }
});

function wavFixture(frequency = 440) {
  const sampleRate = 8000; const samples = 800; const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / sampleRate) * 12000), i * 2);
  const header = Buffer.alloc(44); header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40); return Buffer.concat([header, data]);
}

async function waitForHealth(port) {
  for (let i = 0; i < 40; i++) { try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Servidor não iniciou a tempo.');
}

async function authenticate(base) {
  const setup = await fetch(`${base}/api/auth/setup`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ password:'senha-segura-123', confirmation:'senha-segura-123' }) });
  assert.equal(setup.status, 201);
  const login = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ username:'radio', password:'senha-segura-123' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return (url, options = {}) => fetch(url, { ...options, headers:{ ...(options.headers || {}), cookie } });
}

test('autenticação exige configuração inicial e protege a operação', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiostore-auth-')); const port = 3186; const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV:'test', PORT:String(port), RADIO_DATA_DIR:dir }, stdio:'ignore' });
  try {
    await waitForHealth(port);
    const publicPage = await fetch(base); assert.equal(publicPage.status, 200); assert.match(await publicPage.text(), /Criar acesso|Entrar na rádio/);
    const status = await (await fetch(`${base}/api/auth/status`)).json(); assert.equal(status.configured, false); assert.equal(status.authenticated, false);
    assert.equal((await fetch(`${base}/api/tracks`)).status, 401);
    const setup = await fetch(`${base}/api/auth/setup`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({password:'senha-segura-123',confirmation:'senha-segura-123'}) }); assert.equal(setup.status, 201);
    assert.equal((await fetch(`${base}/api/auth/setup`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({password:'outra-senha-123',confirmation:'outra-senha-123'}) })).status, 409);
    assert.equal((await fetch(`${base}/api/auth/login`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({username:'radio',password:'errada-123'}) })).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({username:'radio',password:'senha-segura-123'}) }); assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/tracks`, {headers:{cookie}})).status, 200);
    assert.equal((await fetch(`${base}/api/auth/logout`, {method:'POST',headers:{cookie}})).status, 200);
    assert.equal((await fetch(`${base}/api/tracks`, {headers:{cookie}})).status, 401);
  } finally { child.kill('SIGTERM'); }
});

test('upload aceita múltiplos arquivos e reporta falhas parciais', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiostore-upload-')); const port = 3188;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), RADIO_DATA_DIR: dir }, stdio: 'ignore' });
  try {
    await waitForHealth(port); const authFetch = await authenticate(`http://127.0.0.1:${port}`);
    const batch = new FormData(); batch.append('file', new Blob([wavFixture(440)], { type: 'audio/wav' }), 'primeira.wav'); batch.append('file', new Blob([wavFixture(660)], { type: 'audio/wav' }), 'segunda.wav'); batch.append('file', new Blob([wavFixture(880)], { type: 'audio/wav' }), 'terceira.wav'); batch.append('type', 'music');
    const response = await authFetch(`http://127.0.0.1:${port}/api/upload`, { method: 'POST', body: batch }); const data = await response.json();
    assert.equal(response.status, 201); assert.equal(data.tracks.length, 3); assert.equal((await (await authFetch(`http://127.0.0.1:${port}/api/tracks`)).json()).length, 3);

    const partial = new FormData(); partial.append('file', new Blob([wavFixture(220)], { type: 'audio/wav' }), 'quarta.wav'); partial.append('file', new Blob(['não é áudio'], { type: 'text/plain' }), 'invalido.txt'); partial.append('type', 'music');
    const partialResponse = await authFetch(`http://127.0.0.1:${port}/api/upload`, { method: 'POST', body: partial }); const partialData = await partialResponse.json();
    assert.equal(partialResponse.status, 207); assert.equal(partialData.tracks.length, 1); assert.equal(partialData.errors.length, 1); assert.match(partialData.errors[0].filename, /invalido/);
  } finally { child.kill('SIGTERM'); }
});

test('categorias de anúncios têm CRUD e associação protegida', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiostore-categories-')); const port = 3189;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), RADIO_DATA_DIR: dir }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(port); const authFetch = await authenticate(base);
    assert.equal((await fetch(`${base}/api/categories`)).status, 401);
    const create = await authFetch(`${base}/api/categories`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ name:'Institucional', priority_weight:35 }) });
    assert.equal(create.status, 201); const category = await create.json(); assert.equal(category.name, 'Institucional'); assert.equal(category.track_count, 0);
    const duplicate = await authFetch(`${base}/api/categories`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ name:'institucional', priority_weight:20 }) }); assert.equal(duplicate.status, 409);
    const update = await authFetch(`${base}/api/categories/${category.id}`, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({ name:'Institucional e serviços', priority_weight:45 }) }); assert.equal(update.status, 200); assert.equal((await update.json()).priority_weight, 45);
    const body = new FormData(); body.append('file', new Blob([wavFixture(500)], {type:'audio/wav'}), 'anuncio.wav'); body.append('type','ad'); body.append('category_id',String(category.id));
    const upload = await authFetch(`${base}/api/upload`, {method:'POST', body}); assert.equal(upload.status, 201); const track = (await upload.json()).track;
    const categories = await (await authFetch(`${base}/api/categories`)).json(); assert.equal(categories.find(item=>item.id===category.id).track_count, 1);
    const blocked = await authFetch(`${base}/api/categories/${category.id}`, {method:'DELETE'}); assert.equal(blocked.status, 409);
    const unassign = await authFetch(`${base}/api/tracks/${track.id}/category`, {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({category_id:''})}); const unassigned = await unassign.json(); assert.equal(unassign.status, 200); assert.equal(unassigned.category_id, null); assert.match(unassigned.url, /^\/audio\//);
    const musicBody = new FormData(); musicBody.append('file', new Blob([wavFixture(700)], {type:'audio/wav'}), 'musica.wav'); musicBody.append('type','music'); const musicUpload = await authFetch(`${base}/api/upload`, {method:'POST',body:musicBody}); const musicTrack = (await musicUpload.json()).track;
    const invalidMusicAssociation = await authFetch(`${base}/api/tracks/${musicTrack.id}/category`, {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({category_id:category.id})}); assert.equal(invalidMusicAssociation.status, 400);
  } finally { child.kill('SIGTERM'); }
});
