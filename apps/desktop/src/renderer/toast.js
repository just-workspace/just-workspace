/*
 * 토스트 스택.
 *
 * Windows OS 토스트에는 인라인 답장 입력이 없다(Electron Notification 이 노출하지
 * 않는다). 디자인이 "OS 가 지원하지 않으면 자체 프레임리스 알림 창" 을 대안으로
 * 두었으므로 이쪽으로 만든다.
 */
'use strict';

const AVATAR_COLORS = ['#0f7a84', '#7b5ea8', '#b4763a', '#2f7d46', '#4a5560', '#2b4448'];

function avatarColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function fmtWhen(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 45) return '지금';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분 전`;
  return `${Math.round(min / 60)}시간 전`;
}

const APP_MARK =
  '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" ' +
  'stroke-width="3" stroke-linecap="round"><path d="M4 7h16M4 12h10M4 17h13"/></svg>';

const CLOSE_ICON =
  '<svg width="10" height="10" viewBox="0 0 24 24" stroke="var(--icon-muted)" ' +
  'stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5 5 19"/></svg>';

const BELL_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

const WARN_ICON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" ' +
  'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17.2h.01"/></svg>';

/** 멘션 부분만 브랜드색으로. innerHTML 을 쓰지 않고 노드로 만든다. */
function renderText(el, text, mention) {
  el.replaceChildren();
  if (!mention) {
    el.textContent = text;
    return;
  }
  const i = text.indexOf(mention);
  if (i < 0) {
    el.textContent = text;
    return;
  }
  el.append(document.createTextNode(text.slice(0, i)));
  const m = document.createElement('span');
  m.className = 'mention';
  m.textContent = mention;
  el.append(m, document.createTextNode(text.slice(i + mention.length)));
}

function build(t) {
  const card = document.createElement('div');
  card.className = 'toast';
  card.dataset.id = t.id;

  // ── 머리글 ──
  const head = document.createElement('div');
  head.className = 'head';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.innerHTML = APP_MARK;
  const app = document.createElement('span');
  app.className = 'app';
  app.textContent =
    t.kind === 'sync' ? 'just-workspace · 동기화'
      : t.kind === 'notice' && t.area ? `just-workspace · ${t.area}`
        : 'just-workspace';
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = fmtWhen(t.at);
  const x = document.createElement('button');
  x.className = 'x';
  x.type = 'button';
  x.setAttribute('aria-label', '닫기');
  x.innerHTML = CLOSE_ICON;
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    window.jw.toast.dismiss(t.id);
  });
  head.append(mark, app, when, x);
  card.append(head);

  // ── 본문 ──
  const body = document.createElement('div');
  body.className = 'body' + (t.kind === 'sync' ? ' only' : '');

  const av = document.createElement('span');
  av.className = 'av' + (t.kind === 'sync' ? ' warn' : '');
  if (t.kind === 'sync') {
    av.innerHTML = WARN_ICON;
  } else if (t.kind === 'notice' && !t.author) {
    // 사람이 보낸 게 아닌 알림(일정 알림·시스템) — 벨
    av.style.background = 'var(--brand)';
    av.innerHTML = BELL_ICON;
  } else {
    av.style.background = avatarColor(t.author || t.id);
    av.textContent = (t.author || '·').trim().slice(0, 1);
  }

  const col = document.createElement('div');
  col.className = 'col';
  if (t.kind === 'sync' || t.kind === 'notice') {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = t.title;
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = t.body;
    col.append(who, text);
  } else {
    const top = document.createElement('div');
    top.className = 'top';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = t.author;
    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = t.channel;
    top.append(who, where);
    const text = document.createElement('div');
    text.className = 'text';
    renderText(text, t.body, t.mention);
    col.append(top, text);
  }
  body.append(av, col);
  card.append(body);

  // 본문 클릭 → 해당 화면(대화·작업·일정…)으로 이동
  body.addEventListener('click', () => window.jw.toast.activate(t.id));

  // ── 인라인 답장 ──
  if (t.canReply) {
    const wrap = document.createElement('div');
    wrap.className = 'reply';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '답장 입력…';
    input.setAttribute('aria-label', `${t.channel} 에 답장`);
    const send = document.createElement('button');
    send.type = 'button';
    send.textContent = '보내기';
    send.disabled = true;

    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      window.jw.toast.reply(t.id, v);
    };
    input.addEventListener('input', () => {
      send.disabled = !input.value.trim();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    send.addEventListener('click', submit);

    wrap.append(input, send);
    card.append(wrap);
  }

  return card;
}

window.jw.toast.onList((list) => {
  const stack = document.getElementById('stack');
  stack.replaceChildren();
  for (const t of list) stack.append(build(t));

  // 스택 높이를 메인에 알려 창을 딱 맞춘다. 투명 영역이 넓으면 그 아래 창을
  // 클릭할 수 없다.
  const r = stack.getBoundingClientRect();
  window.jw.toast.resize({
    width: 352 + 32,
    height: Math.ceil(r.height) + 32,
  });
});

window.jw.toast.ready();
