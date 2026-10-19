/// <reference lib="webworker" />
import { DemoEngine, type EngineInput } from '../core/demo-engine';

let engine: DemoEngine | null = null;

addEventListener('message', ({ data }: MessageEvent<EngineInput | { kind: 'start'; seed: number }>) => {
  if (typeof data === 'object' && data && data.kind === 'start') {
    engine?.stop();
    engine = new DemoEngine((batch) => postMessage(batch), data.seed);
    engine.start();
    return;
  }
  engine?.receive(data as EngineInput);
});
