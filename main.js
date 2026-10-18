const { app, BrowserWindow, session, shell } = require('electron');
const path = require('node:path');

// 打桩：记录所有 shell.openExternal 调用，定位是谁在触发 bitbrowser://
{
  const orig = shell.openExternal;
  shell.openExternal = function (url, ...args) {
    console.log('[dy][openExternal]', String(url).slice(0, 100));
    return orig.call(this, url, ...args);
  };
}

// 去掉 Electron 标识，抖音会检测 UA
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const PARTITION = 'persist:douyin';

// 打包版没有 --no-sandbox 参数，而这个环境的 GPU/沙盒受限（开发时一直手动带参）。
// 写进代码，双击 exe 也能正常起
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    title: '抖音 · 自用版',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      partition: PARTITION,
      backgroundThrottling: false,
    },
  });

  win.webContents.setUserAgent(UA);
  // 直接进推荐流（否则落在「精选」网格页）
  win.loadURL('https://www.douyin.com/?recommend=1');

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // 抖音广告会尝试 location.href = 'bitbrowser://' 之类的自定义协议，
  // 这类导航不走 webRequest，得在 will-navigate / will-redirect 层拦
  const isWebUrl = (u) => !u || /^(https?|wss?|blob|data|about|file|chrome|devtools):/i.test(u);
  const blockCustomProtocol = (event, url) => {
    if (!isWebUrl(url)) {
      console.log('[dy] 已阻止导航到自定义协议:', String(url).slice(0, 80));
      event.preventDefault();
    }
  };
  win.webContents.on('will-navigate', blockCustomProtocol);
  win.webContents.on('will-redirect', blockCustomProtocol);

  // 站外链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 只有普通网页交给系统浏览器；自定义协议（bitbrowser:// 等）直接拦掉，
    // 否则 Windows 会弹「获取打开此链接的应用」，很烦
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });

  // F11 窗口全屏：CDP 派发的按键不会触发 OS 级全屏，必须走 setFullScreen。
  // 顺带在状态变化时通知渲染层，让它有机会重算按钮位置
  const notifyFs = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('dy-fullscreen-changed', win.isFullScreen());
    }
  };
  win.on('enter-full-screen', notifyFs);
  win.on('leave-full-screen', notifyFs);
  win.on('enter-html-full-screen', notifyFs);
  win.on('leave-html-full-screen', notifyFs);
}

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(UA);

  // 拦截自定义协议：抖音广告会尝试打开 bitbrowser:// 之类，
  // 交给系统就会弹「获取打开此链接的应用」，非常烦
  // 只拦真正未知的协议。wss/ws/chrome-extension 等必须放行，
  // 否则弹幕、IM、扩展探测全废
  const SAFE_PROTO = /^(https?|wss?|blob|data|about|file|chrome|chrome-extension|devtools):/i;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const u = details.url || '';
    if (u && !SAFE_PROTO.test(u)) {
      console.log('[dy] 已拦截自定义协议:', u.slice(0, 80));
      return callback({ cancel: true });
    }
    callback({});
  });

  // 拦截下载：抖音页面的「下载抖音精选」等按钮会触发系统下载对话框，
  // 我们没有下载功能，直接拦掉比弹窗更干净
  ses.on('will-download', (event, item) => {
    console.log('[dy] 已拦截下载:', (item.getFilename() || '').slice(0, 80));
    item.cancel();
    event.preventDefault();
  });

  // 屏蔽抖音的埋点上报，减少干扰（可选）
  // ses.webRequest.onBeforeRequest({ urls: ['*://mon.zijieapi.com/*'] }, (d, cb) => cb({ cancel: true }));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 全局拦截：挂在 app 级，覆盖所有 webContents（主 frame / iframe / popup）。
// 挂在单个 webContents 上会漏掉抖音的验证码 iframe 等子目标
app.on('web-contents-created', (_event, wc) => {
  const isWeb = (u) => !u || /^(https?|wss?|blob|data|about|file|chrome|chrome-extension|devtools):/i.test(u);
  wc.on('will-navigate', (event, url) => {
    if (!isWeb(url)) {
      console.log('[dy][global] 拦截导航:', String(url).slice(0, 80));
      event.preventDefault();
    }
  });
  wc.on('will-redirect', (event, url) => {
    if (!isWeb(url)) {
      console.log('[dy][global] 拦截重定向:', String(url).slice(0, 80));
      event.preventDefault();
    }
  });
  // 子 frame 的导航走 will-frame-navigate，不触发 will-navigate（这是之前漏掉的）
  try {
    wc.on('will-frame-navigate', (event) => {
      const url = event.url || '';
      if (!isWeb(url)) {
        console.log('[dy][global] 拦截子frame导航:', String(url).slice(0, 80));
        event.preventDefault();
      }
    });
  } catch (e) { /* 旧版 Electron 无此事件 */ }
  // 下载拦截不需要在这里挂：session 级的 will-download（上面 whenReady 里）
  // 天然覆盖所有 webContents 的下载，每个 webContents 再挂一次只会叠加监听器
});

// 调试用：允许从渲染层通过 window.__dyMain 切窗口全屏（F11）
const { ipcMain } = require('electron');
ipcMain.on('dy-toggle-window-fullscreen', () => {
  if (win && !win.isDestroyed()) {
    win.setFullScreen(!win.isFullScreen());
    console.log('[dy] 窗口全屏:', win.isFullScreen());
  }
});
ipcMain.on('dy-is-window-fullscreen', (e) => {
  e.returnValue = win && !win.isDestroyed() ? win.isFullScreen() : false;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
