param(
    [string]$Model = $env:MISTRAL_MODEL
)

if (-not $Model) {
    $Model = "mistral-small-latest"
}

$apiKey = $env:MISTRAL_API_KEY
if (-not $apiKey) {
    $secureKey = Read-Host "Mistral API key" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
        $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

if (-not $apiKey) {
    throw "MISTRAL_API_KEY is empty."
}

$headers = @{
    Authorization = "Bearer $apiKey"
    "Content-Type" = "application/json"
}

$body = @{
    model = $Model
    messages = @(
        @{ role = "system"; content = "Return only valid JSON." },
        @{ role = "user"; content = '{"ok": true, "message": "connection test"}' }
    )
    temperature = 0
    response_format = @{ type = "json_object" }
} | ConvertTo-Json -Depth 10

$response = Invoke-RestMethod `
    -Uri "https://api.mistral.ai/v1/chat/completions" `
    -Method Post `
    -Headers $headers `
    -Body $body

$content = $response.choices[0].message.content
Write-Host "Mistral connection OK with model: $Model"
Write-Host $content
