//! A self-signed certificate for the phone pairing server.
//!
//! This exists for one reason: browsers refuse `getUserMedia` outside a secure
//! context, and a LAN address like `https://192.168.1.42:7420` is only secure if
//! it is actually TLS. There is no way around it -- `http://` on a private IP is
//! insecure by definition to Chrome and Safari, and the camera API is simply not
//! there. So the desktop has to serve HTTPS, and on a private network with no
//! domain name the only certificate available is one it signs itself.
//!
//! The phone will show a warning the first time and the user has to tap through
//! it. That is not a bug being papered over; it is the honest state of affairs.
//! The certificate really is unverifiable, because nothing on a home network can
//! vouch for it.
//!
//! What matters is that the key is generated **per install** and kept out of the
//! repository. A shipped certificate would put the same private key on every
//! machine, which would let anyone who downloaded the app impersonate anyone
//! else's pairing server on a shared network -- a coffee shop, an office. A
//! locally generated one is unverifiable but still private, so the tap-through
//! buys real encryption rather than theatre.

use napi_derive::napi;
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};

/// A certificate and its private key, both PEM encoded.
#[napi(object)]
pub struct SelfSignedCertificate {
  pub cert_pem: String,
  pub key_pem: String,
  /// When it stops being valid, as a Unix timestamp in milliseconds. The caller
  /// stores this so it can regenerate ahead of time rather than discovering the
  /// expiry when a phone refuses to connect.
  pub expires_at_ms: f64,
}

/// Days a generated certificate is good for.
///
/// Long enough that the user is not tapping through a warning every week, short
/// enough that a key which leaked off a machine has a horizon. The caller
/// regenerates when this passes, and the phone sees one more warning.
const VALID_FOR_DAYS: i64 = 365;

/// Generate a certificate covering the given hosts.
///
/// `hosts` should be every address the phone might use to reach this machine --
/// each LAN IP, and `localhost` for testing on the desktop itself. An address
/// missing from this list produces a *different* browser error from the ordinary
/// self-signed warning, and a much more confusing one, so it is better to list
/// every interface than to guess which one the phone will pick.
#[napi]
pub fn generate_self_signed_certificate(hosts: Vec<String>) -> napi::Result<SelfSignedCertificate> {
  if hosts.is_empty() {
    return Err(napi::Error::from_reason(
      "a certificate needs at least one host to cover",
    ));
  }

  let mut params = CertificateParams::default();

  let mut name = DistinguishedName::new();
  name.push(DnType::CommonName, "Recso phone camera");
  name.push(DnType::OrganizationName, "Recso");
  params.distinguished_name = name;

  // IP addresses go in as IP SANs and names as DNS SANs. Putting an IP in as a
  // DNS name looks like it works and then fails validation on the phone, which
  // is a miserable thing to debug from the far side of a browser warning.
  params.subject_alt_names = hosts
    .iter()
    .map(|host| -> napi::Result<SanType> {
      match host.parse() {
        Ok(ip) => Ok(SanType::IpAddress(ip)),
        Err(_) => {
          let name = host
            .clone()
            .try_into()
            .map_err(|_| napi::Error::from_reason(format!("{host:?} is not a usable host name")))?;
          Ok(SanType::DnsName(name))
        }
      }
    })
    .collect::<napi::Result<Vec<_>>>()?;

  let not_before = time::OffsetDateTime::now_utc() - time::Duration::days(1);
  let not_after = not_before + time::Duration::days(VALID_FOR_DAYS);
  params.not_before = not_before;
  params.not_after = not_after;

  let key = KeyPair::generate()
    .map_err(|error| napi::Error::from_reason(format!("could not generate a key: {error}")))?;
  let cert = params.self_signed(&key).map_err(|error| {
    napi::Error::from_reason(format!("could not sign the certificate: {error}"))
  })?;

  Ok(SelfSignedCertificate {
    cert_pem: cert.pem(),
    key_pem: key.serialize_pem(),
    expires_at_ms: (not_after.unix_timestamp() as f64) * 1000.0,
  })
}
