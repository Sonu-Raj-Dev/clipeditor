"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dropzone from "react-dropzone";

const RAW_SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL;
const SERVER_URL = RAW_SERVER_URL && /^https?:\/\//.test(RAW_SERVER_URL) ? RAW_SERVER_URL : "/api-server";

type Preset = { id: string; name: string; options: any };

type Options = {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
  noiseReduction?: "on" | "off";
  addBgm?: "on" | "off";
  bgmVolume?: number;
  cropResize?: "on" | "off";
  copyrightAvoid?: "on" | "off";
  pitchShift?: number;
  tempo?: number;
};

type Segment = { start: number; end: number };

export default function Home() {
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [splitZipUrl, setSplitZipUrl] = useState<string | null>(null);

  const [options, setOptions] = useState<Options>({
    brightness: 0,
    contrast: 1,
    saturation: 1,
    gamma: 1,
    noiseReduction: "off",
    addBgm: "off",
    bgmVolume: 0.08,
    cropResize: "off",
    copyrightAvoid: "off",
    pitchShift: 1.03,
    tempo: 0.98,
  });

  const handleDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!acceptedFiles[0]) return;
    setIsUploading(true);
    setDownloadUrl(null);
    try {
      const form = new FormData();
      form.append("video", acceptedFiles[0]);
      const resp = await fetch(`${SERVER_URL}/upload`, { method: "POST", body: form });
      const json = await resp.json();
      if (resp.ok) {
        setFileId(json.fileId);
        setFileName(acceptedFiles[0].name);
        setVideoUrl(`${SERVER_URL}/preview?fileId=${encodeURIComponent(json.fileId)}&duration=8`);
      } else {
        alert(json.error || "Upload failed");
      }
    } catch (e: any) {
      alert(e?.message || "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }, []);

  const updatePreview = useCallback(() => {
    if (!fileId) return;
    const params = new URLSearchParams();
    params.set("fileId", fileId);
    params.set("duration", "8");
    const optEntries: [string, any][] = Object.entries(options as any);
    for (const [k, v] of optEntries) {
      if (v === undefined || v === null) continue;
      params.set(k, String(v));
    }
    setVideoUrl(`${SERVER_URL}/preview?${params.toString()}`);
  }, [fileId, options]);

  useEffect(() => {
    updatePreview();
  }, [updatePreview]);

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${SERVER_URL}/presets`);
        if (resp.ok) setPresets(await resp.json());
      } catch {}
    })();
  }, []);

  const exportVideo = useCallback(async () => {
    if (!fileId) return;
    setIsExporting(true);
    setProgress(0);
    setDownloadUrl(null);
    try {
      const resp = await fetch(`${SERVER_URL}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, options }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || "Export failed");
      const jobId = json.jobId as string;
      const evt = new EventSource(`${SERVER_URL}/progress/${jobId}`);
      evt.onmessage = (m) => {
        const data = JSON.parse(m.data);
        if (typeof data.percent === "number") setProgress(data.percent);
                  if (data.status === "completed" && data.downloadUrl) {
            const dl = String(data.downloadUrl).replace(/^\/api\//, '/');
            setDownloadUrl(`${SERVER_URL}${dl}`);
            setIsExporting(false);
            evt.close();
          }
        if (data.status === "error") {
          alert(data.error || "Export error");
          setIsExporting(false);
          evt.close();
        }
      };
    } catch (e: any) {
      alert(e?.message || "Export failed");
      setIsExporting(false);
    }
  }, [fileId, options]);

  const savePreset = useCallback(async () => {
    const name = prompt("Preset name?");
    if (!name) return;
    try {
      const resp = await fetch(`${SERVER_URL}/presets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, options }),
      });
      if (resp.ok) {
        const updated = await fetch(`${SERVER_URL}/presets`).then((r) => r.json());
        setPresets(updated);
      } else {
        const j = await resp.json();
        alert(j.error || "Failed to save preset");
      }
    } catch (e: any) {
      alert(e?.message || "Failed to save preset");
    }
  }, [options]);

  const applyPreset = useCallback((p: Preset) => {
    setOptions((prev) => ({ ...prev, ...(p.options || {}) }));
  }, []);

  const toggle = (k: keyof Options) =>
    setOptions((o) => ({ ...o, [k]: (o as any)[k] === "on" ? "off" : "on" }));

  const addSegment = () => {
    const startStr = prompt("Segment start (seconds)");
    const endStr = prompt("Segment end (seconds)");
    if (!startStr || !endStr) return;
    const start = Number(startStr);
    const end = Number(endStr);
    if (isNaN(start) || isNaN(end) || end <= start) {
      alert("Invalid segment");
      return;
    }
    setSegments((s) => [...s, { start, end }]);
  };

  const splitVideo = async () => {
    if (!fileId) return;
    if (segments.length === 0) return alert("Add at least one segment");
    try {
      const resp = await fetch(`${SERVER_URL}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, segments }),
      });
      const json = await resp.json();
      if (resp.ok) {
        setSplitZipUrl(`${SERVER_URL}${json.downloadUrl}`);
      } else {
        alert(json.error || "Split failed");
      }
    } catch (e: any) {
      alert(e?.message || "Split failed");
    }
  };

  const removeSegment = (idx: number) => {
    setSegments((s) => s.filter((_, i) => i !== idx));
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-gray-900">
      <div className="max-w-6xl mx-auto p-6">
        <h1 className="text-2xl font-semibold mb-4">Web Video Editor</h1>
        <p className="text-sm text-gray-600 mb-6">Upload a video, tweak settings, preview changes, then export an MP4.</p>

        {!fileId && (
          <Dropzone onDrop={handleDrop} multiple={false} accept={{ "video/*": [] }}>
            {({ getRootProps, getInputProps, isDragActive }) => (
              <div
                {...getRootProps()}
                className={`border-2 border-dashed rounded-md p-8 flex items-center justify-center bg-white ${
                  isDragActive ? "border-blue-500" : "border-gray-300"
                }`}
              >
                <input {...getInputProps()} />
                <div className="text-center">
                  <div className="text-gray-700 font-medium">Drag & drop a video, or click to select</div>
                  <div className="text-xs text-gray-500 mt-1">MP4, WebM, MOV up to 1GB</div>
                </div>
              </div>
            )}
          </Dropzone>
        )}

        {isUploading && <div className="mt-4 text-sm">Uploading...</div>}

        {fileId && (
          <div className="grid md:grid-cols-3 gap-6 mt-6">
            <div className="md:col-span-2">
              <div className="aspect-video w-full bg-black rounded overflow-hidden">
                {videoUrl ? (
                  <video key={videoUrl} className="w-full h-full" controls src={videoUrl} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-white">No preview</div>
                )}
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={exportVideo}
                  disabled={isExporting}
                  className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
                >
                  {isExporting ? "Exporting..." : "Export MP4"}
                </button>
                {isExporting && (
                  <div className="flex-1 h-2 bg-gray-200 rounded">
                    <div className="h-2 bg-blue-600 rounded" style={{ width: `${progress}%` }} />
                  </div>
                )}
                {downloadUrl && (
                  <a
                    href={downloadUrl}
                    className="px-4 py-2 bg-green-600 text-white rounded"
                  >
                    Download
                  </a>
                )}
              </div>

              <div className="bg-white rounded p-4 shadow-sm mt-4">
                <div className="text-sm font-medium mb-3">Split into clips</div>
                <div className="flex gap-2">
                  <button onClick={addSegment} className="text-xs px-3 py-1 bg-gray-800 text-white rounded">Add segment</button>
                  <button onClick={splitVideo} className="text-xs px-3 py-1 bg-blue-600 text-white rounded">Generate clips</button>
                  {splitZipUrl && (
                    <a href={splitZipUrl} className="text-xs px-3 py-1 bg-green-600 text-white rounded">Download ZIP</a>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  {segments.length === 0 && <div className="text-xs text-gray-500">No segments added</div>}
                  {segments.map((s, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm">
                      <div>
                        <span className="text-gray-700">{s.start.toFixed(2)}s</span>
                        <span className="mx-1">→</span>
                        <span className="text-gray-700">{s.end.toFixed(2)}s</span>
                      </div>
                      <button onClick={() => removeSegment(idx)} className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded">Remove</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="md:col-span-1">
              <div className="bg-white rounded p-4 shadow-sm">
                <div className="text-sm font-medium mb-3">Adjustments</div>
                <div className="space-y-4">
                  <div>
                    <label className="text-xs">Brightness ({options.brightness})</label>
                    <input type="range" min={-1} max={1} step={0.02}
                      value={options.brightness}
                      onChange={(e) => setOptions({ ...options, brightness: Number(e.target.value) })}
                      className="w-full" />
                  </div>
                  <div>
                    <label className="text-xs">Contrast ({options.contrast})</label>
                    <input type="range" min={0} max={2} step={0.02}
                      value={options.contrast}
                      onChange={(e) => setOptions({ ...options, contrast: Number(e.target.value) })}
                      className="w-full" />
                  </div>
                  <div>
                    <label className="text-xs">Saturation ({options.saturation})</label>
                    <input type="range" min={0} max={2} step={0.02}
                      value={options.saturation}
                      onChange={(e) => setOptions({ ...options, saturation: Number(e.target.value) })}
                      className="w-full" />
                  </div>
                  <div>
                    <label className="text-xs">Gamma ({options.gamma})</label>
                    <input type="range" min={0.5} max={2} step={0.01}
                      value={options.gamma}
                      onChange={(e) => setOptions({ ...options, gamma: Number(e.target.value) })}
                      className="w-full" />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-sm">Noise reduction</span>
                    <button onClick={() => toggle("noiseReduction")} className={`px-2 py-1 rounded text-xs ${options.noiseReduction === "on" ? "bg-blue-600 text-white" : "bg-gray-200"}`}>
                      {options.noiseReduction === "on" ? "On" : "Off"}
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-sm">Crop/Resize</span>
                    <button onClick={() => toggle("cropResize")} className={`px-2 py-1 rounded text-xs ${options.cropResize === "on" ? "bg-blue-600 text-white" : "bg-gray-200"}`}>
                      {options.cropResize === "on" ? "On" : "Off"}
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-sm">Copyright avoidance</span>
                    <button onClick={() => toggle("copyrightAvoid")} className={`px-2 py-1 rounded text-xs ${options.copyrightAvoid === "on" ? "bg-blue-600 text-white" : "bg-gray-200"}`}>
                      {options.copyrightAvoid === "on" ? "On" : "Off"}
                    </button>
                  </div>

                  <div>
                    <label className="text-xs">Pitch shift ({options.pitchShift})</label>
                    <input type="range" min={0.9} max={1.1} step={0.005}
                      value={options.pitchShift}
                      onChange={(e) => setOptions({ ...options, pitchShift: Number(e.target.value) })}
                      className="w-full" />
                  </div>

                  <div>
                    <label className="text-xs">Tempo ({options.tempo})</label>
                    <input type="range" min={0.9} max={1.1} step={0.005}
                      value={options.tempo}
                      onChange={(e) => setOptions({ ...options, tempo: Number(e.target.value) })}
                      className="w-full" />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-sm">Add background music</span>
                    <button onClick={() => toggle("addBgm")} className={`px-2 py-1 rounded text-xs ${options.addBgm === "on" ? "bg-blue-600 text-white" : "bg-gray-200"}`}>
                      {options.addBgm === "on" ? "On" : "Off"}
                    </button>
                  </div>
                  {options.addBgm === "on" && (
                    <div>
                      <label className="text-xs">BGM volume ({options.bgmVolume})</label>
                      <input type="range" min={0} max={0.5} step={0.01}
                        value={options.bgmVolume}
                        onChange={(e) => setOptions({ ...options, bgmVolume: Number(e.target.value) })}
                        className="w-full" />
                    </div>
                  )}

                  <div className="pt-2 flex gap-2">
                    <button onClick={savePreset} className="text-xs px-3 py-1 bg-gray-800 text-white rounded">Save preset</button>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded p-4 shadow-sm mt-4">
                <div className="text-sm font-medium mb-3">Presets</div>
                <div className="space-y-2 max-h-60 overflow-auto">
                  {presets.length === 0 && <div className="text-xs text-gray-500">No presets yet</div>}
                  {presets.map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-sm">
                      <span>{p.name}</span>
                      <button onClick={() => applyPreset(p)} className="text-xs px-2 py-1 bg-gray-200 rounded">Apply</button>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  );
}
