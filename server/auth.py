import hashlib
import hmac
import os

PBKDF2_ITERATIONS = 200_000


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return digest.hex(), salt.hex()


def verify_password(password: str, salt_hex: str, hash_hex: str) -> bool:
    salt = bytes.fromhex(salt_hex)
    digest, _ = hash_password(password, salt)
    return hmac.compare_digest(digest, hash_hex)
