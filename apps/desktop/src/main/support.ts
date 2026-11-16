/**
 * 원격 지원 프로그램(포터블) 진입점 — `npm run dist:support` 가 이 파일을 main 으로 번들링한다.
 * 데스크톱 앱 본체(로그인·트레이·동기화)는 포함하지 않는다. 계정 없이 접속 코드를 표시하고, 동의를 받아 화면을 송출한다.
 * 서버 주소: 빌드 시 내장한 값(JW_SERVER_URL → dist/site.json) → 없으면 첫 실행 시 입력(userData/support.json).
 */
import { app, Menu } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config';
import { SupportController } from './remote/support';
import { installContextMenu } from './contextMenu';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const remoteInput = require('../../native/remote-input.js') as typeof import('../../native/remote-input');

const SAVED = () => path.join(app.getPath('userData'), 'support.json');

async function savedServer(): Promise<string> {
  try { return JSON.parse(await fs.readFile(SAVED(), 'utf8')).server ?? ''; } catch { return ''; }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  installContextMenu();
  app.whenReady().then(async () => {
    // 메뉴 막대는 표시되지 않으나(창이 프레임리스) 편집 단축키(Ctrl+C·V·A·Z)는 메뉴 역할이 있어야 모든 위치에서 동작한다.
    // 이전에는 메뉴를 null 로 비워 macOS 에서 붙여넣기 단축키가 동작하지 않았다.
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));
    const baked = CONFIG.serverUrl && !/^https?:\/\/localhost$/.test(CONFIG.serverUrl) ? CONFIG.serverUrl : '';
    const server = baked || (await savedServer());
    const ctl = new SupportController(server, remoteInput.load(), async (s) => {
      await fs.writeFile(SAVED(), JSON.stringify({ server: s }), { mode: 0o600 });
    });
    ctl.open();
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', () => { void ctl.shutdown(); });
  });
}
