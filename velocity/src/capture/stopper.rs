//! The handle a recording returns to JavaScript.
//!
//! Platform-neutral: it only holds the channels that stop each capture thread
//! and the stats they write, so every capture backend returns the same class.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

use napi_derive::napi;

use super::recording_info::{RecordingMediaInfo, RecordingStats};

#[napi]
pub struct Stopper {
  stop_txs: Vec<Sender<()>>,
  done_rxs: Vec<Receiver<()>>,
  /// One per capture this Stopper owns -- a v2 recording appends the webcam's
  /// to the screen's, and `stop` reports both.
  stats: Vec<Arc<RecordingStats>>,
}

impl Stopper {
  pub(crate) fn from_channels(stop_tx: Sender<()>, done_rx: Receiver<()>) -> Self {
    Self {
      stop_txs: vec![stop_tx],
      done_rxs: vec![done_rx],
      stats: Vec::new(),
    }
  }

  pub(crate) fn with_stats(
    stop_tx: Sender<()>,
    done_rx: Receiver<()>,
    stats: Arc<RecordingStats>,
  ) -> Self {
    Self {
      stop_txs: vec![stop_tx],
      done_rxs: vec![done_rx],
      stats: vec![stats],
    }
  }

  pub(crate) fn screen_stats(&self) -> Option<Arc<RecordingStats>> {
    self.stats.first().cloned()
  }

  pub(crate) fn append(&mut self, mut other: Stopper) {
    self.stop_txs.append(&mut other.stop_txs);
    self.done_rxs.append(&mut other.done_rxs);
    self.stats.append(&mut other.stats);
  }
}

#[napi]
impl Stopper {
  /// Stop every capture and describe what was written.
  ///
  /// Only meaningful once the encoders have been finalised, which is what the
  /// `done_rx` wait below is for -- the snapshot reads file sizes, and a file
  /// still being muxed reports the wrong one.
  #[napi]
  pub fn stop(&mut self) -> Vec<RecordingMediaInfo> {
    // Before waiting on anything: the duration is measured to this instant, and
    // finalising an MP4 takes long enough to distort it.
    for stats in &self.stats {
      stats.mark_stopped();
    }

    for stop_tx in self.stop_txs.drain(..) {
      let _ = stop_tx.send(());
    }

    for done_rx in self.done_rxs.drain(..) {
      let _ = done_rx.recv_timeout(Duration::from_secs(8));
    }

    self.stats.iter().map(|stats| stats.snapshot()).collect()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::mpsc::channel;
  use std::thread;

  #[test]
  fn stopper_append_merges_channel_vectors_from_both_sides() {
    let (stop_tx_a, _stop_rx_a) = channel::<()>();
    let (_done_tx_a, done_rx_a) = channel::<()>();
    let (stop_tx_b, _stop_rx_b) = channel::<()>();
    let (_done_tx_b, done_rx_b) = channel::<()>();

    let mut stopper = Stopper::from_channels(stop_tx_a, done_rx_a);
    let other = Stopper::from_channels(stop_tx_b, done_rx_b);
    stopper.append(other);

    assert_eq!(stopper.stop_txs.len(), 2);
    assert_eq!(stopper.done_rxs.len(), 2);
  }

  #[test]
  fn stopper_stop_signals_every_registered_channel_and_waits_for_done() {
    let (stop_tx, stop_rx) = channel::<()>();
    let (done_tx, done_rx) = channel::<()>();
    let mut stopper = Stopper::from_channels(stop_tx, done_rx);

    let worker = thread::spawn(move || {
      // Mirrors how a real capture thread behaves: block until told to stop,
      // then report completion on the done channel.
      let _ = stop_rx.recv();
      let _ = done_tx.send(());
    });

    stopper.stop();
    worker.join().expect("worker thread should not panic");

    // stop() drains both vectors after signalling/joining every channel pair.
    assert!(stopper.stop_txs.is_empty());
    assert!(stopper.done_rxs.is_empty());
  }

  #[test]
  fn stopper_stop_does_not_hang_when_worker_never_reports_done() {
    // Regression guard: stop() must bound its wait per channel instead of blocking forever
    // if a capture thread dies without sending on `done_tx`.
    let (stop_tx, _stop_rx) = channel::<()>();
    let (_done_tx, done_rx) = channel::<()>();
    let mut stopper = Stopper::from_channels(stop_tx, done_rx);

    let started_at = std::time::Instant::now();
    stopper.stop();
    assert!(started_at.elapsed() < Duration::from_secs(10));
  }
}
