# Dev mode: 1 lệnh khởi chạy toàn bộ stack trên Windows (PowerShell).
# macOS / Linux: dùng scripts/dev.sh (bash/zsh) tương đương.
# Run from project root: .\scripts\dev.ps1
#
# Mở 3 cửa sổ PowerShell riêng cho backend / web / extension để xem log từng service.
# Postgres chạy nền qua docker compose.
#
# Flags:
#   .\scripts\dev.ps1 -SkipMigrate    : bỏ qua alembic upgrade
#   .\scripts\dev.ps1 -SkipExtension  : không start extension watch
#   .\scripts\dev.ps1 -SkipWeb        : không start Vite dev
#   .\scripts\dev.ps1 -SkipBackend    : không start uvicorn

param(
    [switch]$SkipMigrate,
    [switch]$SkipExtension,
    [switch]$SkipWeb,
    [switch]$SkipBackend
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Step($name, $action) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    & $action
}

# 1. Postgres
Step "Postgres" {
    docker exec autogpt-postgres pg_isready -U autogpt 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Starting Postgres via docker compose..." -ForegroundColor Yellow
        docker compose up -d
        if ($LASTEXITCODE -ne 0) {
            Write-Host "docker compose failed - is Docker Desktop running?" -ForegroundColor Red
            exit 1
        }
        $ok = $false
        for ($i = 0; $i -lt 15; $i++) {
            Start-Sleep -Seconds 2
            docker exec autogpt-postgres pg_isready -U autogpt 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $ok = $true; break }
        }
        if (-not $ok) {
            Write-Host "Postgres not ready after 30s - check: docker logs autogpt-postgres" -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "OK"
}

# 2. Alembic
if (-not $SkipMigrate) {
    Step "Alembic migrate" {
        Push-Location apps\api
        try {
            & .\.venv\Scripts\python.exe -m alembic upgrade head
        } finally { Pop-Location }
    }
}

# 3. Kill port 18000 nếu đang dùng (tránh WinError 10013)
if (-not $SkipBackend) {
    Step "Free port 18000" {
        $conn = Get-NetTCPConnection -LocalPort 18000 -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
            foreach ($c in $conn) {
                Write-Host "Killing PID $($c.OwningProcess) on port 18000..."
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Seconds 1
        } else {
            Write-Host "Port 18000 free"
        }
    }

    # 4. Backend (uvicorn --reload) ở cửa sổ mới
    Step "Start backend (uvicorn --reload)" {
        $py = Join-Path $root "apps\api\.venv\Scripts\python.exe"
        $apiDir = Join-Path $root "apps\api"
        Start-Process -FilePath "powershell.exe" -ArgumentList @(
            "-NoExit", "-Command",
            "cd '$apiDir'; & '$py' -m uvicorn app.main:app --host 127.0.0.1 --port 18000 --reload"
        ) -WindowStyle Normal
        Write-Host "Backend window opened. Health check..."
        $ok = $false
        for ($i = 0; $i -lt 10; $i++) {
            Start-Sleep -Seconds 1
            try {
                $h = Invoke-RestMethod -Uri "http://127.0.0.1:18000/health" -TimeoutSec 2
                Write-Host "Backend health: $($h.status)" -ForegroundColor Green
                $ok = $true; break
            } catch {}
        }
        if (-not $ok) {
            Write-Host "Backend chưa ready sau 10s - kiểm tra cửa sổ backend" -ForegroundColor Yellow
        }
    }
}

# 5. Web (Vite dev) ở cửa sổ mới — port riêng 17173 (xem apps/web/vite.config.ts)
if (-not $SkipWeb) {
    Step "Start web dev (Vite :17173)" {
        $existing = Get-NetTCPConnection -LocalPort 17173 -State Listen -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Host "Vite đã chạy trên 17173 (PID $($existing[0].OwningProcess)) - skip" -ForegroundColor Yellow
        } else {
            $webDir = Join-Path $root "apps\web"
            Start-Process -FilePath "powershell.exe" -ArgumentList @(
                "-NoExit", "-Command", "cd '$webDir'; npm run dev"
            ) -WindowStyle Normal
            Write-Host "Web dev window opened"
        }
    }
}

# 6. Extension (Vite watch) ở cửa sổ mới — port riêng 17174
if (-not $SkipExtension) {
    Step "Start extension watch (Vite :17174)" {
        # Vite extension dùng strictPort=17174 (lock cứng để khớp với
        # host_permissions). Nếu lần chạy trước còn 1 process zombie đang
        # giữ 17174 → Vite mới sẽ fail. Skip-if-listening cho idempotent.
        $existing = Get-NetTCPConnection -LocalPort 17174 -State Listen -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Host "Vite extension đã chạy trên 17174 (PID $($existing[0].OwningProcess)) - skip" -ForegroundColor Yellow
        } else {
            $extDir = Join-Path $root "apps\extension"
            Start-Process -FilePath "powershell.exe" -ArgumentList @(
                "-NoExit", "-Command", "cd '$extDir'; npm run dev"
            ) -WindowStyle Normal
            Write-Host "Extension watch window opened - reload extension trong chrome://extensions sau khi sửa code"
        }
    }
}

Write-Host "`n=== ALL UP ===" -ForegroundColor Green
Write-Host "  Backend : http://127.0.0.1:18000  (docs: /docs)" -ForegroundColor White
Write-Host "  Web     : http://127.0.0.1:17173" -ForegroundColor White
Write-Host "  Postgres: localhost:5432 (docker)" -ForegroundColor White
Write-Host "  Logs    : Open 3 PowerShell windows" -ForegroundColor Gray
