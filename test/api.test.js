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
