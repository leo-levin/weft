export class ClockDisplay {
  constructor(env) {
    this.env = env;
    this.isPlaying = false;
    this.renderer = null;

    // Get DOM elements
    this.playPauseBtn = document.getElementById('playPauseBtn');
    this.clockDisplay = document.getElementById('clockDisplay');

    this.setupEventListeners();
    this.update(); // Initial update
    this.startUpdateLoop(); // Start continuous updates
  }

  setRenderer(renderer) {
    this.renderer = renderer;
  }

  setupEventListeners() {
    // Play/pause button
    this.playPauseBtn.addEventListener('click', () => {
      this.togglePlayPause();
    });

    // Keyboard shortcut for spacebar
    document.addEventListener('keydown', (e) => {
      // Only trigger if not in an input field
      if (e.code === 'Space' && !e.target.matches('input, textarea, [contenteditable]')) {
        e.preventDefault();
        this.togglePlayPause();
      }
    });
  }

  togglePlayPause() {
    if (!this.renderer) return;

    // Check current renderer state
    const currentlyRunning = this.renderer.running;

    if (currentlyRunning) {
      this.renderer.stop();
      this.isPlaying = false;
      this.playPauseBtn.textContent = '▶';
      this.playPauseBtn.classList.remove('playing');
    } else {
      this.renderer.start();
      this.isPlaying = true;
      this.playPauseBtn.textContent = '⏸';
      this.playPauseBtn.classList.add('playing');
    }
  }

  update() {
    if (!this.env) return;

    // Sync play state with renderer
    if (this.renderer) {
      const rendererRunning = this.renderer.running;
      if (this.isPlaying !== rendererRunning) {
        this.isPlaying = rendererRunning;
        this.playPauseBtn.textContent = this.isPlaying ? '⏸' : '▶';
        if (this.isPlaying) {
          this.playPauseBtn.classList.add('playing');
        } else {
          this.playPauseBtn.classList.remove('playing');
        }
      }
    }

    // Calculate time values based on frame counter (pauses when renderer stops)
    const absTime = this.env.frame / this.env.targetFps;
    const loopFrame = this.env.frame % this.env.loop;

    // Calculate beat within current measure based on frame time
    const beatsPerSecond = this.env.bpm / 60;
    const totalBeats = absTime * beatsPerSecond;
    const beatInMeasure = (totalBeats % this.env.timesig_num);

    // Update single display with all values (showing target FPS)
    this.clockDisplay.textContent = `${absTime.toFixed(2)}s | ${loopFrame}/${this.env.loop} | ${beatInMeasure.toFixed(1)} | ${this.env.targetFps}`;
  }


  // Start continuous update loop for clock display
  startUpdateLoop() {
    const updateClock = () => {
      this.update();
      requestAnimationFrame(updateClock);
    };
    requestAnimationFrame(updateClock);
  }
}