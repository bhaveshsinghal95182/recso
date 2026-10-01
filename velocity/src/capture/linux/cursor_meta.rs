//! The pointer's position, from the screen-cast stream itself.
//!
//! Under Hyprland the cursor track comes from its IPC socket (`cursor_linux`).
//! Other Wayland desktops -- GNOME, KDE -- give an application no global
//! pointer position at all, but their portals can send it alongside every
//! frame as PipeWire cursor metadata (`SPA_META_Cursor`). A recording that
//! asked for that mode publishes the latest position here, and the app's
//! mouse tracker polls it through `screenCursorPosition` (`linux_api`).

use std::sync::{Arc, Mutex};

use pipewire::spa;
use spa::pod::{ChoiceValue, Object, Property, PropertyFlags, Value};
use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Id};

/// A pointer position as a fraction of the frame: (0, 0) is the top-left
/// corner, (1, 1) the bottom-right. Outside that range when the pointer is
/// off the captured screen or window.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CursorPoint {
  pub(crate) x: f64,
  pub(crate) y: f64,
}

/// Where a stream that asked for cursor metadata puts what it receives.
#[derive(Default)]
pub(crate) struct StreamCursor {
  latest: Mutex<Option<CursorPoint>>,
}

impl StreamCursor {
  /// Record a position in frame pixels. A frame size of zero (not negotiated
  /// yet) is ignored.
  pub(crate) fn set(&self, x: i32, y: i32, width: u32, height: u32) {
    if let Some(point) = to_fraction(x, y, width, height) {
      *self.latest.lock().unwrap_or_else(|e| e.into_inner()) = Some(point);
    }
  }

  pub(crate) fn latest(&self) -> Option<CursorPoint> {
    *self.latest.lock().unwrap_or_else(|e| e.into_inner())
  }
}

fn to_fraction(x: i32, y: i32, width: u32, height: u32) -> Option<CursorPoint> {
  if width == 0 || height == 0 {
    return None;
  }
  Some(CursorPoint {
    x: f64::from(x) / f64::from(width),
    y: f64::from(y) / f64::from(height),
  })
}

/// The running recording's cursor, if it is getting metadata.
static ACTIVE: Mutex<Option<Arc<StreamCursor>>> = Mutex::new(None);

/// Makes a cursor the one `screenCursorPosition` reports, until dropped.
pub(crate) struct ActiveCursor(Arc<StreamCursor>);

impl ActiveCursor {
  pub(crate) fn publish(cursor: Arc<StreamCursor>) -> Self {
    *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = Some(cursor.clone());
    Self(cursor)
  }
}

impl Drop for ActiveCursor {
  fn drop(&mut self) {
    let mut active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    if active.as_ref().is_some_and(|cursor| Arc::ptr_eq(cursor, &self.0)) {
      *active = None;
    }
  }
}

/// The running recording's latest pointer position, for stamping a click.
pub(crate) fn active_position() -> Option<CursorPoint> {
  let active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).clone();
  active.and_then(|cursor| cursor.latest())
}

/// Bytes of cursor metadata with room for a `size`-square bitmap: the
/// compositor sends the cursor's image along with its position when it fits.
/// Only the position is read, but a portal may skip the metadata altogether
/// when the bitmap has no room.
fn meta_size(size: i32) -> i32 {
  (std::mem::size_of::<spa::sys::spa_meta_cursor>() + std::mem::size_of::<spa::sys::spa_meta_bitmap>())
    as i32
    + size * size * 4
}

/// The `SPA_PARAM_Meta` request for cursor metadata, as GNOME's and KDE's
/// portals expect it.
pub(crate) fn meta_param() -> Result<Vec<u8>, String> {
  let object = Object {
    type_: spa::utils::SpaTypes::ObjectParamMeta.as_raw(),
    id: spa::param::ParamType::Meta.as_raw(),
    properties: vec![
      Property {
        key: spa::sys::SPA_PARAM_META_type,
        flags: PropertyFlags::empty(),
        value: Value::Id(Id(spa::sys::SPA_META_Cursor)),
      },
      Property {
        key: spa::sys::SPA_PARAM_META_size,
        flags: PropertyFlags::empty(),
        value: Value::Choice(ChoiceValue::Int(Choice(
          ChoiceFlags::empty(),
          ChoiceEnum::Range {
            default: meta_size(64),
            min: meta_size(1),
            max: meta_size(512),
          },
        ))),
      },
    ],
  };
  spa::pod::serialize::PodSerializer::serialize(
    std::io::Cursor::new(Vec::new()),
    &Value::Object(object),
  )
  .map(|(cursor, _)| cursor.into_inner())
  .map_err(|error| format!("could not encode the PipeWire cursor request: {error:?}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn positions_become_fractions_of_the_frame() {
    assert_eq!(to_fraction(960, 270, 1920, 1080), Some(CursorPoint { x: 0.5, y: 0.25 }));
    assert_eq!(to_fraction(-192, 1080, 1920, 1080), Some(CursorPoint { x: -0.1, y: 1.0 }));
    assert_eq!(to_fraction(5, 5, 0, 1080), None);
  }

  #[test]
  fn only_the_published_cursor_is_reported_and_only_while_published() {
    let cursor = Arc::new(StreamCursor::default());
    {
      let _active = ActiveCursor::publish(cursor.clone());
      assert!(active_position().is_none(), "nothing has arrived yet");
      cursor.set(480, 540, 1920, 1080);
      let position = active_position().unwrap();
      assert_eq!((position.x, position.y), (0.25, 0.5));
    }
    assert!(active_position().is_none());
  }

  #[test]
  fn the_meta_request_serializes() {
    let bytes = meta_param().unwrap();
    assert!(spa::pod::Pod::from_bytes(&bytes).is_some());
    // 28-byte cursor header + 20-byte bitmap header.
    assert_eq!(meta_size(1), 52);
  }
}
