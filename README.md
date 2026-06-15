# Room Convolver

**Browser-based acoustic convolution and spatial auralisation**

Room Convolver combines source audio with measured acoustic impulse responses using high-quality offline processing, entirely in the browser. Nothing is uploaded to a server.

This is not a generic reverb plugin. It is a technically transparent acoustic auralisation tool designed for acoustic researchers, audio engineers, and technically interested listeners.

---

## Contents

- [Features](#features)
- [Live demo](#live-demo)
- [Technical limitations](#technical-limitations)
- [Supported formats](#supported-formats)
- [Browser support](#browser-support)
- [Setup and development](#setup-and-development)
- [Build and deploy](#build-and-deploy)
- [GitHub Pages deployment](#github-pages-deployment)
- [Running tests](#running-tests)
- [Test data](#test-data)
- [Privacy](#privacy)
- [Validation status](#validation-status)
- [Roadmap](#roadmap)
- [Licences](#licences)

---

## Features

### Phase 1 (current)

- Upload WAV source material (mono or stereo)
- Upload WAV impulse response (mono, stereo, binaural, or Ambisonic)
- Inspect both files: sample rate, duration, channel count, peak, RMS, estimated onset, estimated noise floor
- Explicit format confirmation for ambiguous channel counts
- Explicit source-to-IR routing matrix:
  - Mono → mono
  - Mono → stereo (L and R convolved independently)
  - Mono → binaural (L-ear and R-ear convolved independently)
  - Mono → Ambisonic (mono source convolved with each Ambisonic channel)
  - Stereo direct pairing (L→L, R→R)
  - Stereo mono-sum → stereo
  - Stereo mono-sum → binaural
  - Stereo mono-sum → Ambisonic
  - True stereo (four-path, requires 4 IR channels)
- High-quality Lanczos-windowed sinc sample-rate conversion
- Partitioned overlap-add FFT convolution (full IR tail preserved)
- IR preprocessing: onset detection, trimming, DC removal, high-pass filter, fade-in/out
- Gain modes: preserve linear gain, peak normalise, loudness normalise (approximate)
- WAV export: 16-bit PCM, 24-bit PCM, 32-bit float, with optional TPDF dither
- A/B dry/wet comparison preview
- Complete processing report, downloadable as JSON
- Interpretive warnings for ambiguous inputs and routing choices
- Basic and Advanced interface modes

### Planned (future phases)

- Phase 2: Web Workers for off-thread convolution, advanced metering, robust WAV edge cases
- Phase 3: Logarithmic sine sweep deconvolution and IR derivation
- Phase 4: Full Ambisonics (FOA/2OA/3OA), ACN/SN3D/FuMa conversion, binaural decode, rotation
- Phase 5: Calibrated absolute levels, project session files, venue atlas integration

---

## Live demo

[room-convolver.github.io/room-convolver](https://room-convolver.github.io/room-convolver/) *(deploy to activate)*

---

## Technical limitations

**Sample-rate conversion.** The current SRC uses a Lanczos-windowed sinc kernel. It is suitable for most use cases but is not equivalent to a dedicated hardware or WASM SRC library (e.g. libsamplerate). Future phases may substitute a WASM SRC for critical work.

**Loudness normalisation.** The current implementation uses RMS as a proxy for integrated loudness. True ITU-R BS.1770 integrated loudness requires a K-weighting filter chain, which is not yet implemented.

**Binaural decode.** The current release passes binaural IRs through the convolution engine but does not include a generalised Ambisonic-to-binaural decoder. This is planned for Phase 4.

**Ambisonics.** The data models and routing modes for Ambisonic processing are implemented. Full ACN/SN3D/FuMa conversion, rotation, and binaural decode are planned for Phase 4.

**Preview sample rate.** The Web Audio API AudioContext may run at a different sample rate from the processed file (typically 44.1 or 48 kHz depending on the system audio device). This may cause a slight pitch difference in preview. Export always uses the correct target sample rate.

**Memory.** Very long files or high channel counts may exhaust browser memory. The application estimates requirements before rendering and warns if limits are likely to be exceeded.

**Sweep deconvolution.** Not yet implemented (Phase 3).

**Calibrated absolute levels.** Not yet implemented (Phase 5).

---

## Supported formats

| Format | Source | IR |
|--------|--------|----|
| WAV 8-bit PCM | ✓ | ✓ |
| WAV 16-bit PCM | ✓ | ✓ |
| WAV 24-bit PCM | ✓ | ✓ |
| WAV 32-bit PCM | ✓ | ✓ |
| WAV 32-bit float | ✓ | ✓ |
| WAV 64-bit float | ✓ | ✓ |
| WAVE_FORMAT_EXTENSIBLE | ✓ | ✓ |
| AIFF | ✗ | ✗ |
| FLAC | ✗ | ✗ |
| MP3 | ✗ | ✗ |
| AAC | ✗ | ✗ |

Compressed formats (MP3, AAC) are not accepted for impulse responses. Lossy coding alters transient shape, noise floor, phase characteristics and decay behaviour in ways that make the IR unsuitable for accurate acoustic auralisation.

---

## Browser support

| Browser | Status |
|---------|--------|
| Chrome 120+ | ✓ Fully supported |
| Edge 120+ | ✓ Fully supported |
| Firefox 120+ | ✓ Fully supported |
| Safari 17+ | ✓ Largely supported |
| Safari < 17 | ⚠ Web Worker module scripts may fail; falls back to main-thread processing |

---

## Setup and development

```bash
# Clone the repository
git clone https://github.com/your-org/room-convolver.git
cd room-convolver

# Install dependencies
npm install

# Start development server
npm run dev
```

The development server runs at `http://localhost:5173`.

### Generate test signals

```bash
node generate-test-signals.mjs
```

Writes synthetic WAV test files to `test-data/`. These are clearly labelled synthetic signals and do not represent real venues.

---

## Build and deploy

```bash
# Type-check and build for production
npm run build

# Preview the production build locally
npm run preview
```

The build output is in `dist/`. It is a static site with no server-side dependencies.

---

## GitHub Pages deployment

### Automatic (recommended)

Push to the `main` branch. The included GitHub Actions workflow (`.github/workflows/deploy.yml`) will:

1. Run all DSP tests
2. Build the production bundle with the correct base path
3. Deploy to GitHub Pages

**Before first deployment:**

1. Go to your repository **Settings → Pages**
2. Set Source to **GitHub Actions**
3. In `.github/workflows/deploy.yml`, set `VITE_BASE_PATH` to your repository name:

```yaml
env:
  VITE_BASE_PATH: /your-repo-name/
```

If you are deploying to a custom domain or a user/organisation root page (`username.github.io`), set `VITE_BASE_PATH: /`.

### Manual

```bash
VITE_BASE_PATH=/room-convolver/ npm run build
# Upload the dist/ folder to your static host
```

---

## Running tests

```bash
npm test
```

Runs 29 automated DSP tests covering:

- **Convolution**: unit impulse identity, delayed impulse, output length, gain scaling, silence, known polynomial results
- **Routing**: all nine routing modes, channel count validation, error messages
- **Resampling**: duration accuracy, multichannel timing synchronisation
- **WAV codec**: 16/24/32-bit encode/decode roundtrip, stereo channel separation, header accuracy
- **Metering**: peak, RMS, dB conversion

---

## Test data

The `test-data/` directory contains synthetically generated WAV files:

| File | Description |
|------|-------------|
| `dry-impulse.wav` | Unit impulse source |
| `dry-sine-440hz.wav` | 440 Hz sine, 1s, mono |
| `dry-sine-1khz.wav` | 1 kHz sine, 1s, mono |
| `dry-whitenoise.wav` | White noise, 1s, mono |
| `dry-stereo-sine.wav` | 440/880 Hz stereo sine pair |
| `ir-unit-impulse.wav` | Unit impulse IR (validation: output = source) |
| `ir-delayed-10ms.wav` | 10 ms delayed impulse (validation: delay test) |
| `ir-mono-room.wav` | Synthetic mono room decay |
| `ir-stereo-room.wav` | Synthetic stereo room decay |
| `ir-pure-decay-1s.wav` | Pure exponential decay, RT60 = 1 s |

**These are synthetic signals.** They do not represent real rooms or venues. Do not use them to make claims about real acoustic spaces.

---

## Privacy

> Audio files are processed locally in your browser. They are not uploaded to any server.

This is verifiable by:
- Inspecting the network activity in your browser's developer tools while processing files
- Reviewing the source code — all processing occurs in the browser's JavaScript engine and Web Workers
- The application has no backend, no API calls to audio services, and no analytics that capture file content or metadata

---

## Validation status

The convolution engine has been validated against:

- Unit impulse identity (output equals input)
- Delayed impulse (output is correctly delayed)
- Known short FIR filter results (polynomial convolution)
- Silence input produces silence output
- Output length equals N_source + N_IR − 1

A formal comparison against an offline reference implementation (Python/NumPy `scipy.signal.fftconvolve`) is planned for the Phase 2 validation report.

**Not yet formally validated:**

- Loudness normalisation against ITU-R BS.1770
- Sample-rate conversion frequency response and anti-alias performance
- Ambisonic rotation matrices (Phase 4)

---

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✓ Complete | WAV upload, mono/stereo, offline convolution, preview, export |
| 2 | Planned | Web Workers, partitioned convolution off-thread, advanced metering, processing report improvements |
| 3 | Planned | Logarithmic sweep deconvolution, harmonic response separation, IR export |
| 4 | Planned | Full Ambisonics (FOA/2OA/3OA), binaural decode, HRTF selection |
| 5 | Planned | Calibrated absolute levels, session files, venue atlas integration |

---

## Licences

### Application

MIT Licence — see `LICENSE`.

### Dependencies

| Package | Licence |
|---------|---------|
| react | MIT |
| react-dom | MIT |
| vite | MIT |
| @vitejs/plugin-react | MIT |
| typescript | Apache-2.0 |
| vitest | MIT |

All dependencies are open-source, free to use for any purpose, and do not require a server.

### Test signals

The synthetic test signals in `test-data/` are generated by `generate-test-signals.mjs` and are released under MIT. They contain no copyrighted material.

---

## Acoustic interpretation note

Perceived differences between acoustic software packages are frequently caused by IR quality, sample-rate conversion approach, IR truncation, onset alignment, normalisation, routing choices, and binaural decoding — not by the mathematical convolution operation itself, which is deterministic.

This application makes all such transformations visible, explicit, and configurable. The processing report records exactly what was applied to each render.
