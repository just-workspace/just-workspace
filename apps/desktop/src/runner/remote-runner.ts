/**
 * 원격 데스크톱 화면 러너(숨김 창, 전용 파티션) — LiveKit 방에 화면을 송출하고 데이터 채널을 메인으로 전달한다.
 * scripts/build-runner.mjs 가 livekit-client 와 함께 dist/renderer/remote-runner.js 하나로 번들한다.
 * 입력 검증·주입·속도 제한은 메인(src/main/remote)이 수행한다 — 여기서는 수신한 바이트와 송신자 정체성만 전달한다.
 */
import { LocalVideoTrack, Room, RoomEvent, Track, type Participant } from 'livekit-client';

declare global {
  interface Window {
    rd: {
      runner: {
        init(): Promise<{ ws_url: string; token: string; peer: string; maxWidth: number; maxHeight: number; fps: number } | null>
        input(payload: Uint8Array, from: string): void
        state(s: 'connected' | 'closed' | 'failed', detail?: string): void
        onSend(fn: (payload: Uint8Array<ArrayBuffer>) => void): () => void
        onSwitch(fn: () => void): () => void
        onQuality(fn: (q: QualityParams) => void): () => void
        /** 현재 송출할 모니터의 캡처 소스 id(desktopCapturer) — 구 방식 캡처 폴백용 */
        source(): Promise<string | null>
        /** 화면 소스 id 전체(다른 모니터 대체용) */
        sources(): Promise<string[]>
        /** 실제로 획득한 소스(다른 모니터로 대체된 경우 메인이 입력 좌표를 보정한다) */
        used(id: string): void
        onStop(fn: () => void): () => void
      }
    }
  }
}

const TOPIC = 'rd';

/** main/remote/quality.ts QualityParams 와 동일한 형태 */
interface QualityParams {
  mode: string;
  maxBitrate: number;
  fps: number;
  degradation: RTCDegradationPreference;
  hint: string;
  scale: number;
}

/**
 * 화면 캡처 — 세 단계로 시도한다.
 *  1) getDisplayMedia(메인의 setDisplayMediaRequestHandler 가 피커 없이 지정한 모니터)
 *  2) 구 방식 getUserMedia({chromeMediaSource:'desktop'}) + 해당 모니터의 소스 id — 캡처 경로가 달라
 *     1) 이 "NotReadableError: Could not start video source" 로 실패하는 PC(서로 다른 그래픽 칩에 연결된 모니터,
 *     일부 드라이버)에서 성공한다
 *  3) 2) 를 크기·fps 제약 없이 수행 — 제약 협상 자체가 실패하는 드라이버 대비. fps 는 이후 applyConstraints 로 조정한다
 * 세 단계 모두 실패하면 각 단계 오류를 연결해 예외를 발생시킨다(서버 감사 기록 client_detail 로 전달된다).
 */
async function capture(maxWidth: number, maxHeight: number, fps: number): Promise<MediaStreamTrack> {
  const errs: string[] = [];
  const name = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  const done = (stream: MediaStream) => {
    const t = stream.getVideoTracks()[0];
    t.contentHint = 'detail'; // 글자 선명도 우선(화면 원격은 문서·UI 가 대부분)
    return t;
  };
  try {
    return done(await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: maxWidth }, height: { max: maxHeight }, frameRate: { ideal: fps, max: fps } },
      audio: false,
    }));
  } catch (e) { errs.push(`gdm ${name(e)}`); }

  const id = await window.rd.runner.source().catch(() => null);
  if (id) {
    const legacy = (mandatory: Record<string, unknown>) => navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, ...mandatory } } as unknown as MediaTrackConstraints,
    });
    try {
      const t = done(await legacy({ maxWidth, maxHeight, maxFrameRate: fps }));
      console.warn('[runner] 예전 방식 캡처로 대체', errs.join(' / '));
      return t;
    } catch (e) { errs.push(`legacy ${name(e)}`); }
    try {
      const t = done(await legacy({}));
      console.warn('[runner] 제약 없는 캡처로 대체', errs.join(' / '));
      return t;
    } catch (e) { errs.push(`legacy-free ${name(e)}`); }
  } else {
    errs.push('no source');
  }
  // 4) 선택한 모니터를 끝내 캡처하지 못하면 다른 모니터로 대체 — 특정 모니터(다른 그래픽 칩·HDR)만 캡처되지 않는 PC 대비
  const others = (await window.rd.runner.sources().catch(() => [] as string[])).filter(x => x !== id);
  for (const other of others) {
    try {
      const t = done(await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: other } } as unknown as MediaTrackConstraints,
      }));
      console.warn('[runner] 다른 모니터로 대체', other, errs.join(' / '));
      window.rd.runner.used(other);
      return t;
    } catch (e) { errs.push(`other ${name(e)}`); }
  }
  throw new Error(errs.join(' / ').replace(/NotReadableError: Could not start video source/g, 'NotReadable'));
}

async function main() {
  const cfg = await window.rd.runner.init();
  if (!cfg) { window.rd.runner.state('failed'); return; }
  const room = new Room({ adaptiveStream: false, dynacast: false });
  let local: LocalVideoTrack | null = null;
  /** 현재 적용된 화질 — 모니터 변경으로 트랙을 교체한 경우에도 재적용한다 */
  let quality: QualityParams | null = null;

  /*
   * 연결을 끊지 않고 인코더 설정만 변경한다(RTCRtpSender.setParameters). 캡처 fps 는 트랙 제약으로 조정한다
   * (60 fps 는 캡처 단계부터 60 이어야 한다). dynacast·adaptiveStream 을 비활성화했으므로 LiveKit 이 이 값을 덮어쓰지 않는다.
   */
  async function applyQuality(q: QualityParams): Promise<void> {
    quality = q;
    const tr = local;
    if (!tr) return;
    const mt = tr.mediaStreamTrack;
    try { mt.contentHint = q.hint; } catch { /* noop */ }
    try { await mt.applyConstraints({ frameRate: { ideal: q.fps, max: q.fps } }); } catch (e) { console.warn('[runner] fps 제약 실패', String(e)); }
    const sender = tr.sender;
    if (!sender) return;
    try {
      const p = sender.getParameters();
      if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
      p.encodings[0].maxBitrate = q.maxBitrate;
      p.encodings[0].maxFramerate = q.fps;
      p.encodings[0].scaleResolutionDownBy = q.scale;
      p.degradationPreference = q.degradation;
      await sender.setParameters(p);
      console.info(`[runner] 화질 ${q.mode} ${q.maxBitrate / 1e6}Mbps ${q.fps}fps ÷${q.scale} ${q.degradation}`);
    } catch (e) {
      console.warn('[runner] 화질 적용 실패', String(e));
    }
  }
  window.rd.runner.onQuality((q) => { void applyQuality(q); });

  room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: Participant, _k?: unknown, topic?: string) => {
    if (topic !== TOPIC || !participant || participant.identity !== cfg.peer) return;
    window.rd.runner.input(payload, participant.identity);
  });
  room.on(RoomEvent.Disconnected, () => window.rd.runner.state('closed'));

  window.rd.runner.onSend((payload) => {
    void room.localParticipant.publishData(payload, { reliable: true, topic: TOPIC, destinationIdentities: [cfg.peer] }).catch(() => {});
  });
  window.rd.runner.onSwitch(async () => {
    try {
      const t = await capture(cfg.maxWidth, cfg.maxHeight, cfg.fps);
      if (local) { const old = local.mediaStreamTrack; await local.replaceTrack(t); old.stop(); if (quality) await applyQuality(quality); }
    } catch (e) {
      console.warn('[runner] 모니터 바꾸기 실패', e);
    }
  });
  window.rd.runner.onStop(() => {
    local?.stop();
    void room.disconnect();
  });

  const errText = (step: string, e: unknown) => `${step}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  // 단계마다 실패 사유를 기록한다 — 숨김 창이므로 기록이 없으면 "승인했는데 바로 끊김"만 확인된다(서버 감사 기록에도 전달된다)
  let step = 'connect';
  try {
    await room.connect(cfg.ws_url, cfg.token, { autoSubscribe: true, peerConnectionTimeout: 30_000, websocketTimeout: 30_000 });
    step = 'capture';
    const mt = await capture(cfg.maxWidth, cfg.maxHeight, cfg.fps);
    local = new LocalVideoTrack(mt, undefined, false);
    step = 'publish';
    const opts = {
      source: Track.Source.ScreenShare,
      simulcast: false,
      videoEncoding: { maxBitrate: 12_000_000, maxFramerate: cfg.fps },
      degradationPreference: 'maintain-resolution' as const,
    };
    try {
      // H.264 우선 — 대부분의 PC 에 하드웨어 인코더(Intel QSV·NVIDIA NVENC·AMD AMF)가 있어 CPU 부담 없이 고해상도·고 fps 송출이 가능하다.
      await room.localParticipant.publishTrack(local, { ...opts, videoCodec: 'h264' });
    } catch (e) {
      // 이 PC 에서 H.264 송출이 불가하면(인코더 없음·드라이버) VP8 로 재시도 — 화질보다 연결을 우선한다
      console.warn('[runner] H.264 송출 실패, VP8 로 재시도', errText('publish', e));
      step = 'publish-vp8';
      await room.localParticipant.publishTrack(local, { ...opts, videoCodec: 'vp8' });
    }
    window.rd.runner.state('connected');
  } catch (e) {
    const msg = errText(step, e);
    console.warn('[runner] 연결 실패', msg);
    window.rd.runner.state('failed', msg);
  }
}

void main();
