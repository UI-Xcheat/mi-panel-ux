$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root '.env'
$secretsFile = Join-Path $root '.supabase-edge-secrets.tmp'
$projectRef = 'yqomkgcbzvdhuxzpyqry'

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  throw 'Falta npx. Instala Node.js 20 o posterior y vuelve a abrir PowerShell.'
}
$supabaseCli = Join-Path $root 'node_modules\.bin\supabase.cmd'
if (-not (Test-Path -LiteralPath $supabaseCli)) {
  throw 'Falta Supabase CLI local. Desde esta carpeta ejecuta: npm install --save-dev supabase'
}
if (-not (Test-Path -LiteralPath $envFile)) {
  throw 'No encuentro license-server/.env. Se necesita para tomar los usuarios Owner y Admin sin imprimir sus contraseñas.'
}

$values = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match '^\s*(OWNER_USERNAME|OWNER_PASSWORD|ADMIN_USERNAME|ADMIN_USERNAMES|ADMIN_PASSWORD)\s*=\s*(.*)\s*$') {
    $value = $Matches[2].Trim().Trim('"').Trim("'")
    $values[$Matches[1]] = $value
  }
}
if (-not $values.OWNER_USERNAME -or -not $values.OWNER_PASSWORD -or -not $values.ADMIN_PASSWORD) {
  throw 'El .env debe tener OWNER_USERNAME, OWNER_PASSWORD y ADMIN_PASSWORD configurados.'
}
if (-not $values.ADMIN_USERNAMES) { $values.ADMIN_USERNAMES = $values.ADMIN_USERNAME }
if (-not $values.ADMIN_USERNAMES) { throw 'Configura ADMIN_USERNAME o ADMIN_USERNAMES en .env.' }

try {
  @(
    "OWNER_USERNAME=$($values.OWNER_USERNAME)"
    "OWNER_PASSWORD=$($values.OWNER_PASSWORD)"
    "ADMIN_USERNAMES=$($values.ADMIN_USERNAMES)"
    "ADMIN_PASSWORD=$($values.ADMIN_PASSWORD)"
  ) | Set-Content -LiteralPath $secretsFile -Encoding ascii

  Write-Host 'Aplicando tablas de cuentas en Supabase…'
  & $supabaseCli db push --linked
  if ($LASTEXITCODE -ne 0) { throw 'Falló supabase db push.' }

  Write-Host 'Configurando credenciales de Owner y Admin en Supabase…'
  & $supabaseCli secrets set --env-file $secretsFile --project-ref $projectRef
  if ($LASTEXITCODE -ne 0) { throw 'Falló la carga de secretos.' }

  Write-Host 'Publicando API segura…'
  & $supabaseCli functions deploy panel-api --no-verify-jwt --project-ref $projectRef
  if ($LASTEXITCODE -ne 0) { throw 'Falló el despliegue de panel-api.' }
  Write-Host 'API segura desplegada. Ya puedes distribuir UiXtreamLicenseServer.exe sin .env.'
} finally {
  Remove-Item -LiteralPath $secretsFile -Force -ErrorAction SilentlyContinue
}
