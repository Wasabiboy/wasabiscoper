// Offscreen document: runs MediaRecorder for screen + mic capture.
// Chrome service workers can't use getUserMedia / getDisplayMedia, so we do it here.

let mediaRecorder = null;
let chunks = [];
let stream = null;
let micStream = null;

async function startRecording({ includeMic, includeAudio }) {
  try {
    chunks = [];

    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15 },
      audio: !!includeAudio
    });

    if (includeMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStream.getAudioTracks().forEach(t => stream.addTrack(t));
      } catch (e) {
        console.warn('[offscreen] mic denied:', e.message);
      }
    }

    // If user stops sharing via the browser bar, finalise.
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    });

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000 });
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      chrome.runtime.sendMessage({
        type: 'RECORDING_BLOB_READY',
        url,
        mimeType,
        size: blob.size
      });
      stream.getTracks().forEach(t => t.stop());
      if (micStream) micStream.getTracks().forEach(t => t.stop());
      stream = null;
      micStream = null;
    };

    mediaRecorder.start(1000); // 1s chunks
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STARTED' });
  } catch (e) {
    console.error('[offscreen] start failed:', e);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: e.message });
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: 'No active recording' });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_START') startRecording({ includeMic: msg.includeMic, includeAudio: msg.includeAudio });
  if (msg.type === 'OFFSCREEN_STOP') stopRecording();
});
