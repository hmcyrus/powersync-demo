import base64
from functools import lru_cache

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from config import JWT_KID, JWT_PRIVATE_KEY_PEM


def _b64url_int(value: int) -> str:
    length = (value.bit_length() + 7) // 8
    return base64.urlsafe_b64encode(value.to_bytes(length, "big")).rstrip(b"=").decode("ascii")


@lru_cache
def signing_key():
    if JWT_PRIVATE_KEY_PEM.strip():
        return serialization.load_pem_private_key(JWT_PRIVATE_KEY_PEM.encode("utf-8"), password=None)
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def private_key_pem() -> str:
    return signing_key().private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")


def jwks_document() -> dict:
    numbers = signing_key().public_key().public_numbers()
    return {
        "keys": [
            {
                "kty": "RSA",
                "kid": JWT_KID,
                "use": "sig",
                "alg": "RS256",
                "n": _b64url_int(numbers.n),
                "e": _b64url_int(numbers.e),
            }
        ]
    }
