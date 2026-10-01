//! Frames from a PipeWire video node.
//!
//! PipeWire runs its own main loop, so each stream gets a thread that owns the
//! loop and hands every frame to a callback while the buffer is still mapped.
//! The callback must copy what it needs before it returns -- the buffer goes
//! back to the compositor straight afterwards.
//!
//! Only packed 32-bit RGB in shared memory is negotiated. That is what the
//! encoder takes, it is what every portal backend can produce, and leaving
//! DMA-BUF out keeps the frames CPU-readable without a GPU import step.

use std::os::fd::OwnedFd;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use pipewire as pw;
use pw::properties::properties;
use pw::spa;
use spa::buffer::meta::MetaCursor;
use spa::param::video::{VideoFormat, VideoInfoRaw};
use spa::pod::Pod;

use super::cursor_meta::{self, StreamCursor};
use super::encoder::PixelOrder;

/// Where the stream comes from.
pub(crate) struct NodeSource {
  /// The PipeWire remote the portal opened for this session. `None` connects
  /// to the user's default PipeWire instead, which is how the tests reach a
  /// test source without a portal.
  pub(crate) remote: Option<OwnedFd>,
  pub(crate) node_id: u32,
}

/// One frame, borrowed from a mapped PipeWire buffer.
pub(crate) struct Frame<'a> {
  pub(crate) pixels: &'a [u8],
  pub(crate) width: u32,
  pub(crate) height: u32,
  pub(crate) stride: usize,
  pub(crate) order: PixelOrder,
  /// When the frame was dequeued, on the stream's own clock.
  pub(crate) received: Instant,
}

/// A running stream. Dropping it without `stop` leaves the thread running.
pub(crate) struct NodeStream {
  quit: pw::channel::Sender<()>,
  thread: Option<JoinHandle<Result<(), String>>>,
}

impl NodeStream {
  /// Ask the loop to quit and wait for its thread.
  ///
  /// Returns the error the loop ended with, if it ended with one before it
  /// was asked to stop -- a node that vanished mid-recording, for instance.
  pub(crate) fn stop(mut self) -> Result<(), String> {
    let _ = self.quit.send(());
    match self.thread.take() {
      Some(thread) => thread
        .join()
        .unwrap_or_else(|_| Err("PipeWire stream thread panicked".to_string())),
      None => Ok(()),
    }
  }
}

/// How long to wait for the node to agree a format before giving up.
const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(10);

/// Connect to a video node and start delivering frames to `on_frame`.
///
/// Returns once the stream has negotiated a format, so a caller that gets
/// `Ok` knows frames are coming, and one whose node cannot produce anything
/// usable gets an error instead of a recording with no picture.
///
/// With `cursor`, the stream also asks for cursor metadata and keeps the
/// latest pointer position there. Only a portal session started in the
/// metadata cursor mode sends any.
pub(crate) fn start<F>(
  source: NodeSource,
  fps: u32,
  cursor: Option<Arc<StreamCursor>>,
  on_frame: F,
) -> Result<NodeStream, String>
where
  F: FnMut(Frame<'_>) + Send + 'static,
{
  let (ready_tx, ready_rx) = sync_channel::<Result<(), String>>(1);
  let (quit_tx, quit_rx) = pw::channel::channel::<()>();

  let thread = thread::Builder::new()
    .name("velocity-pipewire".to_string())
    .spawn(move || run_loop(source, fps, cursor, on_frame, ready_tx, quit_rx))
    .map_err(|error| format!("could not start the PipeWire thread: {error}"))?;

  match ready_rx.recv_timeout(NEGOTIATION_TIMEOUT) {
    Ok(Ok(())) => Ok(NodeStream {
      quit: quit_tx,
      thread: Some(thread),
    }),
    Ok(Err(error)) => {
      let _ = quit_tx.send(());
      let _ = thread.join();
      Err(error)
    }
    Err(_) => {
      let _ = quit_tx.send(());
      let _ = thread.join();
      Err("the PipeWire stream did not agree a video format in time".to_string())
    }
  }
}

/// Map a negotiated format onto the encoder's pixel order.
fn pixel_order(format: VideoFormat) -> Option<PixelOrder> {
  match format {
    VideoFormat::BGRx | VideoFormat::BGRA => Some(PixelOrder::Bgrx),
    VideoFormat::RGBx | VideoFormat::RGBA => Some(PixelOrder::Rgbx),
    _ => None,
  }
}

struct State<F> {
  on_frame: F,
  info: VideoInfoRaw,
  order: Option<PixelOrder>,
  /// Where cursor metadata goes, and the request for it, sent once a format
  /// is agreed.
  cursor: Option<(Arc<StreamCursor>, Vec<u8>)>,
  ready: Option<SyncSender<Result<(), String>>>,
}

impl<F> State<F> {
  fn report(&mut self, result: Result<(), String>) {
    if let Some(ready) = self.ready.take() {
      let _ = ready.send(result);
    }
  }
}

fn run_loop<F>(
  source: NodeSource,
  fps: u32,
  cursor: Option<Arc<StreamCursor>>,
  on_frame: F,
  ready: SyncSender<Result<(), String>>,
  quit: pw::channel::Receiver<()>,
) -> Result<(), String>
where
  F: FnMut(Frame<'_>) + Send + 'static,
{
  let fail = |ready: &SyncSender<Result<(), String>>, message: String| {
    let _ = ready.send(Err(message.clone()));
    Err(message)
  };

  pw::init();
  let mainloop = match pw::main_loop::MainLoopRc::new(None) {
    Ok(mainloop) => mainloop,
    Err(error) => return fail(&ready, format!("PipeWire main loop: {error}")),
  };
  let context = match pw::context::ContextRc::new(&mainloop, None) {
    Ok(context) => context,
    Err(error) => return fail(&ready, format!("PipeWire context: {error}")),
  };
  let core = match source.remote {
    Some(fd) => context.connect_fd_rc(fd, None),
    None => context.connect_rc(None),
  };
  let core = match core {
    Ok(core) => core,
    Err(error) => return fail(&ready, format!("could not connect to PipeWire: {error}")),
  };

  let stream = match pw::stream::StreamBox::new(
    &core,
    "velocity-capture",
    properties! {
      *pw::keys::MEDIA_TYPE => "Video",
      *pw::keys::MEDIA_CATEGORY => "Capture",
      *pw::keys::MEDIA_ROLE => "Screen",
    },
  ) {
    Ok(stream) => stream,
    Err(error) => return fail(&ready, format!("PipeWire stream: {error}")),
  };

  let cursor = match cursor.map(|cursor| cursor_meta::meta_param().map(|param| (cursor, param))) {
    Some(Ok(cursor)) => Some(cursor),
    Some(Err(error)) => return fail(&ready, error),
    None => None,
  };
  let state = State {
    on_frame,
    info: VideoInfoRaw::default(),
    order: None,
    cursor,
    ready: Some(ready.clone()),
  };

  let loop_for_quit = mainloop.loop_();
  let _quit = quit.attach(loop_for_quit, {
    let mainloop = mainloop.clone();
    move |()| mainloop.quit()
  });

  let listener = stream
    .add_local_listener_with_user_data(state)
    .state_changed({
      let mainloop = mainloop.clone();
      move |_, state, _, new| {
        if let pw::stream::StreamState::Error(message) = new {
          state.report(Err(format!("PipeWire stream failed: {message}")));
          mainloop.quit();
        }
      }
    })
    .param_changed(|stream, state, id, param| {
      let Some(param) = param else { return };
      if id != spa::param::ParamType::Format.as_raw() {
        return;
      }
      if state.info.parse(param).is_err() {
        state.report(Err("PipeWire sent a video format it could not describe".to_string()));
        return;
      }
      state.order = pixel_order(state.info.format());
      if let Some((_, request)) = &state.cursor {
        // Without it the frames still come, just with no pointer position.
        match Pod::from_bytes(request) {
          Some(pod) => {
            if let Err(error) = stream.update_params(&mut [pod]) {
              eprintln!("[velocity] PipeWire refused the cursor metadata request: {error}");
            }
          }
          None => eprintln!("[velocity] the cursor metadata request did not parse"),
        }
      }
      match state.order {
        Some(_) => state.report(Ok(())),
        None => state.report(Err(format!(
          "PipeWire offered {:?}, which the encoder cannot take",
          state.info.format()
        ))),
      }
    })
    .process(|stream, state| {
      let Some(order) = state.order else { return };
      let Some(mut buffer) = stream.dequeue_buffer() else { return };
      let received = Instant::now();
      let size_info = state.info.size();
      // Read before the picture: a pointer that moved over a still screen
      // arrives in a buffer with no picture in it.
      if let Some((cursor, _)) = &state.cursor {
        if let Some(meta) = buffer.find_meta::<MetaCursor>().filter(|meta| meta.is_valid()) {
          let position = meta.position();
          cursor.set(position.x, position.y, size_info.width, size_info.height);
        }
      }
      let datas = buffer.datas_mut();
      let Some(data) = datas.first_mut() else { return };

      let chunk = data.chunk();
      let offset = chunk.offset() as usize;
      let size = chunk.size() as usize;
      let stride = chunk.stride();
      // A zero-size chunk is how a compositor says "nothing changed" (or a
      // cursor-only update); there is no picture in it to record.
      if size == 0 || stride <= 0 {
        return;
      }
      let Some(bytes) = data.data() else { return };
      let Some(pixels) = bytes.get(offset..offset.saturating_add(size)) else { return };

      (state.on_frame)(Frame {
        pixels,
        width: size_info.width,
        height: size_info.height,
        stride: stride as usize,
        order,
        received,
      });
    })
    .register();
  let _listener = match listener {
    Ok(listener) => listener,
    Err(error) => return fail(&ready, format!("PipeWire listener: {error}")),
  };

  let format = match format_params(fps) {
    Ok(bytes) => bytes,
    Err(error) => return fail(&ready, error),
  };
  let Some(pod) = Pod::from_bytes(&format) else {
    return fail(&ready, "could not build the PipeWire format request".to_string());
  };
  let mut params = [pod];
  if let Err(error) = stream.connect(
    spa::utils::Direction::Input,
    Some(source.node_id),
    pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
    &mut params,
  ) {
    return fail(&ready, format!("could not connect to PipeWire node {}: {error}", source.node_id));
  }

  mainloop.run();
  let _ = stream.disconnect();
  Ok(())
}

/// The formats we accept: packed 32-bit RGB at any size, preferring `fps`.
fn format_params(fps: u32) -> Result<Vec<u8>, String> {
  let object = spa::pod::object!(
    spa::utils::SpaTypes::ObjectParamFormat,
    spa::param::ParamType::EnumFormat,
    spa::pod::property!(
      spa::param::format::FormatProperties::MediaType,
      Id,
      spa::param::format::MediaType::Video
    ),
    spa::pod::property!(
      spa::param::format::FormatProperties::MediaSubtype,
      Id,
      spa::param::format::MediaSubtype::Raw
    ),
    spa::pod::property!(
      spa::param::format::FormatProperties::VideoFormat,
      Choice,
      Enum,
      Id,
      VideoFormat::BGRx,
      VideoFormat::BGRx,
      VideoFormat::BGRA,
      VideoFormat::RGBx,
      VideoFormat::RGBA
    ),
    spa::pod::property!(
      spa::param::format::FormatProperties::VideoSize,
      Choice,
      Range,
      Rectangle,
      spa::utils::Rectangle { width: 1920, height: 1080 },
      spa::utils::Rectangle { width: 1, height: 1 },
      spa::utils::Rectangle { width: 8192, height: 8192 }
    ),
    spa::pod::property!(
      spa::param::format::FormatProperties::VideoFramerate,
      Choice,
      Range,
      Fraction,
      spa::utils::Fraction { num: fps, denom: 1 },
      spa::utils::Fraction { num: 0, denom: 1 },
      spa::utils::Fraction { num: 1000, denom: 1 }
    ),
  );
  spa::pod::serialize::PodSerializer::serialize(
    std::io::Cursor::new(Vec::new()),
    &spa::pod::Value::Object(object),
  )
  .map(|(cursor, _)| cursor.into_inner())
  .map_err(|error| format!("could not encode the PipeWire format request: {error:?}"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Mutex;

  const SIZE: u32 = 64;

  /// A PipeWire video source that sends a pointer position with every frame,
  /// as GNOME's and KDE's portals do in the metadata cursor mode.
  struct CursorSource {
    quit: pw::channel::Sender<()>,
    thread: Option<JoinHandle<()>>,
  }

  impl Drop for CursorSource {
    fn drop(&mut self) {
      let _ = self.quit.send(());
      if let Some(thread) = self.thread.take() {
        let _ = thread.join();
      }
    }
  }

  fn object_bytes(object: spa::pod::Object) -> Vec<u8> {
    spa::pod::serialize::PodSerializer::serialize(
      std::io::Cursor::new(Vec::new()),
      &spa::pod::Value::Object(object),
    )
    .unwrap()
    .0
    .into_inner()
  }

  fn cursor_source(position: (i32, i32)) -> (CursorSource, u32) {
    use spa::pod::{ChoiceValue, Object, Property, PropertyFlags, Value};
    use spa::utils::{Choice, ChoiceEnum, ChoiceFlags};

    let (id_tx, id_rx) = sync_channel::<u32>(1);
    let (quit_tx, quit_rx) = pw::channel::channel::<()>();
    let thread = thread::spawn(move || {
      pw::init();
      let mainloop = pw::main_loop::MainLoopRc::new(None).unwrap();
      let context = pw::context::ContextRc::new(&mainloop, None).unwrap();
      let core = context.connect_rc(None).unwrap();
      let stream = pw::stream::StreamRc::new(
        core,
        "velocity-cursor-test",
        properties! {
          *pw::keys::MEDIA_TYPE => "Video",
          *pw::keys::MEDIA_CLASS => "Video/Source",
          *pw::keys::MEDIA_ROLE => "Screen",
        },
      )
      .unwrap();
      let _quit = quit_rx.attach(mainloop.loop_(), {
        let mainloop = mainloop.clone();
        move |()| mainloop.quit()
      });

      let int = |value: i32| Value::Int(value);
      let buffers = object_bytes(Object {
        type_: spa::utils::SpaTypes::ObjectParamBuffers.as_raw(),
        id: spa::param::ParamType::Buffers.as_raw(),
        properties: vec![
          Property {
            key: spa::sys::SPA_PARAM_BUFFERS_buffers,
            flags: PropertyFlags::empty(),
            value: Value::Choice(ChoiceValue::Int(Choice(
              ChoiceFlags::empty(),
              ChoiceEnum::Range { default: 4, min: 2, max: 8 },
            ))),
          },
          Property::new(spa::sys::SPA_PARAM_BUFFERS_blocks, int(1)),
          Property::new(spa::sys::SPA_PARAM_BUFFERS_size, int((SIZE * SIZE * 4) as i32)),
          Property::new(spa::sys::SPA_PARAM_BUFFERS_stride, int((SIZE * 4) as i32)),
          Property::new(
            spa::sys::SPA_PARAM_BUFFERS_dataType,
            int(1 << spa::sys::SPA_DATA_MemFd),
          ),
        ],
      });
      let meta = cursor_meta::meta_param().unwrap();

      let reported = Mutex::new(Some(id_tx));
      let _listener = stream
        .add_local_listener_with_user_data(())
        .state_changed(move |stream, _, _, new| {
          if matches!(new, pw::stream::StreamState::Paused | pw::stream::StreamState::Streaming) {
            if let Some(id_tx) = reported.lock().unwrap().take() {
              let _ = id_tx.send(stream.node_id());
            }
          }
        })
        .param_changed(move |stream, _, id, param| {
          if param.is_none() || id != spa::param::ParamType::Format.as_raw() {
            return;
          }
          let mut params = [Pod::from_bytes(&buffers).unwrap(), Pod::from_bytes(&meta).unwrap()];
          stream.update_params(&mut params).unwrap();
        })
        .process(move |stream, _| unsafe {
          let raw = stream.dequeue_raw_buffer();
          if raw.is_null() {
            return;
          }
          let buffer = (*raw).buffer;
          let cursor = spa::sys::spa_buffer_find_meta_data(
            buffer,
            spa::sys::SPA_META_Cursor,
            std::mem::size_of::<spa::sys::spa_meta_cursor>(),
          ) as *mut spa::sys::spa_meta_cursor;
          if !cursor.is_null() {
            (*cursor).id = 1;
            (*cursor).position.x = position.0;
            (*cursor).position.y = position.1;
            (*cursor).bitmap_offset = 0;
          }
          let data = &mut *(*buffer).datas;
          let frame = SIZE * SIZE * 4;
          if data.data.is_null() || data.maxsize < frame {
            stream.queue_raw_buffer(raw);
            return;
          }
          std::ptr::write_bytes(data.data as *mut u8, 0x80, frame as usize);
          let chunk = &mut *data.chunk;
          chunk.offset = 0;
          chunk.size = frame;
          chunk.stride = (SIZE * 4) as i32;
          stream.queue_raw_buffer(raw);
        })
        .register()
        .unwrap();

      let format = object_bytes(spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(
          spa::param::format::FormatProperties::MediaType,
          Id,
          spa::param::format::MediaType::Video
        ),
        spa::pod::property!(
          spa::param::format::FormatProperties::MediaSubtype,
          Id,
          spa::param::format::MediaSubtype::Raw
        ),
        spa::pod::property!(
          spa::param::format::FormatProperties::VideoFormat,
          Id,
          VideoFormat::BGRx
        ),
        spa::pod::property!(
          spa::param::format::FormatProperties::VideoSize,
          Rectangle,
          spa::utils::Rectangle { width: SIZE, height: SIZE }
        ),
        spa::pod::property!(
          spa::param::format::FormatProperties::VideoFramerate,
          Fraction,
          spa::utils::Fraction { num: 30, denom: 1 }
        ),
      ));
      stream
        .connect(
          spa::utils::Direction::Output,
          None,
          pw::stream::StreamFlags::DRIVER | pw::stream::StreamFlags::MAP_BUFFERS,
          &mut [Pod::from_bytes(&format).unwrap()],
        )
        .unwrap();

      // A driver paces itself: one frame every 33 ms, as a compositor would.
      let timer = mainloop.loop_().add_timer({
        let stream = stream.clone();
        move |_| {
          // `trigger_process` sits behind a feature flag the crate is built without.
          unsafe { pw::sys::pw_stream_trigger_process(stream.as_raw_ptr()) };
        }
      });
      let _ = timer.update_timer(
        Some(Duration::from_millis(33)),
        Some(Duration::from_millis(33)),
      );
      mainloop.run();
      let _ = stream.disconnect();
    });

    let node_id = id_rx.recv_timeout(Duration::from_secs(5)).expect("the test source starts");
    (CursorSource { quit: quit_tx, thread: Some(thread) }, node_id)
  }

  #[test]
  #[ignore = "needs a running PipeWire; run with --ignored"]
  fn the_pointer_position_arrives_with_the_frames() {
    let (_source, node_id) = cursor_source((48, 16));
    let cursor = Arc::new(StreamCursor::default());
    let (frame_tx, frame_rx) = sync_channel::<(u32, u32)>(8);
    let stream = start(NodeSource { remote: None, node_id }, 30, Some(cursor.clone()), move |frame| {
      let _ = frame_tx.try_send((frame.width, frame.height));
    })
    .expect("the stream starts");

    let size = frame_rx.recv_timeout(Duration::from_secs(5)).expect("a frame arrives");
    let deadline = Instant::now() + Duration::from_secs(3);
    while cursor.latest().is_none() && Instant::now() < deadline {
      thread::sleep(Duration::from_millis(20));
    }
    stream.stop().expect("the stream stops cleanly");

    assert_eq!(size, (SIZE, SIZE));
    let point = cursor.latest().expect("the cursor metadata was negotiated and read");
    assert_eq!((point.x, point.y), (0.75, 0.25));
  }

  #[test]
  #[ignore = "needs a running PipeWire; run with --ignored"]
  fn a_stream_that_did_not_ask_gets_frames_and_no_position() {
    let (_source, node_id) = cursor_source((48, 16));
    let (frame_tx, frame_rx) = sync_channel::<()>(8);
    let stream = start(NodeSource { remote: None, node_id }, 30, None, move |_| {
      let _ = frame_tx.try_send(());
    })
    .expect("the stream starts");
    frame_rx.recv_timeout(Duration::from_secs(5)).expect("a frame arrives");
    stream.stop().expect("the stream stops cleanly");
  }
}
