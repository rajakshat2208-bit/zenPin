# auth.py
# ─────────────────────────────────────────────────────────────
# Authentication helpers for ZenPin.
# ─────────────────────────────────────────────────────────────

import os
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from dotenv import load_dotenv

import database as db

load_dotenv()

# ── Config ────────────────────────────────────────────────────
JWT_SECRET      = os.getenv("JWT_SECRET", "dev-secret-change-in-production")
JWT_ALGORITHM   = "HS256"
JWT_EXPIRE_DAYS = int(os.getenv("JWT_EXPIRE_DAYS", "7"))

# ── Password hashing ──────────────────────────────────────────
# bcrypt limit: 72 bytes
pwd_context = CryptContext(schemes=["bcrypt_sha256"], deprecated="auto")

MAX_BCRYPT_BYTES = 72

def _truncate_password(password: str) -> str:
    """
    Ensure password does not exceed bcrypt's 72-byte limit.
    Handles UTF-8 safely.
    """
    return password.encode("utf-8")[:MAX_BCRYPT_BYTES].decode("utf-8", "ignore")

def hash_password(plain: str) -> str:
    """Hash password safely for bcrypt."""
    plain = _truncate_password(plain)
    return pwd_context.hash(plain)

def verify_password(plain: str, hashed: str) -> bool:
    """Verify password safely with bcrypt."""
    plain = _truncate_password(plain)
    return pwd_context.verify(plain, hashed)


# ── JWT tokens ────────────────────────────────────────────────
def create_token(user_id: int, username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS)
    payload = {
        "sub": str(user_id),
        "username": username,
        "exp": expire,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token is invalid or expired. Please log in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ── FastAPI dependency ────────────────────────────────────────
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    payload = decode_token(token)
    user_id = int(payload.get("sub"))
    user = db.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


def get_optional_user(token: str = Depends(OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False))) -> dict | None:
    if not token:
        return None
    try:
        payload = decode_token(token)
        user_id = int(payload.get("sub"))
        return db.get_user_by_id(user_id)
    except Exception:
        return None