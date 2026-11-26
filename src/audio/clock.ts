// The audio element is the master clock, but currentTime only advances in coarse steps in
// some browsers. Run a local clock at the playback rate and steer it gently toward the
// reported time, so frames never step backwards when a late update arrives.
export class Clock {
  private t = 0;
  private lastPerf = -1;

  constructor(private audio: HTMLAudioElement) {}

  now(): number {
    const ct = this.audio.currentTime;
    const perf = performance.now();
    if (this.audio.paused || this.audio.seeking || this.lastPerf < 0) {
      this.t = ct;
      this.lastPerf = perf;
      return ct;
    }
    let t = this.t + ((perf - this.lastPerf) / 1000) * this.audio.playbackRate;
    this.lastPerf = perf;
    const err = ct - t;
    if (Math.abs(err) > 0.2) t = ct;
    else t += err * 0.06;
    this.t = t;
    return t;
  }
}
