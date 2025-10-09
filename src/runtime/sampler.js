// sampler.js — Media sampling and caching for images, videos, and audio

import { clamp } from '../utils/math.js';
import { logger } from '../utils/logger.js';

// Global image cache for performance
const imageCache = new Map();
const preloadedImages = new Set();

export class Sampler {
  constructor(){
    this.kind="none"; this.ready=false; this.width=1; this.height=1; this.video=null; this.image=null;
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d', { willReadFrequently: true, alpha: false });
    this.pixels=null; this.path = null; this.lastUpdate = 0; this.stream=null;
  }

  static preloadImage(path) {
    if (preloadedImages.has(path)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        imageCache.set(path, {
          image: img,
          width: img.width,
          height: img.height,
          timestamp: performance.now()
        });
        preloadedImages.add(path);
        logger.info('Sampler', `Preloaded image: ${path} (${img.width}x${img.height})`);
        resolve();
      };
      img.onerror = (e) => {
        logger.warn('Sampler', `Failed to preload image: ${path}`, e);
        reject(e);
      };
      img.src = path;
    });
  }

  static clearCache() {
    imageCache.clear();
    preloadedImages.clear();
    logger.info('Sampler', 'Image cache cleared');
  }

  load(path){
    this.path = path;
    const lower = (path||"").toLowerCase();

    logger.info('Sampler', `Loading media: ${path}`);

    // Handle video files
    if(lower.endsWith(".mp4") || lower.endsWith(".webm")){
      this.kind="video";
      this.video=document.createElement('video');
      this.video.src=path;
      this.video.muted=true;
      this.video.loop=true;
      this.video.playsInline=true;
      this.video.crossOrigin="anonymous";
      this.video.preload = "auto";

      this.video.addEventListener('loadeddata', ()=>{
        this.width=this.video.videoWidth||320;
        this.height=this.video.videoHeight||180;
        this.off.width=this.width;
        this.off.height=this.height;
        this.ready=true;
        logger.info('Sampler', `Video loaded: ${path} (${this.width}x${this.height})`);
      });

      this.video.addEventListener('error', (e)=>{
        logger.error('Sampler', `Video failed to load: ${path}`, e);
        this.fallbackPattern();
      });
      return;
    }

    // Handle image files with caching
    if(lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp")){
      this.kind="image";

      // Check cache first
      const cached = imageCache.get(path);
      if (cached) {
        logger.info('Sampler', `Using cached image: ${path}`);
        this.image = cached.image;
        this.width = cached.width;
        this.height = cached.height;
        this.off.width = this.width;
        this.off.height = this.height;
        this.processImage();
        return;
      }

      // Load new image
      this.image = new Image();
      this.image.crossOrigin = "anonymous";
      this.image.decoding = "async"; // Enable async decoding for better performance

      this.image.onload = ()=>{
        logger.info('Sampler', `Image loaded: ${path} (${this.image.width}x${this.image.height})`);
        this.width = this.image.width;
        this.height = this.image.height;
        this.off.width = this.width;
        this.off.height = this.height;

        // Cache the image
        imageCache.set(path, {
          image: this.image,
          width: this.width,
          height: this.height,
          timestamp: performance.now()
        });

        this.processImage();
      };

      this.image.onerror = (e)=>{
        logger.error('Sampler', `Image failed to load: ${path}`, e);
        this.fallbackPattern();
      };

      this.image.src = path;
      return;
    }

    logger.warn('Sampler', `Unknown file type for: ${path}`);
    this.fallbackPattern();
  }

  // Load camera stream
  // TODO: Add camera selection support (device ID, front/back, etc.)
  async loadCamera() {
    logger.info('Sampler', 'Requesting camera access');

    try {
      // Request camera access with basic constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      this.kind = "camera";
      this.stream = stream;
      this.video = document.createElement('video');
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.autoplay = true;

      this.video.addEventListener('loadedmetadata', () => {
        this.width = this.video.videoWidth || 640;
        this.height = this.video.videoHeight || 480;
        this.off.width = this.width;
        this.off.height = this.height;
        this.ready = true;
        logger.info('Sampler', `Camera loaded: ${this.width}x${this.height}`);
      });

      this.video.addEventListener('error', (e) => {
        logger.error('Sampler', 'Camera stream error', e);
        this.stopCamera();
        this.fallbackPattern();
      });

      // Start playing the video
      try {
        await this.video.play();
      } catch (e) {
        logger.warn('Sampler', 'Camera autoplay failed, will play on user interaction', e);
      }

    } catch (error) {
      logger.error('Sampler', `Camera access denied or failed: ${error.message}`);
      this.fallbackPattern();
    }
  }

  // Stop camera stream and release resources
  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
      logger.info('Sampler', 'Camera stream stopped');
    }
  }

  processImage() {
    // Use requestIdleCallback for non-blocking image processing
    const processNow = () => {
      this.offCtx.drawImage(this.image, 0, 0);
      this.pixels = this.offCtx.getImageData(0, 0, this.width, this.height).data;
      this.ready = true;
      this.lastUpdate = performance.now();
    };

    if (window.requestIdleCallback) {
      requestIdleCallback(processNow, { timeout: 100 });
    } else {
      setTimeout(processNow, 0);
    }
  }
  fallbackPattern(){
    this.kind="fallback"; this.ready=true; this.width=256; this.height=256; this.off.width=this.width; this.off.height=this.height;
    const g = this.offCtx.createLinearGradient(0,0,this.width,0);
    g.addColorStop(0,"#000"); g.addColorStop(1,"#0ff");
    this.offCtx.fillStyle=g; this.offCtx.fillRect(0,0,this.width,this.height);
    this.pixels=this.offCtx.getImageData(0,0,this.width,this.height).data;
  }
  play(){ if(this.video){ try{ this.video.play(); }catch{} } }
  updateFrame(){
    if((this.kind==="video" || this.kind==="camera") && this.ready){
      // Throttle video/camera updates for performance
      const now = performance.now();
      if (now - this.lastUpdate > 16.67) { // ~60fps max
        this.offCtx.drawImage(this.video,0,0,this.width,this.height);
        this.pixels=this.offCtx.getImageData(0,0,this.width,this.height).data;
        this.lastUpdate = now;
      }
    }
  }

  // Optimized sampling with bounds checking and bilinear interpolation option
  sample(nx, ny, interpolate = false){
    if(!this.ready || !this.pixels){
      return [nx, ny, 0.5, 1];
    }

    if (interpolate) {
      return this.sampleBilinear(nx, ny);
    } else {
      return this.sampleNearest(nx, ny);
    }
  }

  sampleNearest(nx, ny) {
    const x = clamp(Math.floor(nx * this.width), 0, this.width-1);
    const y = clamp(Math.floor(ny * this.height), 0, this.height-1);
    const idx = (y * this.width + x) * 4;
    const d = this.pixels;
    return [d[idx]/255, d[idx+1]/255, d[idx+2]/255, d[idx+3]/255];
  }

  sampleBilinear(nx, ny) {
    const fx = nx * this.width - 0.5;
    const fy = ny * this.height - 0.5;
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const dx = fx - x;
    const dy = fy - y;

    const x0 = clamp(x, 0, this.width-1);
    const x1 = clamp(x + 1, 0, this.width-1);
    const y0 = clamp(y, 0, this.height-1);
    const y1 = clamp(y + 1, 0, this.width-1);

    const d = this.pixels;
    const w = this.width;

    const getPixel = (px, py) => {
      const idx = (py * w + px) * 4;
      return [d[idx], d[idx+1], d[idx+2], d[idx+3]];
    };

    const p00 = getPixel(x0, y0);
    const p10 = getPixel(x1, y0);
    const p01 = getPixel(x0, y1);
    const p11 = getPixel(x1, y1);

    const result = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const top = p00[i] * (1 - dx) + p10[i] * dx;
      const bottom = p01[i] * (1 - dx) + p11[i] * dx;
      result[i] = (top * (1 - dy) + bottom * dy) / 255;
    }

    return result;
  }
}

// Create a fallback sampler for when no media is loaded
export const fallbackSampler = new Sampler();
fallbackSampler.fallbackPattern();