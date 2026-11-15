/**
 * SDP 손질 — 원격 SDP(answer) 의 opus fmtp 에 cbr·useinbandfec·stereo·maxaveragebitrate·usedtx 를 강제한다.
 *
 * 크롬 인코더는 이 값들을 **원격** description 의 fmtp 에서 읽는다(RFC 7587 — 받는 쪽이 원하는 것을 보내는 쪽에 알림).
 * livekit-client 는 maxaveragebitrate(audioPreset)와 usedtx(서버 answer)는 다루지만 cbr·useinbandfec 는 두지 않아
 * 음악 단계의 "CBR · FEC 끔" 이 빠진다. 그래서 RTCPeerConnection.prototype.setRemoteDescription 을 한 번 감싸고,
 * 세션이 setActiveOpusFmtp() 로 값을 두면 answer 를 지나가며 고친다(null 이면 통과).
 *
 * BUNDLE 안에서 같은 payload type 은 모든 m= 구간에서 fmtp 가 같아야 하므로(libwebrtc "payload type collision")
 * 오디오 m= 구간 전부에 같은 값을 쓴다. 순수 함수 mungeOpusAnswer 는 단위 테스트 대상.
 */
import type { OpusFmtp } from './opus'

// `$`(m 플래그)는 \r 앞에서도 맞으므로 [ \t]* 로 — \s* 는 \r 을 먹어 줄 끝에 \r 이 두 번 남는다
const OPUS_RE = /^a=rtpmap:(\d+) opus\/48000(?:\/2)?[ \t]*$/im

/** 한 SDP 문자열의 모든 오디오 m= 구간에서 opus fmtp 를 고친다. 없으면 만든다. */
export function mungeOpusAnswer(sdp: string, want: OpusFmtp): string {
  const sections = sdp.split(/(?=^m=)/m)
  return sections.map((sec) => {
    if (!/^m=audio /m.test(sec)) return sec
    const m = sec.match(OPUS_RE)
    if (!m) return sec
    const pt = m[1]
    const fmtpRe = new RegExp(`^a=fmtp:${pt} (.*)$`, 'm')
    const eol = sec.includes('\r\n') ? '\r\n' : '\n'
    const apply = (config: string) => {
      const params = new Map<string, string>()
      for (const kv of config.split(';')) {
        const [k, v] = kv.split('=').map(s => s.trim())
        if (k) params.set(k, v ?? '')
      }
      params.set('maxaveragebitrate', String(want.maxaveragebitrate))
      params.set('stereo', String(want.stereo))
      params.set('sprop-stereo', String(want.stereo))
      params.set('cbr', String(want.cbr))
      params.set('usedtx', String(want.usedtx))
      params.set('useinbandfec', String(want.useinbandfec))
      return [...params.entries()].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')
    }
    const hit = sec.match(fmtpRe)
    if (hit) return sec.replace(fmtpRe, `a=fmtp:${pt} ${apply(hit[1])}`)
    // fmtp 줄이 없으면 rtpmap 바로 뒤에 넣는다
    return sec.replace(OPUS_RE, (line) => `${line}${eol}a=fmtp:${pt} ${apply('')}`)
  }).join('')
}

let active: OpusFmtp | null = null
let installed = false

/** 세션이 켠다/끈다(null). 접속 중에 바꾸면 다음 재협상(트랙 교체) answer 에 적용된다 */
export function setActiveOpusFmtp(v: OpusFmtp | null) { active = v }
export function getActiveOpusFmtp(): OpusFmtp | null { return active }

/** 프로토타입 래핑(한 번). 브라우저 밖(테스트)에서는 아무것도 안 한다 */
export function installSdpMunger() {
  if (installed || typeof RTCPeerConnection === 'undefined') return
  installed = true
  const proto = RTCPeerConnection.prototype
  const orig = proto.setRemoteDescription
  proto.setRemoteDescription = function (this: RTCPeerConnection, desc?: RTCSessionDescriptionInit) {
    try {
      if (active && desc && desc.type === 'answer' && typeof desc.sdp === 'string' && /m=audio /.test(desc.sdp)) {
        desc = { type: desc.type, sdp: mungeOpusAnswer(desc.sdp, active) }
      }
    } catch { /* 손질 실패 — 원본 그대로 */ }
    return (orig as (d?: RTCSessionDescriptionInit) => Promise<void>).call(this, desc)
  } as typeof proto.setRemoteDescription
}

/** 현재 송신 트랙의 협상된 fmtp 를 읽는다(stats 의 codec.sdpFmtpLine). 없으면 null */
export function parseFmtpLine(line: string | undefined | null): Record<string, string> | null {
  if (!line) return null
  const out: Record<string, string> = {}
  for (const kv of line.split(';')) {
    const [k, v] = kv.split('=').map(s => s.trim())
    if (k) out[k] = v ?? ''
  }
  return out
}
