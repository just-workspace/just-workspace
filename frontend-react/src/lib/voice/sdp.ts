/**
 * SDP 수정 — 원격 SDP(answer) 의 opus fmtp 에 cbr·useinbandfec·stereo·maxaveragebitrate·usedtx 를 강제한다.
 *
 * 크롬 인코더는 이 값들을 **원격** description 의 fmtp 에서 읽는다(RFC 7587 — 수신 측이 원하는 값을 송신 측에 통지).
 * livekit-client 는 maxaveragebitrate(audioPreset)와 usedtx(서버 answer)는 처리하지만 cbr·useinbandfec 는 설정하지 않아
 * 음악 단계의 "CBR · FEC 끔" 이 누락된다. 따라서 RTCPeerConnection.prototype.setRemoteDescription 을 1회 래핑하고,
 * 세션이 setActiveOpusFmtp() 로 값을 설정하면 answer 통과 시 수정한다(null 이면 통과).
 *
 * BUNDLE 안에서 동일 payload type 은 모든 m= 구간에서 fmtp 가 동일해야 하므로(libwebrtc "payload type collision")
 * 오디오 m= 구간 전부에 동일한 값을 기록한다. 순수 함수 mungeOpusAnswer 는 단위 테스트 대상.
 */
import type { OpusFmtp } from './opus'

// `$`(m 플래그)는 \r 앞에서도 일치하므로 [ \t]* 를 사용한다 — \s* 는 \r 을 소비해 줄 끝에 \r 이 2회 남는다
const OPUS_RE = /^a=rtpmap:(\d+) opus\/48000(?:\/2)?[ \t]*$/im

/** 한 SDP 문자열의 모든 오디오 m= 구간에서 opus fmtp 를 수정한다. 없으면 생성한다. */
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
    // fmtp 줄이 없으면 rtpmap 바로 뒤에 삽입
    return sec.replace(OPUS_RE, (line) => `${line}${eol}a=fmtp:${pt} ${apply('')}`)
  }).join('')
}

let active: OpusFmtp | null = null
let installed = false

/** 세션이 활성화/비활성화(null)한다. 접속 중 변경 시 다음 재협상(트랙 교체) answer 에 적용된다 */
export function setActiveOpusFmtp(v: OpusFmtp | null) { active = v }
export function getActiveOpusFmtp(): OpusFmtp | null { return active }

/** 프로토타입 래핑(1회). 브라우저 밖(테스트)에서는 no-op */
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
    } catch { /* 수정 실패 — 원본 그대로 사용 */ }
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
