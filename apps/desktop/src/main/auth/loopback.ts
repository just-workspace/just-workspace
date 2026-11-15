/**
 * 루프백 콜백 수신기 (RFC 8252 §7.3).
 *
 * 앱 안 웹뷰에 로그인 폼을 띄우지 않는다 — RFC 8252 §8.12 가 명시적으로 금지한다.
 * 앱이 렌더링하는 폼은 사용자가 진짜 로그인 화면인지 확인할 방법이 없고(주소창도
 * 인증서 표시도 없다), 앱이 비밀번호를 볼 수 있게 된다.
 *
 * 대신 시스템 브라우저를 열고, 임의 포트로 열어둔 이 서버가 콜백을 받는다.
 * 서버는 **포트를 0으로 열어 OS 가 비어 있는 포트를 고르게 한다** — 고정 포트를
 * 쓰면 그 포트가 이미 점유된 기기에서 로그인이 막힌다.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';

export interface CallbackResult {
  code?: string;
  error?: string;
  errorDescription?: string;
  state?: string;
  iss?: string;
}

export interface Listener {
  /** 서버가 실제로 잡은 주소. redirect_uri 로 그대로 쓴다. */
  redirectUri: string;
  /** 콜백이 도착하면 resolve. 타임아웃/취소 시 reject. */
  wait(timeoutMs: number): Promise<CallbackResult>;
  /** 사용자가 "취소하고 다시 시도" 를 눌렀을 때. wait 을 즉시 reject 시킨다. */
  cancel(): void;
  close(): void;
}

/** 사용자가 직접 취소한 경우. 오류 카드를 띄우지 않고 원래 화면으로 돌아간다. */
export class CancelledError extends Error {
  constructor() {
    super('로그인을 취소했습니다');
    this.name = 'CancelledError';
  }
}

const CALLBACK_PATH = '/callback';

function page(title: string, body: string, accent: string): string {
  // 브라우저에 남는 마지막 화면이다. 사용자가 여기서 앱으로 돌아가야 한다는 걸
  // 알 수 있어야 한다.
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>${title}</title><style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#f6f7f9;
 font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#171b21}
@media(prefers-color-scheme:dark){body{background:#101318;color:#e6eaf0}}
.c{text-align:center;max-width:32rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .5rem;color:${accent}}
p{margin:0;color:#69737f;font-size:.9rem;line-height:1.6}
</style></head><body><div class="c"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

export async function startLoopback(): Promise<Listener> {
  let resolveCb: ((r: CallbackResult) => void) | null = null;
  let rejectCb: ((e: Error) => void) | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const q = url.searchParams;
    const result: CallbackResult = {
      code: q.get('code') ?? undefined,
      error: q.get('error') ?? undefined,
      errorDescription: q.get('error_description') ?? undefined,
      state: q.get('state') ?? undefined,
      iss: q.get('iss') ?? undefined,
    };

    const ok = !!result.code;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      ok
        ? page('로그인 완료', '이 창을 닫고 Just Workspace 로 돌아가세요.', '#0f7a84')
        : page(
            '로그인이 취소되었습니다',
            result.errorDescription || result.error || '알 수 없는 오류입니다.',
            '#b3312c',
          ),
    );
    resolveCb?.(result);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 포트 0 = OS 가 비어 있는 포트를 고른다. 127.0.0.1 에만 바인딩해
    // 같은 네트워크의 다른 기기가 접근하지 못하게 한다.
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  return {
    redirectUri,
    wait(timeoutMs: number) {
      return new Promise<CallbackResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          rejectCb?.(new Error('로그인 대기 시간이 지났습니다. 다시 시도해 주세요.'));
        }, timeoutMs);

        resolveCb = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
        rejectCb = (e) => {
          clearTimeout(timer);
          reject(e);
        };
      });
    },
    cancel() {
      rejectCb?.(new CancelledError());
    },
    close() {
      server.close();
    },
  };
}
