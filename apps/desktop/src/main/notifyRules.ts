/**
 * 채널별 알림 규칙.
 *
 * 규칙을 셸이 들고 있는 이유는 **알림을 띄우는 주체가 셸**이기 때문이다. 서버에
 * 두면 창이 닫혀 있는 동안에도 규칙을 물어보러 왕복해야 하고, 웹뷰에 두면 웹뷰가
 * 떠 있을 때만 동작한다.
 *
 * 기기마다 다를 수 있는 값이기도 하다 — 사무실 PC 는 전체, 노트북은 멘션만 같은 식.
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type NotifyRule = 'all' | 'mentions' | 'off';

export const DEFAULT_RULE: NotifyRule = 'mentions';

interface Store {
  /** channelId → 규칙. 없으면 DEFAULT_RULE. */
  rules: Record<string, NotifyRule>;
  /** 데스크톱 앱이 떠 있으면 웹 탭에는 토스트를 띄우지 않는다(핸드오프 옵션). */
  desktopOnly: boolean;
}

const FILE = () => path.join(app.getPath('userData'), 'notify-rules.json');

let cache: Store | null = null;

function defaults(): Store {
  return { rules: {}, desktopOnly: true };
}

export async function loadRules(): Promise<Store> {
  if (cache) return cache;
  let next = defaults();
  try {
    // 사용자가 직접 고칠 수 있는 파일이다. 깨져 있어도 앱이 죽으면 안 된다.
    next = { ...next, ...(JSON.parse(await fs.readFile(FILE(), 'utf8')) as Partial<Store>) };
  } catch {
    /* 없거나 깨졌다 — 기본값으로 시작한다 */
  }
  cache = next;
  return next;
}

export async function ruleFor(channelId: string): Promise<NotifyRule> {
  const s = await loadRules();
  return s.rules[channelId] ?? DEFAULT_RULE;
}

export async function setRule(channelId: string, rule: NotifyRule): Promise<Store> {
  const s = await loadRules();
  if (rule === DEFAULT_RULE) delete s.rules[channelId];
  else s.rules[channelId] = rule;
  await fs.writeFile(FILE(), JSON.stringify(s, null, 2), 'utf8');
  return s;
}

export async function setDesktopOnly(v: boolean): Promise<Store> {
  const s = await loadRules();
  s.desktopOnly = v;
  await fs.writeFile(FILE(), JSON.stringify(s, null, 2), 'utf8');
  return s;
}
