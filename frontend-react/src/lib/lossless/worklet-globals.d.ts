/**
 * AudioWorkletGlobalScope 전역 — lib.dom 에는 없어서 여기서 선언한다(*.worklet.ts 전용).
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: AudioWorkletNodeOptions)
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void

declare const currentTime: number
declare const currentFrame: number
declare const sampleRate: number
