# Live financial dictation

## Accepted direction

Preserve Anotto's existing composer. Use browser recognition for provisional words, with a private cloud transcription that corrects the complete recording. Show progress without moving focus, stop after 1.8 seconds of silence, and retain explicit financial confirmation. Keep navigation explorations local-only.

## Model and boundaries

- Previous audio fallback: `google/gemini-2.5-flash-lite`. Current final transcription: `google/gemini-2.5-flash` through OpenRouter, with zero-data-retention routing and data collection denied.
- The browser's speech engine supplies immediate hypotheses when available; it is not Gemini. Cloud prefix updates provide an alternative if browser recognition is unavailable or fails.
- Use complete 16kHz mono WAV snapshots from an AudioWorklet for cloud updates, avoiding unfinished WebM/MP4 containers. Keep MediaRecorder as a final-recording fallback when PCM capture is unavailable.
- At most three prefix requests and one final request, serialized within an owner-bound session. A session lasts 150 seconds and consumes one analysis quota unit. The subsequent transaction analysis remains a separate action.
- Maximum recording length: 60 seconds. No speech for six seconds produces a recoverable message without submitting empty audio. After speech, 1.8 seconds of silence ends recording.
- Financial, unrelated and unclear classifications describe the spoken evidence. Unrelated speech receives an example and a correction prompt; it never creates a transaction. A manual correction hides stale relevance warnings.
- Manual edits are preserved when a delayed transcript arrives. Analysis and manual creation wait until recording/transcription finishes. Microphone tracks, audio nodes and pending UI callbacks are released on cancellation/unmount.
- No audio or transcripts are stored by this feature. Session storage contains quota metadata only; anonymous/browser database roles cannot call its quota RPC.

## Validation

Focused failing tests preceded the model, interim-result, voice-activity, WAV and busy-state changes. PostgreSQL tests cover one-unit reservation, ordered updates, replay, closed/expired sessions, quota exhaustion and role permissions.

- Web: 225 files / 1,302 tests passed; typecheck and production build passed; lint passed with one existing React Hook Form compiler warning.
- Backend: 119 files / 916 tests passed, followed by focused tests including the new session SQL tests; typecheck and source lint passed.
- Live synthetic Spanish audio recognized 50,000 pesos and Nequi. The unrelated weather/dog sentence was transcribed and classified as unrelated. Two dictations across three provider requests used two quota units. Synthetic owners were deleted.
- Authenticated browser checks confirmed provisional text before the AI response, silence stop, a cloud update while still recording, complete WAV updates in one session, unrelated-content feedback and no viewport overflow at 1440px/390px. Three dictations consumed three units; synthetic owners were deleted.

## Release evidence

Migration: `20261013000059_audio_transcription_sessions`.
Worker version: `38d26043-c239-4ecd-8558-230ce39b9f72`.
Web production check: `dpl_FqLQAeCDubQpvCb8P5cmwiSvqVNQ`, all six authenticated browser checks passed with three quota units for three dictations and successful synthetic-owner cleanup. Final release: `dpl_Ca8EzzcbhFetFbLRtUFoPm6dSFZ3`, ready at https://my.anotto.app; it contains the same application code and additionally excludes local design files from uploads through web `.vercelignore`.

Navigation proposals run only at http://localhost:4317 from the web repository's `scripts/design-preview.ts`; their local-only preference remains in web AGENTS.md.

## Owner check

Say a real amount and destination, watch the provisional text, then pause. Verify the final amount/name before pressing Analyze. Try an unrelated sentence and manually correct it; the warning should disappear. Browser/service latency and the physical microphone still require the owner's device check; synthetic audio does not establish accuracy for every accent or noisy room.

## Primary references

- https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/interimResults
- https://openrouter.ai/google/gemini-2.5-flash
- https://openrouter.ai/docs/guides/overview/multimodal/audio
- https://vercel.com/docs/deployments/vercel-ignore

## Short-dictation follow-up

On 2026-10-13, the prompt was extended to accept an item plus an amount without requiring a payment verb. Live synthetic fixtures for potatoes, coffee and taxi were financial; the unrelated weather fixture remained unrelated. Both WAV input and a finalized Chrome MediaRecorder WebM preserved the short potatoes/10,000 example. Each four-dictation check consumed four quota units and deleted its synthetic owner. Worker version: `8a0c0df1-f80a-43f5-a908-198d24442806`.

The corresponding web update starts MediaRecorder before AudioWorklet initialization, sends the complete finalized container for the final request, and retains WAV snapshots for prefix updates. Successful status and permanent help copy were removed from the composer; privacy and quota details remain in the microphone tooltip. Physical microphone accuracy still needs an owner-device check.
