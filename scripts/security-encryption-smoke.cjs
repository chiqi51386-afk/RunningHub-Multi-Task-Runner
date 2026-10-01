const { app, safeStorage } = require('electron');
app.whenReady().then(async () => {
  const { SystemSecretStore } = await import('../dist/src/core/secureSecrets.js');
  const store = new SystemSecretStore(safeStorage);
  const value = 'synthetic-security-test';
  if (store.decrypt(store.encrypt(value)) !== value) throw new Error('Roundtrip failed');
  console.log('OS_ENCRYPTION_ROUNDTRIP_PASS');
  app.quit();
}).catch(() => { console.error('OS_ENCRYPTION_ROUNDTRIP_FAIL'); app.exit(1); });
