`mediarecorder_chromium_vp9_opus.webm`: 6 s, 1280x720, VP9 + Opus, recorded by the desktop app's own
capture module (`desktop/src/renderer/capture.ts`) in Chrome for Testing 153 under Xvfb, with a
pause in the middle. It is what a real browser `MediaRecorder` produces: no duration in the
container header (ffprobe says N/A), no cues, variable frame rate. Regenerate with
`desktop/test/browser/run-capture.mjs`.
