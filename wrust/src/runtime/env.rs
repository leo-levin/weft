use crate::ast::SpindleDef;
use std::collections::HashMap;

#[derive(Clone)]
pub struct Env {
    // display
    pub res_w: u32,
    pub res_h: u32,

    // program timing
    pub frame: u64,
    pub absframe: u64,
    pub start_time: f64, //epoch seconds
    pub target_fps: f64,
    pub loop_duration: f64,

    // user
    pub spindles: HashMap<String, SpindleDef>,

    // music
    pub sample_rate: f64,
    pub sample: u64,
    pub abssample: u64,
    pub tempo: f64,
    pub timesig_num: u32,
    pub timesig_denom: u32,
    // media
    //pub media: HashMap<StriNng, Sampler>,
}

impl Env {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            res_w: width,
            res_h: height,
            frame: 0,
            absframe: 0,
            start_time: 0.0,
            target_fps: 60.0,
            loop_duration: 10.0,
            spindles: HashMap::new(),
            sample_rate: 48000.0,
            sample: 0,
            abssample: 0,
            tempo: 120.0,
            timesig_num: 4,
            timesig_denom: 4,
        }
    }

    pub fn start(&mut self) {
        self.start_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
    }

    pub fn abstime(&self) -> f64 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        now - self.start_time
    }

    pub fn time(&self) -> f64 {
        self.abstime() % self.loop_duration
    }

    pub fn current_beat(&self) -> f64 {
        (self.time() / 60.0) * self.tempo
    }

    pub fn current_measure(&self) -> f64 {
        self.current_beat() / self.timesig_num as f64
    }

    pub fn beat_phase(&self) -> f64 {
        self.current_beat() % 1.0
    }

    pub fn measure_phase(&self) -> f64 {
        self.current_measure() % 1.0
    }
    pub fn sync_counters(&mut self) {
        let abs_time = self.abstime();
        self.absframe = (abs_time * self.target_fps) as u64;
        self.frame = (self.time() * self.target_fps) as u64;

        self.abssample = (abs_time * self.sample_rate) as u64;
        self.sample = (self.time() * self.sample_rate) as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn test_env_new() {
        let env = Env::new(1920, 1080);
        assert_eq!(env.res_w, 1920);
        assert_eq!(env.res_h, 1080);
        assert_eq!(env.frame, 0);
        assert_eq!(env.absframe, 0);
        assert_eq!(env.start_time, 0.0);
        assert_eq!(env.target_fps, 60.0);
        assert_eq!(env.sample_rate, 48000.0);
    }

    #[test]
    fn test_start_sets_time() {
        let mut env = Env::new(800, 600);
        assert_eq!(env.start_time, 0.0);

        env.start();
        assert!(env.start_time > 0.0);
    }

    #[test]
    fn test_abstime_tracks_elapsed() {
        let mut env = Env::new(800, 600);
        env.start();

        let t0 = env.abstime();
        assert!(t0 >= 0.0 && t0 < 0.1); // Should be near zero

        sleep(Duration::from_millis(100));

        let t1 = env.abstime();
        assert!(t1 >= 0.09 && t1 <= 0.15); // ~100ms elapsed
    }

    #[test]
    fn test_time_wraps_based_on_loop_duration() {
        let mut env = Env::new(800, 600);
        env.loop_duration = 1.0; // 1 second loop
        env.start();

        // Manually set start_time to simulate time passage
        env.start_time -= 2.5; // Simulate 2.5 seconds ago

        let time = env.time();
        assert!(time >= 0.4 && time <= 0.6); // Should be around 0.5 (2.5 % 1.0)
    }

    #[test]
    fn test_sync_counters_updates_frames() {
        let mut env = Env::new(800, 600);
        env.target_fps = 60.0;
        env.start();

        // Simulate 1 second elapsed
        env.start_time -= 1.0;

        env.sync_counters();

        // After 1 second at 60fps, should be ~60 frames
        assert!(env.absframe >= 59 && env.absframe <= 61);
    }

    #[test]
    fn test_sync_counters_updates_samples() {
        let mut env = Env::new(800, 600);
        env.sample_rate = 48000.0;
        env.start();

        // Simulate 1 second elapsed
        env.start_time -= 1.0;

        env.sync_counters();

        // After 1 second at 48kHz, should be ~48000 samples
        assert!(env.abssample >= 47900 && env.abssample <= 48100);
    }

    #[test]
    fn test_sync_counters_wraps_looping_counters() {
        let mut env = Env::new(800, 600);
        env.loop_duration = 1.0; // 1 second loop
        env.target_fps = 60.0;
        env.start();

        // Simulate 2.5 seconds elapsed (2.5 loops)
        env.start_time -= 2.5;

        env.sync_counters();

        // Looping frame should be around 30 (0.5s * 60fps)
        assert!(env.frame >= 29 && env.frame <= 31);

        // Absolute frame should be around 150 (2.5s * 60fps)
        assert!(env.absframe >= 149 && env.absframe <= 151);
    }

    #[test]
    fn test_current_beat() {
        let mut env = Env::new(800, 600);
        env.tempo = 120.0; // 120 BPM = 2 beats per second
        env.start();

        // Simulate 1 second elapsed
        env.start_time -= 1.0;

        let beat = env.current_beat();
        assert!(beat >= 1.9 && beat <= 2.1); // Should be ~2 beats
    }

    #[test]
    fn test_current_measure() {
        let mut env = Env::new(800, 600);
        env.tempo = 120.0; // 2 beats/sec
        env.timesig_num = 4; // 4/4 time
        env.start();

        // Simulate 2 seconds elapsed = 4 beats = 1 measure
        env.start_time -= 2.0;

        let measure = env.current_measure();
        assert!(measure >= 0.95 && measure <= 1.05); // Should be ~1 measure
    }

    #[test]
    fn test_beat_phase() {
        let mut env = Env::new(800, 600);
        env.tempo = 60.0; // 1 beat per second
        env.start();

        // Simulate 1.25 seconds elapsed = 1.25 beats
        env.start_time -= 1.25;

        let phase = env.beat_phase();
        assert!(phase >= 0.24 && phase <= 0.26); // Should be 0.25 (fractional part)
    }

    #[test]
    fn test_measure_phase() {
        let mut env = Env::new(800, 600);
        env.tempo = 120.0; // 2 beats/sec
        env.timesig_num = 4; // 4/4
        env.start();

        // Simulate 3 seconds = 6 beats = 1.5 measures
        env.start_time -= 3.0;

        let phase = env.measure_phase();
        assert!(phase >= 0.49 && phase <= 0.51); // Should be 0.5 (fractional part)
    }
}
