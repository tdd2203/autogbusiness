from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import SessionLocal
from app.routers import audit_logs, auth, members, queue, users, workspaces
from app.seed import seed_super_admin


@asynccontextmanager
async def lifespan(_: FastAPI):
    with SessionLocal() as db:
        seed_super_admin(db)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="AutoGPT Dashboard API",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_origin],
        allow_origin_regex=r"chrome-extension://.*",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def private_network_access(request: Request, call_next):
        """Cho phép Chrome extension fetch tới localhost (Private Network Access)."""
        response = await call_next(request)
        if request.headers.get("access-control-request-private-network") == "true":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response
    app.include_router(auth.router)
    app.include_router(users.router)
    app.include_router(workspaces.router)
    app.include_router(members.router)
    app.include_router(queue.router)
    app.include_router(audit_logs.router)

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
