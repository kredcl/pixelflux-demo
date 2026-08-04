from datetime import datetime, timedelta
from jose import jwt
from argon2 import PasswordHasher
import os


JWT_SECRET = os.getenv("JWT_SECRET")
ALGO = "HS256"
ACCESS_MIN = 30
ph = PasswordHasher()


def make_token(sub: str):
    payload = {"sub": sub, "exp": datetime.utcnow() + timedelta(minutes=ACCESS_MIN)}
    return jwt.encode(payload, JWT_SECRET, algorithm=ALGO)


def verify_password(hash_: str, plain: str) -> bool:
    try:
        ph.verify(hash_, plain)
        return True
    except Exception:
        return False


def hash_password(plain: str) -> str:
    return ph.hash(plain)