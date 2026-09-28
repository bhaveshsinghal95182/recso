//! Asking the desktop for a screen or window to record.
//!
//! On Wayland an application cannot capture the screen by itself. It asks the
//! xdg-desktop-portal, which shows the compositor's own picker and hands back
//! a PipeWire node for whatever the user chose, plus a private PipeWire remote
//! to reach it through.
//!
//! The portal ends a session when the D-Bus connection that opened it goes
//! away, so the connection has to outlive `open`. A thread owns it, and the
//! async runtime ashpd needs, for as long as the recording runs.

use std::os::fd::OwnedFd;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::thread::{self, JoinHandle};

use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
use ashpd::desktop::PersistMode;

/// What the user picked.
pub(crate) struct Grant {
  /// The private PipeWire remote the node must be reached through.
  pub(crate) remote: OwnedFd,
  pub(crate) node_id: u32,
  /// The source's size as the portal reports it, if it does. The stream's own
  /// format is authoritative; this is only a hint for sizing the encoder.
  pub(crate) size: Option<(u32, u32)>,
}

/// A live portal session. Closed by `close`, which the recording calls once
/// the stream has stopped.
pub(crate) struct Session {
  close: SyncSender<()>,
  thread: Option<JoinHandle<()>>,
}

impl Session {
  pub(crate) fn close(mut self) {
    let _ = self.close.send(());
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }
}

/// Show the picker and wait for the user's choice.
///
/// Blocks until the user picks or cancels -- there is no timeout, because the
/// wait is a person deciding. `sources` chooses between screens only and
/// screens plus windows.
pub(crate) fn open(windows_too: bool) -> Result<(Grant, Session), String> {
  let (grant_tx, grant_rx) = sync_channel::<Result<Grant, String>>(1);
  let (close_tx, close_rx) = sync_channel::<()>(1);

  let thread = thread::Builder::new()
    .name("velocity-portal".to_string())
    .spawn(move || run(windows_too, grant_tx, close_rx))
    .map_err(|error| format!("could not start the portal thread: {error}"))?;

  match grant_rx.recv() {
    Ok(Ok(grant)) => Ok((
      grant,
      Session {
        close: close_tx,
        thread: Some(thread),
      },
    )),
    Ok(Err(error)) => {
      let _ = thread.join();
      Err(error)
    }
    Err(_) => {
      let _ = thread.join();
      Err("the portal thread exited without an answer".to_string())
    }
  }
}

fn run(windows_too: bool, grant_tx: SyncSender<Result<Grant, String>>, close_rx: Receiver<()>) {
  let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
    Ok(runtime) => runtime,
    Err(error) => {
      let _ = grant_tx.send(Err(format!("could not start the portal runtime: {error}")));
      return;
    }
  };

  runtime.block_on(async move {
    let proxy = match Screencast::new().await {
      Ok(proxy) => proxy,
      Err(error) => {
        let _ = grant_tx.send(Err(format!(
          "the screen-capture portal is not available ({error}). Is xdg-desktop-portal running with a backend for this desktop?"
        )));
        return;
      }
    };
    let session = match proxy.create_session(Default::default()).await {
      Ok(session) => session,
      Err(error) => {
        let _ = grant_tx.send(Err(format!("the portal would not open a session: {error}")));
        return;
      }
    };

    let result = select_and_start(&proxy, &session, windows_too).await;
    let granted = result.is_ok();
    let _ = grant_tx.send(result);

    if granted {
      // Hold the connection, and with it the session, until the recording
      // is done. `recv` blocks this thread, which is fine: nothing else runs
      // on this runtime.
      let _ = close_rx.recv();
    }
    let _ = session.close().await;
  });
}

async fn select_and_start(
  proxy: &Screencast,
  session: &ashpd::desktop::Session<Screencast>,
  windows_too: bool,
) -> Result<Grant, String> {
  let sources = if windows_too {
    SourceType::Monitor | SourceType::Window
  } else {
    SourceType::Monitor.into()
  };

  proxy
    .select_sources(
      session,
      SelectSourcesOptions::default()
        // recso draws its own cursor from the tracked samples, as on Windows.
        .set_cursor_mode(CursorMode::Hidden)
        .set_sources(sources)
        .set_multiple(false)
        // Asked every time. A remembered choice would never let the user
        // switch sources, since the recorder has no picker of its own.
        .set_persist_mode(PersistMode::DoNot),
    )
    .await
    .map_err(|error| format!("the portal rejected the source request: {error}"))?;

  let response = proxy
    .start(session, None, Default::default())
    .await
    .map_err(|error| format!("the portal could not start the capture: {error}"))?
    .response()
    .map_err(|error| match error {
      ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => {
        "screen selection was cancelled".to_string()
      }
      other => format!("the portal did not grant a capture: {other}"),
    })?;

  let stream = response
    .streams()
    .first()
    .ok_or_else(|| "the portal granted a capture with no stream in it".to_string())?
    .to_owned();

  let remote = proxy
    .open_pipe_wire_remote(session, Default::default())
    .await
    .map_err(|error| format!("the portal would not open a PipeWire remote: {error}"))?;

  Ok(Grant {
    remote,
    node_id: stream.pipe_wire_node_id(),
    size: stream
      .size()
      .and_then(|(width, height)| Some((u32::try_from(width).ok()?, u32::try_from(height).ok()?))),
  })
}
