import base64
from datetime import timedelta

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa, utils

from jwrelease import sign, verify
from jwrelease.model import ReleaseEntry, manifest_rel_path, new_channel, sha256_hex

from conftest import T0

DATA = b'{"a":1}\n'


def test_sign_verify_round_trip(key):
    sig = sign.sign_bytes(DATA, key.private)
    assert verify.verify_signature(DATA, sig, [key.public]) == 0


def test_signature_format_is_cosign_sign_blob_compatible(key):
    """cosign sign-blob --key 의 출력 형식: base64( ASN.1 DER ECDSA 서명 ), 서명 대상은 blob 의 SHA-256."""
    sig = sign.sign_bytes(DATA, key.private)
    assert b"\n" not in sig and sig == sig.strip()
    der = base64.b64decode(sig, validate=True)
    r, s = utils.decode_dss_signature(der)          # DER SEQUENCE { r, s }
    assert 0 < r < 2**256 and 0 < s < 2**256
    # 미리 계산한 SHA-256 다이제스트에 대한 서명으로도 검증된다 = "blob 의 SHA-256 에 대한 ECDSA"
    digest = hashes.Hash(hashes.SHA256())
    digest.update(DATA)
    key.public.verify(der, digest.finalize(), ec.ECDSA(utils.Prehashed(hashes.SHA256())))


def test_verifies_signature_made_by_plain_ecdsa_like_cosign(key):
    """다른 구현(cosign·openssl)이 낸 서명을 받는 쪽: 표준 ECDSA-SHA256 DER 을 base64 로, 끝에 줄바꿈이 있어도."""
    der = key.private.sign(DATA, ec.ECDSA(hashes.SHA256()))
    for form in (base64.b64encode(der), base64.b64encode(der) + b"\n", base64.b64encode(der).decode() + "\r\n"):
        assert verify.verify_signature(DATA, form, [key.public]) == 0


def test_public_key_pem_is_spki_like_cosign_pub(key):
    pem = sign.public_key_pem(key.private)
    assert pem.startswith(b"-----BEGIN PUBLIC KEY-----")
    assert verify.load_public_key(pem).public_numbers() == key.public.public_numbers()


def test_either_of_two_keys_passes(key, other_key):
    sig_new = sign.sign_bytes(DATA, other_key.private)
    sig_old = sign.sign_bytes(DATA, key.private)
    keys = verify.load_public_keys([key.public_pem, other_key.public_pem])
    assert verify.verify_signature(DATA, sig_old, keys) == 0
    assert verify.verify_signature(DATA, sig_new, keys) == 1


def test_wrong_key_rejected(key, other_key):
    sig = sign.sign_bytes(DATA, key.private)
    with pytest.raises(verify.SignatureError):
        verify.verify_signature(DATA, sig, [other_key.public])


def test_tampered_data_or_signature_rejected(key):
    sig = sign.sign_bytes(DATA, key.private)
    with pytest.raises(verify.SignatureError):
        verify.verify_signature(DATA + b" ", sig, [key.public])
    der = bytearray(base64.b64decode(sig))
    der[-1] ^= 1
    with pytest.raises(verify.SignatureError):
        verify.verify_signature(DATA, base64.b64encode(bytes(der)), [key.public])
    for junk in (b"", b"   ", b"not base64 !!", "한글"):
        with pytest.raises(verify.SignatureError):
            verify.verify_signature(DATA, junk, [key.public])
    with pytest.raises(verify.SignatureError):
        verify.verify_signature(DATA, sig, [])


def test_public_key_count_and_kind(key, other_key):
    with pytest.raises(verify.VerifyError):
        verify.load_public_keys([])
    with pytest.raises(verify.VerifyError):
        verify.load_public_keys([key.public_pem, other_key.public_pem, key.public_pem])
    with pytest.raises(verify.VerifyError):
        verify.load_public_key(b"not a key")
    rsa_pub = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    with pytest.raises(verify.VerifyError):
        verify.load_public_key(rsa_pub)
    p384 = ec.generate_private_key(ec.SECP384R1()).public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    with pytest.raises(verify.VerifyError):
        verify.load_public_key(p384)


def test_private_key_loading(key, tmp_path):
    assert sign.load_private_key(key.private_pem).private_numbers() == key.private.private_numbers()
    encrypted = key.private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.BestAvailableEncryption(b"pw")
    )
    assert sign.load_private_key(encrypted, b"pw").private_numbers() == key.private.private_numbers()
    with pytest.raises(sign.SigningError):
        sign.load_private_key(encrypted, b"wrong")
    with pytest.raises(sign.SigningError):
        sign.load_private_key(encrypted)
    with pytest.raises(sign.SigningError):
        sign.load_private_key(b"-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----\n")
    p384 = ec.generate_private_key(ec.SECP384R1()).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    with pytest.raises(sign.SigningError):
        sign.load_private_key(p384)


def test_sign_file_writes_sig_next_to_file(key, tmp_path):
    f = tmp_path / "stable.json"
    f.write_bytes(DATA)
    out = sign.sign_file(f, key.private)
    assert out == tmp_path / "stable.json.sig"
    assert verify.verify_signature(DATA, out.read_bytes(), [key.public]) == 0


# ── 채널 검증 ────────────────────────────────────────────────


def signed_channel(key, name="stable", seq_bumps=1, now=T0, manifest_bytes=b"{}\n", version="1.0.0"):
    entry = ReleaseEntry(version, "2026-12-01T09:00:00Z", manifest_rel_path(version), sha256_hex(manifest_bytes), None, "")
    ch = new_channel(name).with_release(entry)
    for _ in range(seq_bumps):
        ch = ch.bumped(now, 30)
    data = ch.to_bytes()
    return data, sign.sign_bytes(data, key.private), ch


def test_channel_passes(key):
    data, sig, ch = signed_channel(key)
    got = verify.verify_channel(data, sig, [key.public], now=T0 + timedelta(days=1), expected_channel="stable", last_sequence=1)
    assert got == ch


def test_channel_expired_rejected(key):
    data, sig, _ = signed_channel(key)
    verify.verify_channel(data, sig, [key.public], now=T0 + timedelta(days=30) - timedelta(seconds=1))
    for late in (timedelta(days=30), timedelta(days=31)):
        with pytest.raises(verify.ExpiredError):
            verify.verify_channel(data, sig, [key.public], now=T0 + late)


def test_channel_sequence_rollback_rejected(key):
    data, sig, ch = signed_channel(key, seq_bumps=3)
    assert ch.sequence == 3
    verify.verify_channel(data, sig, [key.public], now=T0, last_sequence=3)      # 같은 순번은 통과
    verify.verify_channel(data, sig, [key.public], now=T0, last_sequence=None)   # 처음 보는 경우
    with pytest.raises(verify.RollbackError):
        verify.verify_channel(data, sig, [key.public], now=T0, last_sequence=4)


def test_channel_tampered_rejected_before_parsing(key):
    data, sig, _ = signed_channel(key)
    with pytest.raises(verify.SignatureError):
        verify.verify_channel(data.replace(b'"sequence":1', b'"sequence":9'), sig, [key.public], now=T0)
    with pytest.raises(verify.SignatureError):                 # 형식이 깨진 파일도 서명 오류가 먼저다
        verify.verify_channel(b"garbage", sig, [key.public], now=T0)


def test_channel_wrong_name_or_bad_content_rejected(key):
    data, sig, _ = signed_channel(key, name="beta")
    with pytest.raises(verify.ContentError):
        verify.verify_channel(data, sig, [key.public], now=T0, expected_channel="stable")
    bad = b'{"format":1}\n'
    with pytest.raises(verify.ContentError):
        verify.verify_channel(bad, sign.sign_bytes(bad, key.private), [key.public], now=T0)


def test_channel_check_order_signature_then_expiry_then_sequence(key, other_key):
    data, sig, _ = signed_channel(key)
    late = T0 + timedelta(days=365)
    with pytest.raises(verify.SignatureError):                 # 서명이 틀리면 만료보다 먼저
        verify.verify_channel(data, sig, [other_key.public], now=late, last_sequence=99)
    with pytest.raises(verify.ExpiredError):                   # 만료가 순번보다 먼저
        verify.verify_channel(data, sig, [key.public], now=late, last_sequence=99)


def test_channel_signed_by_next_key_passes_during_rotation(key, other_key):
    data, _, _ = signed_channel(key)
    sig = sign.sign_bytes(data, other_key.private)
    verify.verify_channel(data, sig, verify.load_public_keys([key.public_pem, other_key.public_pem]), now=T0)


# ── manifest 검증 ───────────────────────────────────────────


def test_manifest_passes_and_hash_mismatch_rejected(key, make_manifest):
    m = make_manifest("1.0.0")
    data = m.to_bytes()
    sig = sign.sign_bytes(data, key.private)
    entry = ReleaseEntry("1.0.0", m.published, manifest_rel_path("1.0.0"), sha256_hex(data), None, "")
    assert verify.verify_manifest(data, sig, [key.public], entry) == m

    other = make_manifest("1.0.0", changelog="다른 내용").to_bytes()
    with pytest.raises(verify.HashMismatchError):              # 서명이 맞아도 채널이 가리킨 파일이 아니면 거부
        verify.verify_manifest(other, sign.sign_bytes(other, key.private), [key.public], entry)


def test_manifest_bad_signature_rejected(key, other_key, make_manifest):
    data = make_manifest("1.0.0").to_bytes()
    entry = ReleaseEntry("1.0.0", "2026-12-01T09:00:00Z", manifest_rel_path("1.0.0"), sha256_hex(data), None, "")
    with pytest.raises(verify.SignatureError):
        verify.verify_manifest(data, sign.sign_bytes(data, other_key.private), [key.public], entry)


def test_manifest_must_agree_with_channel_entry(key, make_manifest):
    m = make_manifest("1.0.0", min_upgrade_from="1.0.0-beta.1")
    data = m.to_bytes()
    sig = sign.sign_bytes(data, key.private)
    sha = sha256_hex(data)
    path = manifest_rel_path("1.0.0")
    verify.verify_manifest(data, sig, [key.public], ReleaseEntry("1.0.0", m.published, path, sha, "1.0.0-beta.1", ""))
    for entry in (
        ReleaseEntry("1.0.1", m.published, path, sha, "1.0.0-beta.1", ""),
        ReleaseEntry("1.0.0", m.published, path, sha, None, ""),
        ReleaseEntry("1.0.0", "2027-01-01T00:00:00Z", path, sha, "1.0.0-beta.1", ""),
    ):
        with pytest.raises(verify.ContentError):
            verify.verify_manifest(data, sig, [key.public], entry)


def test_verify_file_hash():
    verify.verify_file_hash(b"x", sha256_hex(b"x"))
    with pytest.raises(verify.HashMismatchError):
        verify.verify_file_hash(b"y", sha256_hex(b"x"))
