/**
 * 오른쪽 클릭 메뉴 — 잘라내기·복사·붙여넣기·모두 선택·링크 주소 복사.
 *
 * Electron 은 기본 컨텍스트 메뉴가 없다. 브라우저에서 되던 "오른쪽 클릭 → 복사/붙여넣기"가 앱 안에서는
 * 아무 반응이 없어 "복붙이 안 된다"로 보였다(지원 프로그램의 접속 코드·서버 주소, 본문 웹 전체).
 * 페이지가 자기 메뉴를 그리면(채팅 메시지 메뉴 등 contextmenu preventDefault) 이 이벤트는 오지 않는다.
 */
import { app, clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';

function build(wc: WebContents, p: Electron.ContextMenuParams): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const f = p.editFlags;
  if (p.isEditable) {
    items.push(
      { label: '실행 취소', role: 'undo', enabled: f.canUndo },
      { label: '다시 실행', role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { label: '잘라내기', role: 'cut', enabled: f.canCut },
      { label: '복사', role: 'copy', enabled: f.canCopy },
      { label: '붙여넣기', role: 'paste', enabled: f.canPaste },
      { type: 'separator' },
      { label: '모두 선택', role: 'selectAll', enabled: f.canSelectAll },
    );
  } else if (p.selectionText.trim()) {
    items.push({ label: '복사', role: 'copy', enabled: f.canCopy });
  }
  if (p.linkURL && /^https?:/i.test(p.linkURL)) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: '링크 주소 복사', click: () => clipboard.writeText(p.linkURL) });
  }
  if (p.mediaType === 'image' && p.srcURL) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: '이미지 복사', click: () => wc.copyImageAt(p.x, p.y) });
  }
  return items;
}

/** 앱의 모든 창(본문 웹뷰·설정·지원 창…)에 붙인다. whenReady 전에 한 번 부른다. */
export function installContextMenu(): void {
  app.on('web-contents-created', (_e, wc) => {
    wc.on('context-menu', (_ev, params) => {
      const items = build(wc, params);
      if (items.length) Menu.buildFromTemplate(items).popup();
    });
  });
}
