const { app, BrowserWindow } = require('electron');
// Isolated renderer fixture: no preload, account database, API calls or real tasks.
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await window.loadURL(process.env.RH_UI_TEST_URL || 'http://127.0.0.1:4174/tests/performance.html');
    const deadline = Date.now() + 30000;
    let title;
    do {
      title = await window.webContents.executeJavaScript('document.title');
      if (title === 'PASS' || title === 'FAIL') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    console.log(await window.webContents.executeJavaScript('document.getElementById("result").textContent'));
    app.exit(title === 'PASS' ? 0 : 1);
  } catch (error) { console.error(error); app.exit(1); }
});
