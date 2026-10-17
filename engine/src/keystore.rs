//! `keys.json`: the wallet's network and birthday, plus its recovery phrase encrypted with a
//! passphrase.
//!
//! The recovery phrase is the only secret the wallet stores. It is encrypted with the `age` format
//! (scrypt passphrase recipient, ASCII armor), the same encryption zcash-devtool uses for its
//! seed, so the file can be opened with any age implementation if the user ever needs to. The
//! passphrase is only ever received on the engine's stdin and is never written anywhere.

use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use age::secrecy::SecretString as AgeSecretString;
use bip0039::{English, Mnemonic};
use secrecy::{ExposeSecret, SecretVec, Zeroize};
use serde_json::{Value, json};
use zcash_protocol::consensus::Network;

use crate::{
    data::{WalletPaths, network_name, parse_network},
    failure::{Failure, R},
};

const KEYS_FILE: &str = "keys.json";
const FORMAT_VERSION: u64 = 1;
pub(crate) const MIN_PASSPHRASE_CHARS: usize = 8;

pub(crate) struct Keys {
    pub(crate) network: Network,
    pub(crate) birthday: u32,
    pub(crate) created_at: u64,
    phrase_ciphertext: String,
}

fn keys_path(paths: &WalletPaths) -> PathBuf {
    paths.root().join(KEYS_FILE)
}

pub(crate) fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Rejects passphrases that are too short to protect anything.
pub(crate) fn check_passphrase(passphrase: &str) -> R<()> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(Failure::new(
            "weak_passphrase",
            format!("Use a passphrase of at least {MIN_PASSPHRASE_CHARS} characters."),
        ));
    }
    Ok(())
}

/// Lower-cases and re-spaces a phrase typed or pasted by a person.
pub(crate) fn normalize_phrase(phrase: &str) -> String {
    phrase
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parses a recovery phrase, giving a plain-language error when it is wrong.
pub(crate) fn parse_phrase(phrase: &str) -> R<Mnemonic<English>> {
    let normalized = normalize_phrase(phrase);
    if normalized.is_empty() {
        return Err(Failure::new("bad_phrase", "Enter your recovery phrase."));
    }
    <Mnemonic<English>>::from_phrase(&normalized).map_err(|_| {
        Failure::new(
            "bad_phrase",
            "That recovery phrase is not valid. Check the words and their order.",
        )
    })
}

/// Derives the 64-byte wallet seed from a phrase (BIP 39, empty passphrase), as zcash-devtool does.
pub(crate) fn seed_from_mnemonic(mnemonic: &Mnemonic<English>) -> SecretVec<u8> {
    let mut seed_bytes = mnemonic.to_seed("");
    let seed = SecretVec::new(seed_bytes.to_vec());
    seed_bytes.zeroize();
    seed
}

fn encrypt_phrase(passphrase: &str, phrase: &str) -> R<String> {
    let recipient = age::scrypt::Recipient::new(AgeSecretString::from(passphrase.to_owned()));
    Ok(age::encrypt_and_armor(&recipient, phrase.as_bytes())?)
}

fn decrypt_phrase(passphrase: &str, ciphertext: &str) -> R<SecretVec<u8>> {
    let identity = age::scrypt::Identity::new(AgeSecretString::from(passphrase.to_owned()));
    match age::decrypt(&identity, ciphertext.as_bytes()) {
        Ok(bytes) => Ok(SecretVec::new(bytes)),
        Err(
            age::DecryptError::DecryptionFailed
            | age::DecryptError::KeyDecryptionFailed
            | age::DecryptError::NoMatchingKeys,
        ) => Err(Failure::new(
            "wrong_passphrase",
            "That passphrase is not correct.",
        )),
        Err(e) => Err(Failure::new(
            "keys_unreadable",
            format!("The encrypted recovery phrase could not be opened: {e}"),
        )),
    }
}

#[cfg(unix)]
fn open_private(path: &std::path::Path, create_new: bool) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = fs::OpenOptions::new();
    options.write(true).mode(0o600);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    options.open(path)
}

#[cfg(not(unix))]
fn open_private(path: &std::path::Path, create_new: bool) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    options.open(path)
}

impl Keys {
    fn to_json_string(&self) -> String {
        let value = json!({
            "format": FORMAT_VERSION,
            "network": network_name(self.network),
            "birthday": self.birthday,
            "createdAt": self.created_at,
            "phrase": self.phrase_ciphertext,
        });
        let mut text = serde_json::to_string_pretty(&value).expect("plain JSON always serializes");
        text.push('\n');
        text
    }

    pub(crate) fn exists(paths: &WalletPaths) -> bool {
        keys_path(paths).is_file()
    }

    pub(crate) fn read(paths: &WalletPaths) -> R<Self> {
        let path = keys_path(paths);
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(Failure::new(
                    "no_wallet",
                    "There is no wallet in this folder yet.",
                ));
            }
            Err(e) => return Err(e.into()),
        };
        let value: Value = serde_json::from_str(&text).map_err(|e| {
            Failure::new(
                "keys_unreadable",
                format!("keys.json is not valid JSON: {e}"),
            )
        })?;
        let unreadable =
            |why: &str| Failure::new("keys_unreadable", format!("keys.json is damaged: {why}."));

        let format = value.get("format").and_then(Value::as_u64);
        if format != Some(FORMAT_VERSION) {
            return Err(unreadable("unknown file format"));
        }
        let network = parse_network(
            value
                .get("network")
                .and_then(Value::as_str)
                .ok_or_else(|| unreadable("missing network"))?,
        )?;
        let birthday = value
            .get("birthday")
            .and_then(Value::as_u64)
            .and_then(|b| u32::try_from(b).ok())
            .ok_or_else(|| unreadable("missing birthday"))?;
        let created_at = value.get("createdAt").and_then(Value::as_u64).unwrap_or(0);
        let phrase_ciphertext = value
            .get("phrase")
            .and_then(Value::as_str)
            .ok_or_else(|| unreadable("missing recovery phrase"))?
            .to_string();

        Ok(Self {
            network,
            birthday,
            created_at,
            phrase_ciphertext,
        })
    }

    /// Writes a brand-new keys file, refusing to overwrite an existing one.
    pub(crate) fn create(
        paths: &WalletPaths,
        network: Network,
        birthday: u32,
        phrase: &str,
        passphrase: &str,
    ) -> R<Self> {
        check_passphrase(passphrase)?;
        fs::create_dir_all(paths.root())?;
        let keys = Self {
            network,
            birthday,
            created_at: now_unix(),
            phrase_ciphertext: encrypt_phrase(passphrase, phrase)?,
        };

        let mut file = match open_private(&keys_path(paths), true) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Failure::new(
                    "wallet_exists",
                    "A wallet already exists in this folder.",
                ));
            }
            Err(e) => return Err(e.into()),
        };
        file.write_all(keys.to_json_string().as_bytes())?;
        file.sync_all()?;
        Ok(keys)
    }

    /// Decrypts the recovery phrase.
    pub(crate) fn phrase(&self, passphrase: &str) -> R<SecretVec<u8>> {
        decrypt_phrase(passphrase, &self.phrase_ciphertext)
    }

    /// Decrypts the recovery phrase and derives the wallet seed from it.
    pub(crate) fn seed(&self, passphrase: &str) -> R<SecretVec<u8>> {
        let phrase_bytes = self.phrase(passphrase)?;
        let phrase = std::str::from_utf8(phrase_bytes.expose_secret()).map_err(|_| {
            Failure::new("keys_unreadable", "The stored recovery phrase is not text.")
        })?;
        let mnemonic = parse_phrase(phrase)?;
        Ok(seed_from_mnemonic(&mnemonic))
    }

    /// Re-encrypts the recovery phrase under a new passphrase and replaces the file atomically.
    pub(crate) fn change_passphrase(
        &mut self,
        paths: &WalletPaths,
        old_passphrase: &str,
        new_passphrase: &str,
    ) -> R<()> {
        check_passphrase(new_passphrase)?;
        let phrase_bytes = self.phrase(old_passphrase)?;
        let phrase = std::str::from_utf8(phrase_bytes.expose_secret()).map_err(|_| {
            Failure::new("keys_unreadable", "The stored recovery phrase is not text.")
        })?;
        let new_ciphertext = encrypt_phrase(new_passphrase, phrase)?;

        // Prove the new ciphertext opens before the old one is replaced.
        let check = decrypt_phrase(new_passphrase, &new_ciphertext)?;
        if check.expose_secret() != phrase_bytes.expose_secret() {
            return Err(Failure::new(
                "internal",
                "Re-encrypting the recovery phrase did not round-trip; nothing was changed.",
            ));
        }

        let previous = std::mem::replace(&mut self.phrase_ciphertext, new_ciphertext);
        let target = keys_path(paths);
        let tmp = target.with_extension("json.tmp");
        let result = (|| -> std::io::Result<()> {
            let mut file = open_private(&tmp, false)?;
            file.write_all(self.to_json_string().as_bytes())?;
            file.sync_all()?;
            fs::rename(&tmp, &target)
        })();
        if let Err(e) = result {
            self.phrase_ciphertext = previous;
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        Ok(())
    }
}
