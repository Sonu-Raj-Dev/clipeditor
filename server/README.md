# Video Processing Server

- Start: `npm run dev`
- Port: 4000 (override with PORT)
- Upload limit: 1GB

Place royalty-free background music files under `assets/audio` (mp3/wav/aac/ogg). The server will randomly pick one when `addBgm` is on.

Endpoints:
- POST `/api/upload` (multipart, field `video`) -> `{ fileId }`
- GET `/api/preview?fileId=...&duration=...&brightness=...&contrast=...&noiseReduction=on|off&addBgm=on|off&bgmVolume=...&cropResize=on|off&copyrightAvoid=on|off&pitchShift=...&tempo=...` -> MP4 stream
- POST `/api/export` body `{ fileId, options }` -> `{ jobId }` then subscribe `GET /api/progress/:jobId` (SSE)
- GET `/api/download/:file` -> download final file
- POST `/api/split` body `{ fileId, segments: [{start, end}, ...] }` -> `{ downloadUrl }` zip of clips
- GET `/api/presets` / POST `/api/presets`