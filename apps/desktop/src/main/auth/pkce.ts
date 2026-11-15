/**
 * PKCE (RFC 7636) — 공개 클라이언트의 유일한 증명 수단.
 *
 * 데스크톱 앱은 client_secret 을 안전하게 보관할 수 없다(배포본을 뜯으면 나온다).
 * 그래서 서버는 secret 대신 code_verifier 를 요구한다. 인가 코드를 가로챈 쪽은
 * verifier 를 모르므로 토큰으로 바꾸지 못한다.
 *
 * 서버는 S256 만 받는다 — plain 은 가로챈 쪽이 challenge 를 그대로 재사용할 수
 * 있어 방어가 되지 않는다.
 */
import crypto from 'node:crypto';

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function createPkce(): Pkce {
  // RFC 7636 §4.1 — verifier 는 43~128자. 32바이트 난수의 base64url 이 43자다.
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** CSRF 방어용 state. 콜백에서 되돌아온 값과 대조한다. */
export function createState(): string {
  return b64url(crypto.randomBytes(24));
}
