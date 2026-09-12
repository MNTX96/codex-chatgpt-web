const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.PROJECT_NAVIGATION_TEST_ROOT);
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  void window.loadURL("about:blank");
});
