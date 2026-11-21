# Redefine a senha do usuário "postgres" do PostgreSQL local e grava a conexão de teste no .env do
# projeto (que não vai para o git). Para quem esqueceu a senha da instalação de desenvolvimento.
#
# Como rodar: abra o PowerShell COMO ADMINISTRADOR e execute
#   powershell -ExecutionPolicy Bypass -File scripts\dev-redefinir-senha-postgres.ps1
#
# O que ele faz, nesta ordem:
#   1. guarda uma cópia do pg_hba.conf;
#   2. libera, por alguns segundos, o login do "postgres" sem senha, só a partir desta máquina (127.0.0.1);
#   3. troca a senha do "postgres" por uma senha aleatória nova;
#   4. devolve o pg_hba.conf original (mesmo se algo der errado) e reinicia o serviço;
#   5. grava TEST_DATABASE_ADMIN_URL e SECRETS_MASTER_KEY no .env do projeto.

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Rode este script num PowerShell aberto como administrador." -ForegroundColor Red
    exit 1
}

$pgRoot = "C:\Program Files\PostgreSQL\18"
$service = "postgresql-x64-18"
$hba = Join-Path $pgRoot "data\pg_hba.conf"
$psql = Join-Path $pgRoot "bin\psql.exe"
$backup = "$hba.antes-da-redefinicao"
$projectEnv = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"

foreach ($path in @($hba, $psql)) {
    if (-not (Test-Path $path)) { Write-Host "Não encontrei $path" -ForegroundColor Red; exit 1 }
}

# Senha nova: 32 caracteres aleatórios, só letras e números (não precisa escapar em URL nem em SQL).
$chars = [char[]]"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })

Copy-Item $hba $backup -Force
try {
    $original = Get-Content $hba -Raw
    $temporary = "host all postgres 127.0.0.1/32 trust`r`n" + $original
    [IO.File]::WriteAllText($hba, $temporary)
    Restart-Service $service
    Start-Sleep -Seconds 3

    & $psql -h 127.0.0.1 -U postgres -d postgres -w -c "ALTER USER postgres WITH PASSWORD '$password';" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "o psql não conseguiu trocar a senha (código $LASTEXITCODE)" }
    Write-Host "Senha do postgres trocada." -ForegroundColor Green
}
finally {
    Copy-Item $backup $hba -Force
    Remove-Item $backup -Force
    Restart-Service $service
    Write-Host "pg_hba.conf original devolvido e serviço reiniciado."
}

# .env do projeto (ignorado pelo git). Mantém linhas que já existirem com outras variáveis.
$keyBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
$masterKey = [Convert]::ToBase64String($keyBytes)
$lines = @()
if (Test-Path $projectEnv) {
    $lines = Get-Content $projectEnv | Where-Object { $_ -notmatch "^(TEST_DATABASE_ADMIN_URL|SECRETS_MASTER_KEY)=" }
}
$lines += "TEST_DATABASE_ADMIN_URL=postgres://postgres:$password@127.0.0.1:5432/postgres"
$lines += "SECRETS_MASTER_KEY=$masterKey"
Set-Content -Path $projectEnv -Value $lines -Encoding utf8
Write-Host "Conexão de teste gravada em $projectEnv (fora do git)." -ForegroundColor Green
Write-Host "Pronto. Pode avisar o Claude."
