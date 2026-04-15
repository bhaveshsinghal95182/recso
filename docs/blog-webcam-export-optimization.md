---
title: "Frame-Perfect and Blazing Fast: Optimizing Webcam Overlays in Recso's Export Pipeline"
date: '2026-04-15'
author: 'Engineering Team'
tags: ['engineering', 'performance', 'video-processing', 'mediabunny']
---

Here at Recso, we recently decided to up our game by adding a picture-in-picture webcam overlay to our screen recordings. It seemed like a straightforward feature at first: just draw the webcam video on top of the screen recording canvas during the export process.

However, as we moved from prototype to production, we ran into a series of complex synchronization and performance bugs. What started as a simple `<video>` element implementation evolved into a deep dive into video decoding pipelines, algorithmic complexity, and frame-accurate seeking.

Here is the story of how we took our webcam export from a stuttering mess to an optimized, blazing-fast $O(n)$ pipeline.

## Attempt 1: The `HTMLVideoElement` Fallacy

Our initial implementation for the export pipeline relied on the browser's native `HTMLVideoElement`. During export, as we iterated through the frames of the main screen recording, we attempted to keep the webcam video synced up.

We used a strategy that adjusted the `playbackRate` for minor drift or performed a "hard seek" using `video.currentTime = targetSeconds` if the drift exceeded a certain threshold. Then, we simply called `ctx.drawImage()` to draw the current frame onto the canvas.

### The Bug: Black and Stuttering Frames

When we tested the export, the main screen video was butter-smooth, but the webcam overlay was a disaster. It would render a few good frames, followed by a sequence of completely black frames.

**The root cause? Asynchronous seeking.**

During playback, video plays in real-time. But during an _export_, our pipeline (powered by Mediabunny) processes frames as fast as your CPU allows—much faster than real-time.

When we manually set `video.currentTime = targetSeconds`, the browser begins an _asynchronous_ seek to find and decode that frame. But our export pipeline was synchronous. Immediately after issuing the seek, we tried to draw the frame. The video's `readyState` was less than 2 (meaning no data was available for the current frame yet), triggering our safety guard to return early and draw nothing. Result: a jarring sequence of black frames!

## Attempt 2: Frame-Accurate Decoding with Mediabunny

We couldn't rely on `HTMLVideoElement` because we needed a guarantee that every frame was fully decoded _before_ we drew it.

To solve this, we turned to [Mediabunny's](https://github.com/mediabunny/mediabunny) `CanvasSink`. Instead of playing a video tag, we opened the webcam video file as a **second input stream** alongside the main screen recording.

We used `CanvasSink.getCanvas(timestamp)`, which synchronously returns a decoded frame for the exact timestamp requested:

```typescript
const canvasSink = new CanvasSink(webcamVideoTrack);

const syncToSeconds = async (targetSeconds: number): Promise<void> => {
  const wrappedCanvas = await canvasSink.getCanvas(targetSeconds);
  frameSource.setCanvas(wrappedCanvas?.canvas ?? null);
};
```

This fixed the stuttering entirely! We now had frame-perfect synchronization, and the black frames were completely gone.

### The New Bug: The 10 FPS Crawl

We solved the visual issue, but introduced a massive performance regression. Our export speeds tanked to a sluggish 10-15 frames per second.

Why was it so slow? It turned out to be an issue of algorithmic complexity. `CanvasSink.getCanvas(timestamp)` is designed for **random-access seeking**. Video formats like H.264 encode frames as a series of Keyframes (I-frames) followed by delta frames (P/B-frames) that only store differences.

When you ask for a specific timestamp, the decoder must:

1. Find the nearest preceding Keyframe.
2. Decode the Keyframe.
3. Sequentially decode every delta frame up to the target timestamp.

Because we were calling `getCanvas()` for _every single frame_ in our export, we were repeatedly re-decoding from the previous keyframe over and over again. If a keyframe occurs every 2 seconds at 30 fps, we might decode 60 frames just to retrieve one.

This made our export pipeline $O(k \times n)$ (where $n$ is the number of frames, and $k$ is the distance to the last keyframe).

## Attempt 3: The $O(n)$ Sequential Iterator Optimization

We realized that our use case wasn't random access at all. An export pipeline always requests frames in a strictly monotonically increasing order.

Mediabunny provides an optimized sequential iterator via `canvases()`. This iterator operates as a pipeline: it pre-decodes frames slightly ahead of time and, crucially, **decodes each packet exactly once**.

We refactored our code to advance this iterator forward until it reached the required timestamp:

```typescript
const frameIterator = canvasSink.canvases();
let currentCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
let nextFrame = await frameIterator.next();

const syncToSeconds = async (targetSeconds: number): Promise<void> => {
  const target = Math.max(0, targetSeconds);

  // Advance the iterator forward until we reach or pass the target timestamp.
  // Since timestamps are monotonically increasing, each frame is decoded at most once.
  while (!nextFrame.done && nextFrame.value.timestamp <= target) {
    currentCanvas = nextFrame.value.canvas;
    nextFrame = await frameIterator.next();
  }

  frameSource.setCanvas(currentCanvas);
};
```

### The Result: The Best of Both Worlds

By switching to a sequential iterator, we reduced the total decoding work across the entire export from $O(k \times n)$ down to simply $O(n)$.

The export speeds shot back up to their original, blazing-fast rates, and the webcam video remained perfectly synchronized without a single dropped or black frame!

## Takeaways

1. **Beware the DOM context during offline processing:** `HTMLVideoElement` is designed for playback, not synchronous offline rendering. Its asynchronous nature makes it unsuitable for high-speed export loops.
2. **Understand how video compression works:** Because most video formats rely on inter-frame compression, random seeks are computationally expensive.
3. **Match your data structure to your access pattern:** If you are reading data sequentially, make sure you use a tool designed for sequential access. Dropping down to lower-level decoding APIs (like Mediabunny or WebCodecs) gave us the power to exactly match our access pattern.

At Recso, we care deeply about performance and reliability. By understanding the underlying mechanics of video decoding, we successfully delivered a premium, high-speed export experience for our users!
