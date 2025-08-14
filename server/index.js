const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const ffmpeg = require('fluent-ffmpeg');
const archiver = require('archiver');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 4000;
const ROOT = __dirname;
const TMP_DIR = path.join(ROOT, 'tmp');
const UPLOAD_DIR = path.join(TMP_DIR, 'uploads');
const OUTPUT_DIR = path.join(TMP_DIR, 'outputs');
const DATA_DIR = path.join(ROOT, 'data');
const ASSETS_AUDIO_DIR = path.join(ROOT, 'assets', 'audio');

for (const dir of [TMP_DIR, UPLOAD_DIR, OUTPUT_DIR, DATA_DIR, ASSETS_AUDIO_DIR]) {
	fse.ensureDirSync(dir);
}

// Multer storage
const storage = multer.diskStorage({
	destination: function (req, file, cb) {
		cb(null, UPLOAD_DIR);
	},
	filename: function (req, file, cb) {
		const id = uuidv4();
		const ext = path.extname(file.originalname) || '.mp4';
		cb(null, `${id}${ext}`);
	}
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } }); // 1GB

// In-memory job progress
const jobProgress = new Map(); // jobId -> { percent, status }
const sseClients = new Map(); // jobId -> Set(res)

function sendSse(jobId, data) {
	const clients = sseClients.get(jobId);
	if (!clients) return;
	for (const res of clients) {
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	}
}

function registerSse(jobId, res) {
	if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
	sseClients.get(jobId).add(res);
	res.on('close', () => {
		sseClients.get(jobId)?.delete(res);
	});
}

function cleanupOldFiles() {
	const ttlMs = 60 * 60 * 1000; // 1 hour
	const now = Date.now();
	for (const base of [UPLOAD_DIR, OUTPUT_DIR]) {
		for (const name of fs.readdirSync(base)) {
			try {
				const file = path.join(base, name);
				const stat = fs.statSync(file);
				if (now - stat.mtimeMs > ttlMs) {
					fse.removeSync(file);
				}
			} catch {}
		}
	}
}
setInterval(cleanupOldFiles, 10 * 60 * 1000);

function buildVideoFilterGraph(opts) {
	const filters = [];
	// Brightness/Contrast/Color grading
	const brightness = Number(opts.brightness ?? 0); // -1..1 typical for ffmpeg eq
	const contrast = Number(opts.contrast ?? 1); // 0..2
	const saturation = opts.colorGrade === 'on' || opts.saturation ? Number(opts.saturation || 1.05) : 1;
	const gamma = opts.colorGrade === 'on' || opts.gamma ? Number(opts.gamma || 1.02) : 1;
	if (brightness !== 0 || contrast !== 1 || saturation !== 1 || gamma !== 1) {
		filters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}:gamma=${gamma}`);
	}
	// Slight crop/resize to avoid simple matches
	if (opts.cropResize === 'on' || opts.crop === 'on') {
		// Crop 2% then scale back up
		filters.push('crop=iw*0.98:ih*0.98');
		filters.push('scale=trunc(iw/0.98/2)*2:trunc(ih/0.98/2)*2');
	}
	return filters.join(',');
}

function buildAudioFilterGraph(opts) {
	const filters = [];
	if (opts.noiseReduction === 'on') {
		// Mild noise reduction and bandpass
		filters.push('highpass=f=100,lowpass=f=10000,afftdn=nr=12');
	}
	// Background music ducking handled via amix in pipeline if bgm provided
	// Pitch/tempo shift for copyright avoidance
	if (opts.copyrightAvoid === 'on' || opts.pitchShift || opts.tempo) {
		const pitch = Number(opts.pitchShift || 1.03); // 3% up
		const tempo = Number(opts.tempo || 0.98); // 2% slower
		// asetrate to change pitch, then aresample to original, then atempo for tempo tweak
		filters.push(`asetrate=sr*${pitch},aresample=sr,atempo=${tempo / pitch}`);
	}
	return filters.join(',');
}

function listAudioAssets() {
	try {
		const files = fs.readdirSync(ASSETS_AUDIO_DIR)
			.filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f))
			.map((f) => path.join(ASSETS_AUDIO_DIR, f));
		return files;
	} catch {
		return [];
	}
}

app.get('/api/health', (req, res) => {
	res.json({ ok: true });
});

app.post('/api/upload', upload.single('video'), (req, res) => {
	if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
	const filePath = path.join(UPLOAD_DIR, path.basename(req.file.filename));
	ffmpeg.ffprobe(filePath, (err, metadata) => {
		if (err) {
			try { fse.removeSync(filePath); } catch {}
			return res.status(400).json({ error: 'Unsupported or corrupted file' });
		}
		const hasVideo = (metadata.streams || []).some((s) => s.codec_type === 'video');
		if (!hasVideo) {
			try { fse.removeSync(filePath); } catch {}
			return res.status(400).json({ error: 'No video stream found' });
		}
		res.json({ fileId: path.basename(req.file.filename), originalName: req.file.originalname, duration: metadata.format?.duration });
	});
});

app.get('/api/preview', async (req, res) => {
	const { fileId } = req.query;
	if (!fileId) return res.status(400).json({ error: 'fileId required' });
	const inputPath = path.join(UPLOAD_DIR, String(fileId));
	if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });
	const start = Number(req.query.start || 0);
	const duration = Number(req.query.duration || 5);

	const vFilters = buildVideoFilterGraph(req.query);
	const aFilters = buildAudioFilterGraph(req.query);

	res.setHeader('Content-Type', 'video/mp4');
	res.setHeader('Cache-Control', 'no-cache');

	let command = ffmpeg(inputPath)
		.inputOptions(['-ss', `${Math.max(0, start)}`])
		.outputOptions(['-movflags', 'frag_keyframe+empty_moov+faststart'])
		.videoCodec('libx264')
		.audioCodec('aac')
		.format('mp4')
		.duration(duration)
		.outputOptions(['-preset', 'veryfast', '-crf', '28']);

	if (vFilters) command = command.videoFilters(vFilters);
	if (aFilters) command = command.audioFilters(aFilters);

	// Optional background music for preview if requested
	if (req.query.addBgm === 'on') {
		const assets = listAudioAssets();
		if (assets.length > 0) {
			const bgmPath = assets[Math.floor(Math.random() * assets.length)];
			command = ffmpeg()
				.addInput(inputPath)
				.inputOptions(['-ss', `${Math.max(0, start)}`])
				.addInput(bgmPath)
				.outputOptions(['-t', `${duration}`])
				.videoCodec('libx264')
				.audioCodec('aac')
				.outputOptions(['-preset', 'veryfast', '-crf', '28'])
				.outputOptions(['-movflags', 'frag_keyframe+empty_moov+faststart'])
				.format('mp4');
			if (vFilters) command = command.videoFilters(vFilters);
			const bgmVol = Number(req.query.bgmVolume || 0.08);
			const aCombined = [aFilters].filter(Boolean).join(',');
			// amix main audio at 1.0 and bgm low volume
			const amix = `volume=${bgmVol}[bgm];[0:a]${aCombined ? aCombined + ',' : ''}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0];[a0][bgm]amix=inputs=2:duration=shortest:dropout_transition=2[a]`;
			command = command.complexFilter([
				...(vFilters ? [{ filter: vFilters, inputs: '0:v', outputs: 'v' }] : []),
				{ filter: amix, inputs: ['1:a', '0:a'], outputs: ['a'] },
			])
			.map('v')
			.map('a');
		}
	}

	command.on('error', (err) => {
		if (!res.headersSent) {
			res.status(500).json({ error: 'Preview generation failed', details: String(err) });
		} else {
			try { res.end(); } catch {}
		}
	});
	command.pipe(res, { end: true });
});

app.post('/api/export', async (req, res) => {
	const { fileId, options } = req.body || {};
	if (!fileId) return res.status(400).json({ error: 'fileId required' });
	const inputPath = path.join(UPLOAD_DIR, String(fileId));
	if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

	const id = uuidv4();
	const outPath = path.join(OUTPUT_DIR, `${id}.mp4`);
	jobProgress.set(id, { percent: 0, status: 'running' });

	const vFilters = buildVideoFilterGraph(options || {});
	const aFilters = buildAudioFilterGraph(options || {});

	let command;
	const addBgm = options?.addBgm === 'on';
	if (addBgm) {
		const assets = listAudioAssets();
		if (assets.length > 0) {
			const bgmPath = assets[Math.floor(Math.random() * assets.length)];
			const bgmVol = Number(options?.bgmVolume || 0.08);
			const aCombined = [aFilters].filter(Boolean).join(',');
			const amix = `volume=${bgmVol}[bgm];[0:a]${aCombined ? aCombined + ',' : ''}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0];[a0][bgm]amix=inputs=2:duration=shortest:dropout_transition=2[a]`;
			const complexFilters = [];
			if (vFilters) complexFilters.push({ filter: vFilters, inputs: '0:v', outputs: 'v' });
			complexFilters.push({ filter: amix, inputs: ['1:a', '0:a'], outputs: ['a'] });

			command = ffmpeg()
				.addInput(inputPath)
				.addInput(bgmPath)
				.complexFilter(complexFilters)
				.map(vFilters ? 'v' : '0:v')
				.map('a')
				.output(outPath)
				.videoCodec('libx264')
				.audioCodec('aac')
				.outputOptions(['-preset', 'fast', '-crf', '23'])
				.on('progress', (p) => {
					const percent = Math.min(99, Math.floor(p.percent || 0));
					jobProgress.set(id, { percent, status: 'running' });
					sendSse(id, { percent, status: 'running' });
				})
				.on('end', () => {
					jobProgress.set(id, { percent: 100, status: 'completed', downloadUrl: `/api/download/${path.basename(outPath)}` });
					sendSse(id, { percent: 100, status: 'completed', downloadUrl: `/api/download/${path.basename(outPath)}` });
				})
				.on('error', (err) => {
					jobProgress.set(id, { percent: 0, status: 'error', error: String(err) });
					sendSse(id, { percent: 0, status: 'error', error: String(err) });
				});
		} else {
			// no bgm available, fall back to standard path
			command = ffmpeg(inputPath)
				.output(outPath)
				.videoCodec('libx264')
				.audioCodec('aac')
				.outputOptions(['-preset', 'fast', '-crf', '23'])
				.on('progress', (p) => {
					const percent = Math.min(99, Math.floor(p.percent || 0));
					jobProgress.set(id, { percent, status: 'running' });
					sendSse(id, { percent, status: 'running' });
				})
				.on('end', () => {
					jobProgress.set(id, { percent: 100, status: 'completed', downloadUrl: `/api/download/${path.basename(outPath)}` });
					sendSse(id, { percent: 100, status: 'completed', downloadUrl: `/api/download/${path.basename(outPath)}` });
				})
				.on('error', (err) => {
					jobProgress.set(id, { percent: 0, status: 'error', error: String(err) });
					sendSse(id, { percent: 0, status: 'error', error: String(err) });
				});
			if (vFilters) command = command.videoFilters(vFilters);
			if (aFilters) command = command.audioFilters(aFilters);
		}
	} else {
		command = ffmpeg(inputPath)
			.output(outPath)
			.videoCodec('libx264')
			.audioCodec('aac')
			.outputOptions(['-preset', 'fast', '-crf', '23'])
			.on('progress', (p) => {
				const percent = Math.min(99, Math.floor(p.percent || 0));
				jobProgress.set(id, { percent, status: 'running' });
				sendSse(id, { percent, status: 'running' });
			})
			.on('end', () => {
				jobProgress.set(id, { percent: 100, status: 'completed', downloadUrl: `/api/download/${path.basename(outPath)}` });
				sendSse(id, { percent: 100, status: 'completed', downloadUrl: `/api/download/${path.basename(outPath)}` });
			})
			.on('error', (err) => {
				jobProgress.set(id, { percent: 0, status: 'error', error: String(err) });
				sendSse(id, { percent: 0, status: 'error', error: String(err) });
			});
		if (vFilters) command = command.videoFilters(vFilters);
		if (aFilters) command = command.audioFilters(aFilters);
	}

	command.run();
	res.json({ jobId: id });
});

app.get('/api/progress/:jobId', (req, res) => {
	const { jobId } = req.params;
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders?.();
	registerSse(jobId, res);
	const current = jobProgress.get(jobId) || { percent: 0, status: 'queued' };
	res.write(`data: ${JSON.stringify(current)}\n\n`);
});

app.post('/api/split', async (req, res) => {
	const { fileId, segments } = req.body || {};
	if (!fileId || !Array.isArray(segments) || segments.length === 0) {
		return res.status(400).json({ error: 'fileId and segments required' });
	}
	const inputPath = path.join(UPLOAD_DIR, String(fileId));
	if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

	const zipId = uuidv4();
	const zipPath = path.join(OUTPUT_DIR, `${zipId}.zip`);
	const output = fs.createWriteStream(zipPath);
	const archive = archiver('zip', { zlib: { level: 9 } });
	archive.pipe(output);

	try {
		for (let i = 0; i < segments.length; i++) {
			const { start, end } = segments[i];
			const clipId = `${zipId}_clip_${i + 1}.mp4`;
			const clipPath = path.join(OUTPUT_DIR, clipId);
			// Extract clip
			await new Promise((resolve, reject) => {
				ffmpeg(inputPath)
					.inputOptions(['-ss', String(start)])
					.outputOptions(['-to', String(end)])
					.outputOptions(['-c', 'copy'])
					.output(clipPath)
					.on('end', resolve)
					.on('error', reject)
					.run();
			});
			archive.file(clipPath, { name: `clip_${i + 1}.mp4` });
		}
		await archive.finalize();
	} catch (err) {
		return res.status(500).json({ error: 'Split failed', details: String(err) });
	}

	output.on('close', () => {
		res.json({ downloadUrl: `/api/download/${path.basename(zipPath)}` });
	});
});

app.get('/api/download/:file', (req, res) => {
	const filePath = path.join(OUTPUT_DIR, path.basename(req.params.file));
	if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
	res.download(filePath);
});

// Presets
const PRESETS_PATH = path.join(DATA_DIR, 'presets.json');
function readPresets() {
	try { return JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8')); } catch { return []; }
}
function writePresets(presets) {
	fs.writeFileSync(PRESETS_PATH, JSON.stringify(presets, null, 2));
}
app.get('/api/presets', (req, res) => {
	res.json(readPresets());
});
app.post('/api/presets', (req, res) => {
	const { name, options } = req.body || {};
	if (!name || !options) return res.status(400).json({ error: 'name and options required' });
	const presets = readPresets();
	presets.push({ id: uuidv4(), name, options, createdAt: Date.now() });
	writePresets(presets);
	res.json({ ok: true });
});

// Static serve previews/outputs if needed
app.use('/static', express.static(OUTPUT_DIR));

app.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});