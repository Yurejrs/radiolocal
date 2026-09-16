const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const password = process.argv[2];
const dataDir = process.env.RADIO_DATA_DIR || path.join(__dirname, '..', 'data');
const db = new Database(path.join(dataDir, 'radiostore.db'));

if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
  console.error('Uso: npm run reset-password -- <nova-senha> (a senha deve ter entre 8 e 200 caracteres)');
  process.exitCode = 1;
} else if (!db.prepare('SELECT id FROM auth_users WHERE id=1').get()) {
  console.error('Nenhum administrador configurado. Abra o painel para fazer a configuração inicial.');
  process.exitCode = 1;
} else {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  db.transaction(() => {
    db.prepare('UPDATE auth_users SET password_hash=?, password_salt=?, updated_at=CURRENT_TIMESTAMP WHERE id=1').run(hash, salt);
    db.prepare('DELETE FROM auth_sessions').run();
  })();
  console.log('Senha redefinida. As sessões anteriores foram encerradas.');
}
db.close();
