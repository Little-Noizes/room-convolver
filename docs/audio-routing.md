# Audio Routing

## Overview

The routing matrix maps source channels to IR channels. No implicit or automatic mapping occurs. Every routing decision is recorded in the processing report.

## Available routing modes

### mono-mono

Source: 1 channel  
IR: 1 channel  
Output: 1 channel  

```
source[0] * IR[0] → output[0]
```

### mono-stereo

Source: 1 channel  
IR: 2 channels  
Output: 2 channels  

```
source[0] * IR[L] → output[L]
source[0] * IR[R] → output[R]
```

The mono source is convolved independently with the left and right IR channels. The two IRs should represent two different loudspeaker or microphone positions.

### mono-binaural

Source: 1 channel  
IR: 2 channels (confirmed binaural)  
Output: 2 channels  

```
source[0] * IR[left-ear]  → output[L]
source[0] * IR[right-ear] → output[R]
```

Inter-aural timing and level differences are preserved. Channels are **not** independently normalised. Intended for headphone playback.

### mono-ambisonic

Source: 1 channel  
IR: 4, 9, or 16 channels (Ambisonic)  
Output: 4, 9, or 16 channels  

```
for each Ambisonic channel k:
  source[0] * IR[k] → output[k]
```

The source is treated as a point source in the direction encoded by the IR. Channel order and normalisation are preserved from the loaded IR.

### stereo-direct

Source: ≥2 channels  
IR: ≥2 channels  
Output: 2 channels  

```
source[L] * IR[L] → output[L]
source[R] * IR[R] → output[R]
```

Simple direct pairing. Assumes the IR represents the same or equivalent spatial positions as the source channels. Not physically rigorous for asymmetric IRs.

### stereo-monosum-stereo

Source: ≥2 channels  
IR: ≥2 channels  
Output: 2 channels  

```
mono = (source[L] + source[R]) * gain
mono * IR[L] → output[L]
mono * IR[R] → output[R]
```

**Gain law options:**

| Law | Formula | Use |
|-----|---------|-----|
| Linear (default) | gain = 0.5 | Preserves level of a mono-compatible signal |
| Equal power | gain = 1/√2 | Preserves power of independent signals |

This is the recommended mode for stereo sources with a stereo IR. It produces a physically interpretable room convolution at the cost of source stereo width.

### stereo-monosum-binaural

Source: ≥2 channels  
IR: 2 channels (confirmed binaural)  
Output: 2 channels  

Same as `stereo-monosum-stereo` but with binaural IR. Recommended over `stereo-direct` for binaural rendering of stereo sources, because direct L/R pairing with a binaural IR produces unpredictable interactions between source panning and binaural spatial cues.

### stereo-monosum-ambisonic

Source: ≥2 channels  
IR: 4, 9, or 16 channels (Ambisonic)  
Output: 4, 9, or 16 channels  

Source summed to mono, then convolved with each Ambisonic channel.

### stereo-true

Source: 2 channels  
IR: exactly 4 channels (LL, LR, RL, RR)  
Output: 2 channels  

True stereo (four-path) convolution:

```
y_L = source[L] * IR_LL + source[R] * IR_RL
y_R = source[L] * IR_LR + source[R] * IR_RR
```

**Only enable this mode when the IR genuinely contains four transfer paths.** A standard two-channel IR file is not a true-stereo IR. Enabling this mode with only two IR channels will produce incorrect results.

## Routing selection logic

The application automatically selects a default routing mode based on source and IR channel counts and confirmed IR format. This auto-selection is conservative — it does not fabricate spatial information.

| Source | IR format | Default mode |
|--------|-----------|--------------|
| Mono | Mono | mono-mono |
| Mono | Stereo (confirmed) | mono-stereo |
| Mono | Binaural (confirmed) | mono-binaural |
| Mono | Ambisonic | mono-ambisonic |
| Stereo | Mono | — (stereo source with mono IR is ambiguous) |
| Stereo | Stereo (confirmed) | stereo-monosum-stereo |
| Stereo | Binaural (confirmed) | stereo-monosum-binaural |
| Stereo | Ambisonic | stereo-monosum-ambisonic |

The user can override the routing mode from the available options for the given channel combination.

## What routing cannot do

- Routing cannot create spatial information that does not exist in the IR
- A mono IR can only represent one transfer path — it cannot produce a spatial impression
- A two-channel IR that is not a confirmed binaural or true-stereo IR represents two arbitrary transfer paths
- `stereo-direct` does not produce a spatially richer result than `stereo-monosum-stereo` unless the IR captures genuinely different acoustic paths for left and right
