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

#[cfg(test)]
mod certificate_scenarios {
  use super::*;

  fn hosts(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn a_certificate_needs_at_least_one_host() {
    // A certificate covering nothing produces a different, far more confusing
    // browser error than the ordinary self-signed warning.
    assert!(generate_self_signed_certificate(Vec::new()).is_err());
  }

  #[test]
  fn the_refusal_says_why() {
    match generate_self_signed_certificate(Vec::new()) {
      Err(error) => assert!(error.reason.contains("host"), "{}", error.reason),
      Ok(_) => panic!("an empty host list was accepted"),
    }
  }

  #[test]
  fn a_single_host_produces_a_certificate() {
    let cert = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    assert!(!cert.cert_pem.is_empty());
    assert!(!cert.key_pem.is_empty());
  }

  #[test]
  fn the_certificate_is_pem_encoded() {
    let cert = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    assert!(cert.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(cert.cert_pem.trim_end().ends_with("-----END CERTIFICATE-----"));
  }

  #[test]
  fn the_key_is_pem_encoded() {
    let cert = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    assert!(cert.key_pem.contains("PRIVATE KEY"));
    assert!(cert.key_pem.starts_with("-----BEGIN"));
  }

  #[test]
  fn the_key_is_not_the_certificate() {
    let cert = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    assert_ne!(cert.cert_pem, cert.key_pem);
  }

  #[test]
  fn an_ip_address_is_accepted() {
    // IPs go in as IP SANs. As a DNS name they look like they work and then
    // fail validation on the phone.
    assert!(generate_self_signed_certificate(hosts(&["192.168.1.20"])).is_ok());
  }

  #[test]
  fn an_ipv6_address_is_accepted() {
    assert!(generate_self_signed_certificate(hosts(&["::1"])).is_ok());
  }

  #[test]
  fn a_mix_of_names_and_addresses_is_accepted() {
    // Which is the real case: every LAN IP plus localhost for testing on the
    // desktop itself.
    let cert = generate_self_signed_certificate(hosts(&[
      "localhost",
      "127.0.0.1",
      "192.168.1.20",
      "10.0.0.5",
    ]));
    assert!(cert.is_ok());
  }

  #[test]
  fn many_hosts_are_accepted() {
    let list: Vec<String> = (1..40).map(|i| format!("192.168.1.{i}")).collect();
    assert!(generate_self_signed_certificate(list).is_ok());
  }

  #[test]
  fn a_host_name_that_cannot_be_encoded_is_refused_rather_than_dropped() {
    // DNS SANs are IA5 strings, so anything outside ASCII cannot go in.
    // Quietly dropping it would produce a certificate that does not cover the
    // address the phone actually uses, which is the confusing failure again.
    let bad = generate_self_signed_certificate(hosts(&["caf\u{e9}.local"]));
    assert!(bad.is_err());
  }

  #[test]
  fn the_refusal_names_the_host_it_could_not_use() {
    match generate_self_signed_certificate(hosts(&["caf\u{e9}.local"])) {
      Err(error) => assert!(error.reason.contains("local"), "{}", error.reason),
      Ok(_) => panic!("a bad host name was accepted"),
    }
  }

  #[test]
  fn one_bad_host_refuses_the_whole_certificate() {
    let bad = generate_self_signed_certificate(hosts(&["localhost", "caf\u{e9}.local"]));
    assert!(bad.is_err());
  }

  #[test]
  fn an_odd_but_ascii_host_name_is_accepted_rather_than_second_guessed() {
    // IA5 allows more than a hostname grammar does. Validating harder here
    // would reject mDNS and container names that genuinely resolve.
    assert!(generate_self_signed_certificate(hosts(&["desk-top.local"])).is_ok());
    assert!(generate_self_signed_certificate(hosts(&["recso_dev"])).is_ok());
  }

  #[test]
  fn the_expiry_is_in_the_future() {
    let cert = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    let now_ms = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_millis() as f64;
    assert!(cert.expires_at_ms > now_ms, "{} vs {now_ms}", cert.expires_at_ms);
  }

  #[test]
  fn the_expiry_is_about_a_year_out() {
    // Long enough that the user is not tapping through a warning every week,
    // short enough that a leaked key has a horizon.
    let cert = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    let now_ms = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_millis() as f64;
    let days = (cert.expires_at_ms - now_ms) / 86_400_000.0;
    assert!((days - (VALID_FOR_DAYS - 1) as f64).abs() < 2.0, "{days} days");
  }

  #[test]
  fn the_caller_gets_an_expiry_it_can_regenerate_against() {
    // Stored so the caller can renew ahead of time rather than discovering the
    // expiry when a phone refuses to connect.
    let cert = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    assert!(cert.expires_at_ms.is_finite());
    assert!(cert.expires_at_ms > 0.0);
  }

  #[test]
  fn each_certificate_gets_its_own_key() {
    let a = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    let b = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    assert_ne!(a.key_pem, b.key_pem);
    assert_ne!(a.cert_pem, b.cert_pem);
  }

  #[test]
  fn a_certificate_is_big_enough_to_be_real() {
    let cert = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
    assert!(cert.cert_pem.len() > 400, "{}", cert.cert_pem.len());
  }
}

#[cfg(test)]
mod host_matrix {
  use super::*;

  /// Addresses a phone might genuinely use to reach the desktop.
  const GOOD: [&str; 12] = [
    "localhost",
    "127.0.0.1",
    "::1",
    "192.168.0.1",
    "192.168.1.20",
    "10.0.0.5",
    "172.16.31.4",
    "0.0.0.0",
    "255.255.255.255",
    "desktop.local",
    "desk-top.local",
    "recso_dev",
  ];

  /// Names that cannot be encoded as an IA5 DNS SAN.
  const BAD: [&str; 4] = [
    "caf\u{e9}.local",
    "\u{7a97}\u{53e3}",
    "n\u{e4}me",
    "\u{1f680}.local",
  ];

  fn hosts(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn every_reachable_address_is_accepted_on_its_own() {
    for host in GOOD {
      assert!(
        generate_self_signed_certificate(hosts(&[host])).is_ok(),
        "{host}"
      );
    }
  }

  #[test]
  fn every_reachable_address_is_accepted_alongside_the_others() {
    // The real call lists every interface, because an address missing from the
    // certificate produces a much more confusing browser error than the
    // ordinary self-signed warning.
    for host in GOOD {
      assert!(
        generate_self_signed_certificate(hosts(&["localhost", "127.0.0.1", host])).is_ok(),
        "{host}"
      );
    }
  }

  #[test]
  fn every_unencodable_name_is_refused_on_its_own() {
    for host in BAD {
      assert!(
        generate_self_signed_certificate(hosts(&[host])).is_err(),
        "{host}"
      );
    }
  }

  #[test]
  fn one_unencodable_name_refuses_the_whole_certificate() {
    // Quietly dropping it would produce a certificate that does not cover the
    // address the phone actually uses.
    for bad in BAD {
      for good in ["localhost", "192.168.1.20"] {
        assert!(
          generate_self_signed_certificate(hosts(&[good, bad])).is_err(),
          "{good} + {bad}"
        );
        assert!(
          generate_self_signed_certificate(hosts(&[bad, good])).is_err(),
          "{bad} + {good}"
        );
      }
    }
  }

  #[test]
  fn every_refusal_names_something_from_the_host_it_could_not_use() {
    for host in BAD {
      match generate_self_signed_certificate(hosts(&[host])) {
        Err(error) => {
          let message = error.reason.clone();
          assert!(!message.is_empty(), "{host}");
          assert!(message.contains("host"), "{host}: {message}");
        }
        Ok(_) => panic!("{host} was accepted"),
      }
    }
  }

  #[test]
  fn an_empty_host_list_is_always_refused() {
    match generate_self_signed_certificate(Vec::new()) {
      Err(error) => assert!(error.reason.contains("host"), "{}", error.reason),
      Ok(_) => panic!("an empty host list was accepted"),
    }
  }

  #[test]
  fn every_certificate_is_pem_encoded_for_any_host_list() {
    let lists: [&[&str]; 4] = [
      &["localhost"],
      &["127.0.0.1"],
      &["localhost", "127.0.0.1", "192.168.1.20"],
      &GOOD,
    ];
    for list in lists {
      let cert = generate_self_signed_certificate(hosts(list)).unwrap();
      assert!(cert.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"), "{list:?}");
      assert!(
        cert.cert_pem.trim_end().ends_with("-----END CERTIFICATE-----"),
        "{list:?}"
      );
      assert!(cert.key_pem.contains("PRIVATE KEY"), "{list:?}");
      assert_ne!(cert.cert_pem, cert.key_pem, "{list:?}");
    }
  }

  #[test]
  fn every_certificate_expires_about_a_year_out() {
    let now_ms = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_millis() as f64;
    for host in GOOD {
      let cert = generate_self_signed_certificate(hosts(&[host])).unwrap();
      let days = (cert.expires_at_ms - now_ms) / 86_400_000.0;
      assert!(
        (days - (VALID_FOR_DAYS - 1) as f64).abs() < 2.0,
        "{host}: {days} days"
      );
      assert!(cert.expires_at_ms > now_ms, "{host}");
    }
  }

  #[test]
  fn every_certificate_gets_its_own_key() {
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..8 {
      let cert = generate_self_signed_certificate(hosts(&["localhost"])).unwrap();
      assert!(seen.insert(cert.key_pem.clone()), "a key was reused");
    }
  }

  #[test]
  fn a_long_host_list_is_accepted() {
    for count in [1usize, 8, 40, 120] {
      let list: Vec<String> = (0..count).map(|i| format!("10.0.{}.{}", i / 256, i % 256)).collect();
      assert!(generate_self_signed_certificate(list).is_ok(), "{count} hosts");
    }
  }

  #[test]
  fn a_repeated_host_is_accepted_rather_than_refused() {
    // The caller enumerates interfaces; two of them can report the same
    // address, and that is not a reason to fail a recording session.
    for host in ["localhost", "192.168.1.20"] {
      assert!(
        generate_self_signed_certificate(hosts(&[host, host, host])).is_ok(),
        "{host}"
      );
    }
  }
}
