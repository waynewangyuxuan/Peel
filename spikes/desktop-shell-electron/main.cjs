const { app, BrowserWindow, shell } = require("electron");
const { resolve } = require("node:path");
const { runAppServerHandshake } = require("./app-server-probe.cjs");

const repoRoot = resolve(__dirname, "../..");
const demoPath = resolve(repoRoot, "docs/product/source/peel-demo-v0-original.html");
const autoQuit = process.env.PEEL_SPIKE_AUTO_QUIT === "1";

let mainWindow;

async function verifyShell(window) {
  const surface = await window.webContents.executeJavaScript(
    `({
      title: document.title,
      focus: Boolean(document.querySelector('#focusStage')),
      overview: Boolean(document.querySelector('#overviewStage')),
      composer: Boolean(document.querySelector('#composerInput'))
    })`,
    true,
  );
  if (!surface.focus || !surface.overview || !surface.composer) {
    throw new Error(`Preserved Demo surface did not load correctly: ${JSON.stringify(surface)}`);
  }

  const handshake = await runAppServerHandshake({ cwd: repoRoot });
  const result = { ok: true, surface, handshake };
  window.setTitle("Peel Shell Spike — Codex ready");
  process.stdout.write(`PEEL_SHELL_SPIKE_RESULT ${JSON.stringify(result)}\n`);
  return result;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: !autoQuit,
    title: "Peel Desktop Shell Spike",
    backgroundColor: "#e9e9e6",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== `file://${demoPath}`) event.preventDefault();
  });

  await mainWindow.loadFile(demoPath);
  try {
    await verifyShell(mainWindow);
    if (autoQuit) app.quit();
  } catch (error) {
    process.stderr.write(`PEEL_SHELL_SPIKE_ERROR ${error.stack || error.message}\n`);
    app.exit(1);
  }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

