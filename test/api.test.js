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

test('upload aceita múltiplos arquivos e reporta falhas parciais', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiostore-upload-')); const port = 3188;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), RADIO_DATA_DIR: dir }, stdio: 'ignore' });
  try {
    await waitForHealth(port);
    const batch = new FormData(); batch.append('file', new Blob([wavFixture(440)], { type: 'audio/wav' }), 'primeira.wav'); batch.append('file', new Blob([wavFixture(660)], { type: 'audio/wav' }), 'segunda.wav'); batch.append('file', new Blob([wavFixture(880)], { type: 'audio/wav' }), 'terceira.wav'); batch.append('type', 'music');
    const response = await fetch(`http://127.0.0.1:${port}/api/upload`, { method: 'POST', body: batch }); const data = await response.json();
    assert.equal(response.status, 201); assert.equal(data.tracks.length, 3); assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/tracks`)).json()).length, 3);

    const partial = new FormData(); partial.append('file', new Blob([wavFixture(220)], { type: 'audio/wav' }), 'quarta.wav'); partial.append('file', new Blob(['não é áudio'], { type: 'text/plain' }), 'invalido.txt'); partial.append('type', 'music');
    const partialResponse = await fetch(`http://127.0.0.1:${port}/api/upload`, { method: 'POST', body: partial }); const partialData = await partialResponse.json();
    assert.equal(partialResponse.status, 207); assert.equal(partialData.tracks.length, 1); assert.equal(partialData.errors.length, 1); assert.match(partialData.errors[0].filename, /invalido/);
  } finally { child.kill('SIGTERM'); }
});
