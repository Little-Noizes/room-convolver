# Known Limitations — v0.1.0

## DSP

### Sample-rate conversion

The Lanczos-windowed sinc SRC (kernel radius 32) provides good performance for common ratios (44.1↔48 kHz, 44.1↔88.2 kHz). For large ratios or critical work, the anti-alias attenuation may be insufficient. A WASM-backed SRC library is planned for Phase 2.

No formal frequency response measurement of the current SRC has been conducted. Avoid using it for precision acoustic measurement work until validation is complete.

### Loudness normalisation

The loudness normalisation option uses RMS as a proxy for perceived loudness. It is not ITU-R BS.1770 compliant. Use it for informal listening comparisons only, not for broadcast or publication.

### FFT precision

The convolution FFT uses Float64 internally and returns Float32 output. For very long IRs with significant late energy, there may be precision loss in the tail compared to a 64-bit output. Use 32-bit float export if this is a concern.

### Large files

Very long source files (>10 minutes) or high-order Ambisonic IRs with many channels may exceed browser memory limits. The application estimates memory before rendering, but the estimate may not account for all intermediate buffers. If the browser tab crashes or becomes unresponsive, reduce the file length or channel count.

## Formats

### AIFF and FLAC not supported

Only WAV is currently accepted. AIFF and FLAC support are planned for a future phase.

### Compressed source files

MP3 and AAC are not accepted. Lossy coding introduces artefacts that are difficult to separate from acoustic information. If your source material is only available in a compressed format, convert it to WAV 16-bit PCM using a lossless transcoder before use.

### Ambisonic validation

The Ambisonic format detection infers the likely format from channel count. It does not read embedded metadata (e.g. AmbiX RIFF metadata chunks). The user must confirm the format. Incorrect format selection (e.g. treating a quad recording as FOA) will produce incorrect results.

## Interface

### Preview pitch shift

The Web Audio API AudioContext runs at the browser's audio device sample rate, which may differ from the processed file sample rate. This can cause a slight pitch difference in preview. Export always uses the target sample rate.

### Safari Web Workers

Safari before version 17 may not support ES module Web Workers. The application falls back to main-thread processing, which will block the UI during convolution on long files.

## Not yet implemented

| Feature | Planned phase |
|---------|---------------|
| Logarithmic sweep deconvolution | Phase 3 |
| Full Ambisonics (ACN/SN3D/FuMa) | Phase 4 |
| Ambisonic rotation | Phase 4 |
| Binaural decoder with HRTF | Phase 4 |
| SOFA file loading | Phase 4 |
| ITU-R BS.1770 loudness | Phase 2 |
| Calibrated absolute levels | Phase 5 |
| Project/session saving | Phase 5 |
| Batch rendering | Phase 5 |
| AIFF and FLAC input | Future |
| MP3/AAC source input | Future (with warning) |

## Standards compliance

This application has not been formally validated against any acoustic measurement standard (ISO 3382, etc.). It is suitable for perceptual listening comparisons and research work where the processing chain is fully transparent. It should not be used for legally required acoustic compliance measurements without independent validation.
