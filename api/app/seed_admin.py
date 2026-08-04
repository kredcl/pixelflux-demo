import os
from sqlalchemy import select
from .db import Base, engine, SessionLocal
from .models import User
from .auth import hash_password


ADMIN_EMAIL = os.getenv("ADMIN_EMAIL")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")


Base.metadata.create_all(bind=engine)


with SessionLocal() as s:
    if ADMIN_EMAIL:
        exists = s.execute(select(User).where(User.email == ADMIN_EMAIL)).scalar_one_or_none()
        if not exists:
            u = User(email=ADMIN_EMAIL, name="Admin", password_hash=hash_password(ADMIN_PASSWORD))
            s.add(u)
            s.commit()
            print("Admin creado:", ADMIN_EMAIL)
        else:
            print("Admin ya existe")