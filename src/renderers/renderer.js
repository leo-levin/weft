// renderer.js — CPU renderer
import { clamp, isNum } from '../runtime/runtime.js';

class Renderer {
  constructor(canvas, env){
    this.cv = canvas; this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.env = env;
    this.off = document.createElement('canvas');
    this.off.width = env.resW; this.off.height = env.resH;
    this.offCtx = this.off.getContext('2d', { willReadFrequently: true });
    this.imageData = this.offCtx.createImageData(env.resW, env.resH);
    this.running = false;
    this.last = performance.now(); this.acc = 0; this.frames=0; this.fps=0; this.avgMs=0;
    this.lastFrameTime = performance.now();
    this.frameTimeAccumulator = 0;
    this.lastResW = env.resW;
    this.lastResH = env.resH;
    this.lastTargetFps = env.targetFps;
  }
  start(){ this.running=true; this.loop(); }
  stop(){ this.running=false; }
  loop(){
    if(!this.running) return;

    const now = performance.now();
    const targetFrameTime = 1000 / this.env.targetFps; // ms per frame
    const deltaTime = now - this.lastFrameTime;

    // Debug: Log FPS changes
    if (this.lastTargetFps !== this.env.targetFps) {
      console.log(`🎬 Renderer: Target FPS changed from ${this.lastTargetFps} to ${this.env.targetFps}`);
      this.lastTargetFps = this.env.targetFps;
    }

    this.frameTimeAccumulator += deltaTime;

    // Only render if enough time has accumulated for the target frame rate
    if (this.frameTimeAccumulator >= targetFrameTime) {
      const t0 = performance.now();
      this.tick();
      const t1 = performance.now();
      const dt = t1-t0;

      // Animate frame indicator
      const frameIndicator = document.getElementById('frameIndicator');
      if (frameIndicator) {
        frameIndicator.classList.add('active');
        setTimeout(() => frameIndicator.classList.remove('active'), 50);
      }

      this.acc += (t1 - this.last); this.last = t1; this.frames++;
      if(this.acc > 500){
        this.fps = Math.round(1000 * this.frames / this.acc);
        this.avgMs = Math.round(dt);
        this.acc = 0; this.frames = 0;
        document.getElementById('fpsPill').textContent = `FPS: ${this.fps}`;
        document.getElementById('perfPill').textContent = `Frame: ${this.avgMs} ms`;
      }

      // Subtract one frame time but keep any remainder to prevent drift
      this.frameTimeAccumulator -= targetFrameTime;
    }

    this.lastFrameTime = now;

    requestAnimationFrame(()=>this.loop());
  }
  tick(){
    const env = this.env;
    
    // Check if resolution changed and recreate buffers if needed
    if (env.resW !== this.lastResW || env.resH !== this.lastResH) {
      this.off.width = env.resW;
      this.off.height = env.resH;
      this.imageData = this.offCtx.createImageData(env.resW, env.resH);
      this.lastResW = env.resW;
      this.lastResH = env.resH;
      
      // Update resolution display
      document.getElementById('resPill').textContent = `Res: ${env.resW}×${env.resH}`;
    }
    
    if(env.defaultSampler) env.defaultSampler.updateFrame();
    if(env.audio.analyser){
      const buf = new Uint8Array(env.audio.analyser.frequencyBinCount);
      env.audio.analyser.getByteTimeDomainData(buf);
      let sum=0; for(let i=0;i<buf.length;i++){ const v=(buf[i]-128)/128; sum+=v*v; }
      env.audio.intensity = Math.sqrt(sum / buf.length);
    } else {
      env.audio.intensity = (Math.sin(env.time()*0.8)*0.5+0.5)*0.5;
    }

    const [fr, fg, fb] = env.displayFns || [];
    const W = env.resW, H = env.resH;
    let data = this.imageData.data;
    const t = env.time();
    for(let y=0; y<H; y++){
      const ny = (y + 0.5)/H;
      for(let x=0; x<W; x++){
        const nx = (x + 0.5)/W;
        // frames can be used as both frame counter and time reference based on target FPS
        const framesTime = env.frame / env.targetFps; // Time in seconds at target frame rate
        const me = { x:nx, y:ny, t, frames: framesTime, width:W, height:H };
        let r = fr ? fr(me, env) : 0, g = fg ? fg(me, env) : 0, b = fb ? fb(me, env) : 0;
        r = clamp(isNum(r)?r:0,0,1); g = clamp(isNum(g)?g:0,0,1); b = clamp(isNum(b)?b:0,0,1);
        const idx = (y*W + x)*4;
        data[idx]   = Math.round(r*255);
        data[idx+1] = Math.round(g*255);
        data[idx+2] = Math.round(b*255);
        data[idx+3] = 255;
      }
    }
    this.offCtx.putImageData(this.imageData, 0, 0);
    this.ctx.imageSmoothingEnabled = env.interpolate;
    if (env.interpolate) {
      this.ctx.imageSmoothingQuality = 'high';
    }
    this.ctx.drawImage(this.off, 0, 0, this.cv.width, this.cv.height);
    env.frame++;
  }
}
export { Renderer };