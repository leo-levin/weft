use crate::ast::SpindleDef;
use std::collections::HashMap;

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
            tempo: 120.0,
            timesig_num: 4,
            timesig_denom: 4,
        }
    }

    pub fn time(&self) -> f64 {
        self.abstime() % self.loop_duration
    }

    pub fn abstime(&self) -> f64 {
        todo!("implement time tracking")
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
}
