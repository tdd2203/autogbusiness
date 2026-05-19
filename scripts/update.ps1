# Update the whole codebase after pulling new code or fixing bugs.
# Run from project root: .\scripts\update.ps1
# Optional flags:
#   .\scripts\update.ps1 -SkipMigrate    : skip alembic upgrade
#   .\scripts\update.ps1 -SkipExtension  : skip extension build
#   .\scripts\update.ps1 -SkipDashboard  : skip dashboard build
#   .\scripts\update.ps1 -KeepBackend    : do not restart backend

param(
    [switch]$SkipMigrate,
    [switch]$SkipExtension,
    [switch]$SkipDashboard,
    [switch]$KeepBackend
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Step($name, $action) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    & $action
}

# 1. Postgres alive - auto-start if container is stopped
Step "Check Postgres" {
    docker exec autogpt-postgres pg_isready -U autogpt 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Postgres is not running, starting via docker compose..." -ForegroundColor Yellow
        docker compose up -d
        if ($LASTEXITCODE -ne 0) {
            Write-Host "docker compose up failed - is Docker Desktop running?" -ForegroundColor Red
            exit 1
        }
        # Poll up to 30s waiting for Postgres to accept connections
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

# 2. Migration
if (-not $SkipMigrate) {
    Step "Alembic migrate" {
        Push-Location apps\api
        try {
            & .\.venv\Scripts\python.exe -m alembic upgrade head
        } finally { Pop-Location }
    }
}

# 3. Restart backend — port riêng 18000
if (-not $KeepBackend) {
    Step "Restart backend (:18000)" {
        $netstat = netstat -ano | findstr ":18000 " | findstr LISTEN
        if ($netstat) {
            $pidLine = ($netstat -split '\s+')[-1]
            Write-Host "Killing process $pidLine on port 18000..."
            Stop-Process -Id $pidLine -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        Push-Location apps\api
        try {
            Start-Process -FilePath ".\.venv\Scripts\python.exe" `
                -ArgumentList "-m","uvicorn","app.main:app","--host","127.0.0.1","--port","18000" `
                -WindowStyle Hidden
        } finally { Pop-Location }
        Start-Sleep -Seconds 3
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:18000/health" -TimeoutSec 5
            Write-Host "Backend health: $($h.status)"
        } catch {
            Write-Host "Backend not ready yet, wait or check log" -ForegroundColor Yellow
        }
    }
}

# 4. Build extension
if (-not $SkipExtension) {
    Step "Build extension" {
        Push-Location apps\extension
        try {
            & npm run build
        } finally { Pop-Location }
    }
}

# 5. Dashboard — auto-spawn Vite dev nếu 17173 chưa chạy, ngược lại để HMR
# tự pick up. update.ps1 KHÔNG dùng `npm run build` nữa (production build chỉ
# tạo file tĩnh, không có server) — ưu tiên Vite dev cho dev loop nhanh.
if (-not $SkipDashboard) {
    Step "Dashboard (Vite :17173)" {
        $vite = Get-NetTCPConnection -LocalPort 17173 -State Listen -ErrorAction SilentlyContinue
        if ($vite) {
            Write-Host "Vite dev đang chạy trên 17173 (PID $($vite[0].OwningProcess)) - HMR auto pick up"
        } else {
            Write-Host "Vite chưa chạy trên 17173 — spawn cửa sổ mới npm run dev..."
            $webDir = Join-Path $root "apps\web"
            Start-Process -FilePath "powershell.exe" -ArgumentList @(
                "-NoExit", "-Command", "cd '$webDir'; npm run dev"
            ) -WindowStyle Normal
        }
    }
}

Write-Host "`n=== DONE ===" -ForegroundColor Green
