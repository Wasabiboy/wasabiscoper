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

// Voice-only capture for chat (side panel cannot use getUserMedia reliably in MV3).
let voiceRecorder = null;
let voiceChunks = [];
let voiceStream = null;

async function startVoiceRecording() {
  if (voiceRecorder?.state === 'recording') return;
  try {
    voiceChunks = [];
    voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';
    voiceRecorder = new MediaRecorder(voiceStream, { mimeType });
    voiceRecorder.ondataavailable = (e) => {
      if (e.data?.size) voiceChunks.push(e.data);
    };
    voiceRecorder.onstop = () => {
      const blob = new Blob(voiceChunks, { type: mimeType });
      voiceChunks = [];
      voiceStream?.getTracks().forEach((t) => t.stop());
      voiceStream = null;
      voiceRecorder = null;

      if (blob.size < 400) {
        chrome.runtime.sendMessage({ type: 'VOICE_RECORD_ERROR', error: 'Recording too short — speak longer, then tap 🎤 again.' });
        return;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        chrome.runtime.sendMessage({
          type: 'VOICE_BLOB_READY',
          dataUrl: reader.result,
          mimeType,
          size: blob.size
        });
      };
      reader.onerror = () => {
        chrome.runtime.sendMessage({ type: 'VOICE_RECORD_ERROR', error: 'Could not read audio clip' });
      };
      reader.readAsDataURL(blob);
    };
    voiceRecorder.onerror = (e) => {
      chrome.runtime.sendMessage({ type: 'VOICE_RECORD_ERROR', error: e.error?.message || 'Recorder error' });
    };
    voiceRecorder.start(200);
    chrome.runtime.sendMessage({ type: 'VOICE_RECORD_STARTED' });
  } catch (e) {
    console.error('[offscreen] voice start failed:', e);
    voiceStream?.getTracks().forEach((t) => t.stop());
    voiceStream = null;
    chrome.runtime.sendMessage({
      type: 'VOICE_RECORD_ERROR',
      error: e.name === 'NotAllowedError'
        ? 'Microphone permission denied — allow mic for Wasabi Scope when Chrome prompts.'
        : e.message
    });
  }
}

function stopVoiceRecording() {
  if (voiceRecorder?.state === 'recording') {
    voiceRecorder.stop();
  } else {
    chrome.runtime.sendMessage({ type: 'VOICE_RECORD_ERROR', error: 'Not recording' });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_START') startRecording({ includeMic: msg.includeMic, includeAudio: msg.includeAudio });
  if (msg.type === 'OFFSCREEN_STOP') stopRecording();
  if (msg.type === 'OFFSCREEN_VOICE_START') startVoiceRecording();
  if (msg.type === 'OFFSCREEN_VOICE_STOP') stopVoiceRecording();
});
