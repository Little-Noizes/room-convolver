/**
 * WAV decoder
 *
 * Decodes PCM WAV files (8, 16, 24, 32-bit integer; 32/64-bit float).
 * Returns per-channel Float32Arrays, which is the internal representation
 * throughout this application.
 *
 * Does NOT use the Web Audio API decodeAudioData() path deliberately:
 * that path can apply format-dependent resampling on some browsers.
 * This decoder gives us exact samples at the original sample rate.
 */

export interface WavDecodeResult {
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  bitDepth: number;
  isFloat: boolean;
  channels: Float32Array[];
}

const RIFF_MAGIC = 0x52494646; // 'RIFF'
const WAVE_MAGIC = 0x57415645; // 'WAVE'
const FMT_MAGIC  = 0x666d7420; // 'fmt '
const DATA_MAGIC = 0x64617461; // 'data'

const FORMAT_PCM   = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXT   = 0xFFFE; // WAVE_FORMAT_EXTENSIBLE

export function decodeWav(buffer: ArrayBuffer): WavDecodeResult {
  const view = new DataView(buffer);
  let pos = 0;

  const readU32LE = (): number => { const v = view.getUint32(pos, true); pos += 4; return v; }
  const readU32BE = (): number => { const v = view.getUint32(pos, false); pos += 4; return v; }
  const readU16LE = (): number => { const v = view.getUint16(pos, true); pos += 2; return v; }

  const riff = readU32BE();
  if (riff !== RIFF_MAGIC) throw new Error('Not a RIFF file. Only WAV files are supported.');

  pos += 4; // fileSize

  const wave = readU32BE();
  if (wave !== WAVE_MAGIC) throw new Error('RIFF file is not WAVE format.');

  let audioFormat   = 0;
  let channelCount  = 0;
  let sampleRate    = 0;
  let bitDepth      = 0;
  let dataStart     = -1;
  let dataByteLen   = 0;

  // Walk chunks
  while (pos < buffer.byteLength - 8) {
    const chunkId   = readU32BE();
    const chunkSize = readU32LE();
    const chunkEnd  = pos + chunkSize;

    if (chunkId === FMT_MAGIC) {
      audioFormat  = readU16LE();
      channelCount = readU16LE();
      sampleRate   = readU32LE();
      pos += 4; // byteRate
      pos += 2; // blockAlign
      bitDepth     = readU16LE();

      // WAVE_FORMAT_EXTENSIBLE: read the sub-format GUID
      if (audioFormat === FORMAT_EXT && chunkSize >= 18) {
        pos += 2; // cbSize
        pos += 2; // wValidBitsPerSample
        pos += 4; // dwChannelMask
        // subFormat GUID: first 2 bytes are the actual format code
        const subFormat = readU16LE();
        audioFormat = subFormat;
        pos += 14; // remaining 14 bytes of GUID
      }
    } else if (chunkId === DATA_MAGIC) {
      dataStart   = pos;
      dataByteLen = chunkSize;
    }

    pos = chunkEnd;
    // Pad to even byte boundary
    if (pos % 2 !== 0) pos++;
  }

  if (dataStart === -1) throw new Error('WAV file contains no data chunk.');
  if (channelCount === 0) throw new Error('WAV file has zero channels.');
  if (sampleRate === 0) throw new Error('WAV file has zero sample rate.');

  const isFloat  = (audioFormat === FORMAT_FLOAT);
  const isPCM    = (audioFormat === FORMAT_PCM);

  if (!isFloat && !isPCM) {
    throw new Error(
      `Unsupported WAV audio format: 0x${audioFormat.toString(16).toUpperCase()}. ` +
      `Only PCM (1) and IEEE float (3) are supported. ` +
      `Compressed or proprietary formats must be converted before use.`
    );
  }

  const bytesPerSample = bitDepth / 8;
  const frameCount = Math.floor(dataByteLen / (channelCount * bytesPerSample));

  if (frameCount === 0) throw new Error('WAV data chunk is empty.');

  // Allocate output channels
  const channels: Float32Array[] = Array.from({ length: channelCount }, () => new Float32Array(frameCount));

  const dataView = new DataView(buffer, dataStart, dataByteLen);
  let bytePos = 0;

  // Decode interleaved samples
  for (let f = 0; f < frameCount; f++) {
    for (let c = 0; c < channelCount; c++) {
      let sample: number;

      if (isFloat && bitDepth === 32) {
        sample = dataView.getFloat32(bytePos, true);
        bytePos += 4;
      } else if (isFloat && bitDepth === 64) {
        sample = dataView.getFloat64(bytePos, true);
        bytePos += 8;
      } else if (bitDepth === 16) {
        sample = dataView.getInt16(bytePos, true) / 32768.0;
        bytePos += 2;
      } else if (bitDepth === 24) {
        // 24-bit is not natively supported by DataView
        const b0 = dataView.getUint8(bytePos);
        const b1 = dataView.getUint8(bytePos + 1);
        const b2 = dataView.getUint8(bytePos + 2);
        let raw = (b2 << 16) | (b1 << 8) | b0;
        if (raw & 0x800000) raw |= 0xFF000000; // sign extend
        sample = raw / 8388608.0;
        bytePos += 3;
      } else if (bitDepth === 32 && isPCM) {
        sample = dataView.getInt32(bytePos, true) / 2147483648.0;
        bytePos += 4;
      } else if (bitDepth === 8) {
        // 8-bit WAV is unsigned
        sample = (dataView.getUint8(bytePos) - 128) / 128.0;
        bytePos += 1;
      } else {
        throw new Error(`Unsupported bit depth: ${bitDepth}`);
      }

      channels[c][f] = sample as number;
    }
  }

  return { sampleRate, channelCount, frameCount, bitDepth, isFloat, channels };
}
