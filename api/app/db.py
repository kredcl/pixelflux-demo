import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Compatibilidad: SQLAlchemy 1.3/1.4/2.x
try:
    from sqlalchemy.orm import declarative_base  # 1.4+ / 2.x
except ImportError:
    from sqlalchemy.ext.declarative import declarative_base  # 1.3

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL no esta seteada. Sin fallback por seguridad: "
        "el proceso no arranca sin una URL de base de datos explicita."
    )

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=3600,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Dependency para FastAPI
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
