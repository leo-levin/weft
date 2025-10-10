// WEFT Audio Processor - Simplified and robust AudioWorklet implementation

class WeftAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Core state
    this.isCompiled = false;
    this.channelFunctions = [];
    this.sampleIndex = 0;

    // Shared buffer for cross-context data (optional)
    this.sharedData = null;

    // Message handling
    this.port.onmessage = (event) => this.handleMessage(event.data);

    // Ready to process
  }

  handleMessage(data) {
    if (data.type === 'compile') {
      try {
        // Compile channel functions
        this.channelFunctions = data.channels.map((code, index) => {
          // Create a function that evaluates the expression
          // Parameters: t (time in seconds), sample (sample index)
          const functionBody = `
            const sin = Math.sin;
            const cos = Math.cos;
            const tan = Math.tan;
            const abs = Math.abs;
            const sqrt = Math.sqrt;
            const floor = Math.floor;
            const ceil = Math.ceil;
            const round = Math.round;
            const min = Math.min;
            const max = Math.max;
            const pow = Math.pow;
            const exp = Math.exp;
            const log = Math.log;
            const PI = Math.PI;

            return ${code};
          `;

          const fn = new Function('t', 'sample', 'shared', functionBody);
          return fn;
        });

        // Store shared buffer if provided
        if (data.sharedBuffer) {
          this.sharedData = new Float32Array(data.sharedBuffer);
        }

        this.isCompiled = true;

        // Send success message
        this.port.postMessage({
          type: 'compiled',
          success: true,
          channelCount: this.channelFunctions.length
        });

      } catch (error) {
        console.error('[AudioProcessor] Compilation error:', error);
        this.port.postMessage({
          type: 'error',
          message: error.message
        });
      }
    }
    else if (data.type === 'reset') {
      this.sampleIndex = 0;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];

    // Check if we have output channels
    if (!output || output.length === 0) {
      return true; // Keep processor alive
    }

    // If not compiled yet, output silence
    if (!this.isCompiled || this.channelFunctions.length === 0) {
      // Fill with silence
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].fill(0);
      }
      return true;
    }

    const numSamples = output[0].length; // Usually 128
    const numOutputChannels = output.length; // Usually 2 (stereo)
    const numFunctions = this.channelFunctions.length;
    // In AudioWorklet, sampleRate is a global variable
    const SR = sampleRate; // This is the AudioWorklet global sampleRate


    // Process each sample
    for (let i = 0; i < numSamples; i++) {
      // Calculate time in seconds
      const t = (this.sampleIndex + i) / SR;
      const sample = this.sampleIndex + i;

      // Single channel function - copy to all outputs
      if (numFunctions === 1) {
        try {
          const value = this.channelFunctions[0](t, sample, this.sharedData);
          const clampedValue = Math.max(-1, Math.min(1, value || 0));


          // Copy to all output channels
          for (let channel = 0; channel < numOutputChannels; channel++) {
            output[channel][i] = clampedValue;
          }
        } catch (error) {
          // Silence on error
          for (let channel = 0; channel < numOutputChannels; channel++) {
            output[channel][i] = 0;
          }
        }
      }
      // Multiple channel functions
      else {
        for (let channel = 0; channel < numOutputChannels; channel++) {
          if (channel < numFunctions) {
            try {
              const value = this.channelFunctions[channel](t, sample, this.sharedData);
              output[channel][i] = Math.max(-1, Math.min(1, value || 0));
            } catch (error) {
              output[channel][i] = 0;
            }
          } else {
            // No function for this channel
            output[channel][i] = 0;
          }
        }
      }
    }

    // Update sample counter
    this.sampleIndex += numSamples;

    return true; // Keep processor alive
  }
}

// Register the processor
registerProcessor('weft-audio-processor', WeftAudioProcessor);