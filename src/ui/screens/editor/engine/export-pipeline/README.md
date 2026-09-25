# Native Export Pipeline

Exports have one path: the renderer resolves the project into an engine
composition, then the native `velocity` exporter streams, composites, encodes,
mixes audio, and writes the MP4.

## Boundaries

1. `plan.ts` resolves output dimensions, layout, duration, and the composition.
   It rejects any feature reported by `unsupportedFeatures`; there is no
   best-effort export or hidden fallback.
2. `config-to-engine.ts` is shared with preview and translates that composition
   into native layout, background, crop, webcam, cursor, zoom, cut, and layer
   options.
3. `run-native-export.ts` discovers audio inputs, aligns legacy sidecars using
   native audio metadata, starts the export through IPC, and reports progress.
4. `export.service.ts` normalises structured-clone values at the process
   boundary and creates `velocity.VideoExporter`.

The source recording and output never cross into renderer memory. Background
and cursor bitmaps are the only pixel buffers sent through IPC, and both are
bounded composition assets.
