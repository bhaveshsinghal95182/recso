# Using a phone as the camera

A phone's rear camera is better than almost any laptop webcam. This lets you use
one without installing anything on it: the desktop serves a page over your local
network, the phone opens it, and the frames it sends become the camera track of
the recording.

## How to use it

1. Open the camera panel in the recorder and pick **Use my phone**.
2. Scan the code with your phone. It has to be on the same wifi.
3. The browser will say the connection is not private. That is expected — see
   below. Tap through it.
4. Tap **Start camera**. The desktop panel turns green when frames arrive.
5. Record as usual. Hold the phone in landscape and leave the screen on.

## Why the security warning

Browsers refuse `getUserMedia` outside a secure context, and `http://` on a
private IP address is not one. There is no flag or header that changes this; the
camera API is simply not there. So the pairing server has to be HTTPS, and on a
home network with no domain name the only certificate available is one the
machine signs for itself. Nothing can vouch for it, so the phone warns you.

The warning is honest rather than something being papered over. What tapping
through buys is a key generated on your machine and kept there, so the video is
actually encrypted on the wire. A certificate shipped with the app would put the
same private key on every install, which would let anyone who downloaded it
impersonate a pairing server on a shared network. That would be worse, and it
would hide the problem instead of showing it.

The certificate is cached in the app's data directory and lasts a year, so the
warning appears once per phone, not once per session. It is capped at 365 days
because iOS rejects server certificates valid for more than 398.

## Who can connect

The server binds every network interface, because there is no way to know in
advance which one the phone will arrive on. A random token in the URL is what
separates the phone that scanned the code from anything else on the network —
every route checks it, it is new for each session, and without it a device that
found the port could push frames into your recording.

The server only runs while the pairing panel has been opened, and it is closed
when the app quits.

## How it fits together

```
phone browser              Electron main                 velocity (Rust)
─────────────              ─────────────                 ───────────────
getUserMedia          →    HTTPS server on the LAN
canvas → JPEG              serves the capture page
  │ ~30fps                 POST /frame  ──── napi ────►  decode JPEG → BGRA
  └──── LAN ──────────►    GET /events (SSE, control)      ↓ latest-frame slot
                                                         sidecar loop polls it
                                                           ↓
                                                        recording_camera.mp4
```

The phone is not a second recording path. The webcam sidecar loop already drove
its own clock — it writes a frame every period whether or not a new one arrived,
holding the last, so the camera track always matches the desktop track's length.
That is exactly what a camera on the far side of a wifi link needs, so the phone
is just a different `FrameSource` for the loop that already existed. Everything
downstream is untouched: the same encoder, the same `_camera.mp4` sidecar, and
the same file the editor and engine already know how to open.

The upshot is that **sync is free**. The phone's own clock never enters into it;
frames are stamped by the recording, not by the device that sent them.

## Design notes

**One slot, not a queue.** A frame that arrived while the encoder was busy is
already stale. Queueing would spend the rest of the recording playing catch-up,
because the sidecar's timestamps advance on the clock — a late frame does not get
its own moment, it gets somebody else's. Dropping it keeps the picture live, and
the count is reported so a struggling link is visible rather than mysterious.

**Liveness is measured on arrival, not on the slot.** The slot empties the moment
the recorder reads it, so "is there an unread frame" is a different question from
"is the phone still sending" — and during a recording the slot is empty most of
the time. Confusing the two would make the panel claim the phone had stopped
while it was streaming perfectly well.

**The capture size is locked to the camera, once.** The encoder fixes its
dimensions on the first frame and an MP4 track cannot change size partway
through, so the page must never change what it sends mid-session — rotating the
phone would otherwise make the recorder reject every frame after the turn and
freeze the take on the last upright picture.

But the size has to come _from_ the camera rather than be assumed. A hardcoded
16:9 canvas with a cover fit throws away most of a portrait stream: 1080×1920
covered into 1280×720 keeps about a third of the height and looks like someone
zoomed in without saying so. The first frame's real dimensions decide the canvas,
capped to 1280 on the long side and rounded to even numbers because H.264
subsamples chroma 2×2. A flip to a differently-shaped camera keeps the locked
size and covers into it, which crops — the right trade against resizing a track
mid-recording.

`captureSizeFor` is defined once and stringified into the page, so the rule the
phone runs is the rule `pnpm check:phone-camera` tests.

**The desktop preview reads frames from the pairing server, not `getUserMedia`.**
That API can only reach cameras attached to this machine, so a paired phone would
otherwise show the laptop's own webcam in the recorder preview — the wrong face,
with nothing on screen suggesting anything was wrong. The frames are already
passing through the main process on their way to the recorder, so the newest one
is held for the preview to draw. It is not mirrored: the phone is pointing at the
room, not back at you.

**One frame in flight.** The page waits for each POST to come back before
capturing the next. That is the whole of the flow control: a good link runs at
the requested rate, a bad one slows to what it can carry.

**No fallback.** If the phone is not sending, starting a recording fails with a
message. The renderer's camera sidecar can only open a local camera, so falling
back to it would quietly record the laptop's own webcam instead of the phone you
just paired — discovered later, in the editor, with the take already made.

## Known limits

- **The phone must stay in the foreground.** Phones suspend the camera when the
  browser is backgrounded. The page notices and tells both ends, but it cannot
  prevent it.
- **Quality is capped by wifi**, not by the phone's sensor. JPEG at 720p30 is
  roughly 2–3 MB/s. A congested network shows up as a lower frame rate rather
  than a stall, because of the one-frame-in-flight rule.
- **No audio.** The phone sends picture only; the microphone is still whatever
  the desktop is using.
- **One phone at a time.**

## Checking it works

```bash
pnpm check:phone-camera
```

Starts the server headless and exercises the token gate, the served page, the
frame route, the control channel and shutdown — including that the certificate
covers every local address and stays under the iOS lifetime limit.

```bash
pnpm check:phone-camera-recording
```

The one that matters: posts frames over HTTPS with a token, records for a few
seconds with `webcamSource: 'phone'`, then opens the sidecar the recorder wrote
and checks the pixels in it came from the phone. Also checks that a recording
refuses to start when no phone is connected.
