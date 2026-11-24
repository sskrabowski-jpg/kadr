// Browser-side recording: screen and/or camera + mic, composited into one stream.
//
// In "screen+cam" mode the camera bubble is drawn onto a canvas together with the
// screen, so it is part of the video no matter which window/tab is shared.
// The draw loop is driven by a Web Worker timer: requestAnimationFrame and main-thread
// timers are throttled when the user switches away from our tab, which is exactly
// what happens while recording the screen.

export const MODES = {
  'screen+cam': { screen: true, cam: true, label: 'Экран + камера' },
  screen: { screen: true, cam: false, label: 'Только экран' },
  cam: { screen: false, cam: true, label: 'Только камера' },
};

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export function isSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export function canRecordScreen() {
  return !!navigator.mediaDevices?.getDisplayMedia;
}

export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cams: all.filter((d) => d.kind === 'videoinput'),
    mics: all.filter((d) => d.kind === 'audioinput'),
  };
}

/** Camera + mic preview stream used before recording starts (and reused during it). */
export async function openCamera({ camId, micId, video = true, audio = true }) {
  if (!video && !audio) return null;
  return navigator.mediaDevices.getUserMedia({
    video: video
      ? { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }
      : false,
    audio: audio
      ? { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true }
      : false,
  });
}

export async function openScreen() {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 }, width: { max: 1920 }, height: { max: 1080 } },
    audio: true, // system / tab audio if the user ticks it in the picker
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  });
}

function tickerWorker(fps) {
  const src = `let t=setInterval(()=>postMessage(0),${Math.round(1000 / fps)});onmessage=()=>clearInterval(t);`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}

function videoEl(stream) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  v.play().catch(() => {});
  return v;
}

/** Mixes every audio track (mic + system audio) into one. */
function mixAudio(streams) {
  const tracks = streams.flatMap((s) => (s ? s.getAudioTracks() : []));
  if (tracks.length === 0) return { track: null, close() {} };
  if (tracks.length === 1) return { track: tracks[0], close() {} };
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  for (const t of tracks) ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
  return { track: dest.stream.getAudioTracks()[0], close: () => ctx.close() };
}

/**
 * Builds the stream that goes into MediaRecorder.
 * @returns {{ stream: MediaStream, stop(): void, setBubble(pos): void }}
 */
export function composeStream({ mode, screen, camera }) {
  const audio = mixAudio([camera, screen]);
  const withAudio = (videoTrack) =>
    new MediaStream([videoTrack, ...(audio.track ? [audio.track] : [])]);

  if (mode === 'cam') {
    return { stream: withAudio(camera.getVideoTracks()[0]), stop: audio.close, setBubble() {} };
  }
  const camTrack = camera?.getVideoTracks()[0];
  if (mode === 'screen' || !camTrack) {
    return { stream: withAudio(screen.getVideoTracks()[0]), stop: audio.close, setBubble() {} };
  }

  // screen + camera bubble on a canvas
  const fps = 30;
  const screenV = videoEl(screen);
  const camV = videoEl(new MediaStream([camTrack]));
  const s = screen.getVideoTracks()[0].getSettings();
  const canvas = document.createElement('canvas');
  canvas.width = s.width || 1920;
  canvas.height = s.height || 1080;
  const ctx = canvas.getContext('2d', { alpha: false });
  let bubble = 'bottom-left';

  const draw = () => {
    const sw = screenV.videoWidth;
    const sh = screenV.videoHeight;
    if (sw && sh && (sw !== canvas.width || sh !== canvas.height)) {
      canvas.width = sw; // user switched to a window of a different size
      canvas.height = sh;
    }
    const W = canvas.width;
    const H = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (sw) ctx.drawImage(screenV, 0, 0, W, H);
    if (bubble === 'hidden' || !camV.videoWidth) return;

    const d = Math.round(Math.min(W, H) * 0.26);
    const m = Math.round(d * 0.12);
    const x = bubble.endsWith('left') ? m : W - d - m;
    const y = bubble.startsWith('top') ? m : H - d - m;
    const cw = camV.videoWidth;
    const ch = camV.videoHeight;
    const side = Math.min(cw, ch); // center-crop to a square
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(camV, (cw - side) / 2, (ch - side) / 2, side, side, x, y, d, d);
    ctx.restore();
    ctx.lineWidth = Math.max(3, d * 0.025);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2 - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
  };

  const ticker = tickerWorker(fps);
  ticker.onmessage = draw;
  draw();
  const canvasTrack = canvas.captureStream(fps).getVideoTracks()[0];

  return {
    stream: withAudio(canvasTrack),
    setBubble(pos) {
      bubble = pos;
    },
    stop() {
      ticker.postMessage('stop');
      ticker.terminate();
      canvasTrack.stop();
      screenV.srcObject = null;
      camV.srcObject = null;
      audio.close();
    },
  };
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function streamHasVideo(stream) {
  return !!stream?.getVideoTracks().some((t) => t.readyState === 'live');
}
