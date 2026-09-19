[CmdletBinding()]
param(
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

function Assert-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$InstallHint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "O comando '$Name' nao foi encontrado. $InstallHint"
    }
}

Write-Host "RadioStore - instalacao com Docker" -ForegroundColor Cyan
Assert-Command -Name "docker" -InstallHint "Instale e inicie o Docker Desktop: https://www.docker.com/products/docker-desktop/"

try {
    docker compose version | Out-Null
} catch {
    throw "O Docker Compose nao esta disponivel. Atualize ou reinstale o Docker Desktop."
}

docker info | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "O Docker Desktop esta instalado, mas o servico nao esta em execucao. Inicie-o e tente novamente."
}

$requiredFiles = @(
    "Dockerfile",
    "docker-compose.yml",
    "package.json",
    "package-lock.json",
    "server.js",
    "public/index.html"
)

$missingFiles = $requiredFiles | Where-Object { -not (Test-Path (Join-Path $projectRoot $_)) }
if ($missingFiles.Count -gt 0) {
    throw "O pacote esta incompleto. Arquivos ausentes: $($missingFiles -join ', '). Baixe novamente o ZIP da release."
}

Write-Host "Construindo e iniciando o RadioStore..." -ForegroundColor Yellow
docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
    throw "Nao foi possivel construir ou iniciar o RadioStore. Execute 'docker compose logs radiostore' para consultar os detalhes."
}

$healthUrl = "http://localhost:3000/api/health"
$appUrl = "http://localhost:3000"
$ready = $false

Write-Host "Aguardando o servidor..." -ForegroundColor Yellow
for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
        Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 | Out-Null
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}

if (-not $ready) {
    docker compose logs --tail 50 radiostore
    throw "O container iniciou, mas o servidor nao respondeu em $healthUrl."
}

Write-Host "RadioStore instalado e disponivel em $appUrl" -ForegroundColor Green
if (-not $NoOpen) {
    Start-Process $appUrl
}
