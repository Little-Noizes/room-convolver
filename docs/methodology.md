# Convolution Methodology

## Overview

Room Convolver implements offline partitioned FFT convolution to combine source audio with room impulse responses. This document describes the signal processing chain in full.

## Signal path

```
File → Decode → Inspect → [Resample] → IR Preprocessing → Routing → Convolution → Gain → Preview/Export
```

Each stage is explicit, individually testable, and logged in the processing report.

## 1. Decoding

WAV files are decoded using a purpose-built browser decoder that reads the raw bytes directly. This avoids the Web Audio API `decodeAudioData()` path, which can apply format-dependent processing on some browsers.

Supported PCM formats: 8, 16, 24, 32-bit integer; 32 and 64-bit IEEE float. WAVE_FORMAT_EXTENSIBLE is supported.

All decoded audio is held as `Float32Array` per channel.

## 2. Sample-rate conversion

If source and IR have different sample rates, they must be brought to a common rate before convolution.

**Default strategy:** Resample to the lower of the two sample rates. This avoids introducing bandwidth that did not exist in the lower-rate file.

**Algorithm:** Lanczos-windowed sinc interpolation with kernel radius 32.

For downsampling, the kernel bandwidth is reduced to `min(1, targetRate/sourceRate)` relative to the Nyquist frequency of the input, providing partial anti-alias filtering.

All channels of a multichannel file are resampled with identical parameters to preserve inter-channel timing. This is critical for binaural, stereo, and Ambisonic material.

**Known limitation:** The current Lanczos SRC is not equivalent to a dedicated SRC library. For critical work at large ratios, a WASM-backed SRC (e.g. libsamplerate) is recommended. This is planned for Phase 2.

## 3. IR preprocessing

All preprocessing operations are non-destructive and recorded in the processing report.

### Onset detection

The onset frame is detected as the first frame where the absolute value exceeds 1% of the signal peak. The default mode preserves the absolute delay (pre-delay is not removed).

If onset removal is selected, all channels are trimmed from the same onset frame to preserve inter-channel phase.

### DC removal

Mean subtraction applied to each channel independently. Used to remove DC offset caused by microphone positioning or measurement system offsets.

### High-pass filter

Single-pole IIR high-pass filter applied in-place. Intended for removing inaudible infrasonic energy or handling noise. Off by default.

### Fades

Linear fade-in and fade-out applied after all other preprocessing.

## 4. Routing

The routing matrix maps source channels to IR channels explicitly. No implicit mapping occurs. See `docs/audio-routing.md` for full routing documentation.

## 5. Convolution

### Algorithm: partitioned overlap-add FFT convolution

For a source of length N_x and an IR of length N_h:

**Output length:** N_x + N_h − 1 (full tail preserved by default)

**Block processing:**

1. Partition the source into blocks of length L (default: min(4096, next_power_of_two(N_h)))
2. Zero-pad the IR to FFT size M = next_power_of_two(L + N_h − 1)
3. Pre-compute the IR spectrum once
4. For each source block:
   a. Zero-pad to M
   b. Forward FFT
   c. Complex multiply with the IR spectrum
   d. Inverse FFT
   e. Overlap-add the M-sample output at the correct position in the output array

**Numerical precision:** FFT internal computation uses Float64 (double). The final output is stored as Float32 for browser memory efficiency.

**FFT implementation:** Cooley-Tukey radix-2 DIT FFT, implemented in TypeScript without external dependencies. A WASM FFT library is recommended for very long IRs in future phases.

### Validation

The convolution engine passes the following tests:

- Unit impulse: output equals input within 1e-5 tolerance
- Delayed impulse: correct shift at arbitrary delay
- Known polynomial products: [1,2] * [3,4] = [3,10,8] within 1e-4 tolerance
- Silence in → silence out
- Output length exactly N_x + N_h − 1

## 6. Gain handling

Gain is applied after convolution. The processing report records which mode was used.

**Preserve (no normalisation):** Output retains the absolute linear gain of the convolution. Use when the IR contains valid calibration data. May clip if the IR has high gain.

**Peak normalise:** Output is scaled so the absolute peak equals the target level (default −1 dBFS). This changes the physical meaning of the amplitude and should not be used for calibrated work.

**Loudness normalise (approximate):** Output is scaled using RMS as a proxy for integrated loudness. This is a convenience feature only. It does not produce ITU-R BS.1770 compliant integrated loudness. Use for informal listening comparisons.

**Calibrated (Phase 5):** Requires valid source and IR calibration metadata. Not yet implemented.

## 7. Export encoding

Output channels are encoded to WAV using a purpose-built encoder.

- **32-bit float:** lossless; no dither; exact Float32 representation
- **24-bit PCM:** 1/2^23 LSB ≈ 0.1 µV quantisation step; optional TPDF dither
- **16-bit PCM:** 1/2^15 LSB; optional TPDF dither

**TPDF dither:** Triangular probability density function dither with amplitude equal to one LSB. Applied before rounding. Linearises quantisation noise and prevents spectral artefacts at low levels. Not applied to 32-bit float output.

## Why results may differ between implementations

Perceived differences between acoustic convolution software are frequently attributed to the convolution engine itself, but the convolution operation is deterministic given identical inputs. Actual causes of audible differences include:

| Factor | Effect |
|--------|--------|
| IR quality | The single largest variable |
| Sample-rate conversion quality | Aliasing, frequency response errors, phase errors |
| IR truncation | Loss of late decay; changes apparent RT60 |
| Onset alignment | Changes direct/early timing |
| Normalisation | Level differences |
| Channel routing | Spatial errors |
| Binaural decoding algorithm | Large effect on spatial impression |
| Headphone EQ | Large effect on binaural playback |
| Post-processing | Proprietary enhancement |

This application makes each of these factors explicit and configurable.
