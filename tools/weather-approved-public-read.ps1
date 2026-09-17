function Invoke-WeatherPublicApprovedRead {
    param([Parameter(Mandatory)] [string] $ApiUrl)

    $baseUri = $null
    if (-not [uri]::TryCreate($ApiUrl, [UriKind]::Absolute, [ref]$baseUri) -or
        $baseUri.Scheme -ne 'https' -or $baseUri.UserInfo -or $baseUri.Query -or $baseUri.Fragment) {
        throw 'WEATHER_SAFE:invalidEndpoint'
    }

    $builder = [UriBuilder]::new($baseUri)
    $builder.Query = 'action=approved'
    $approvedUri = $builder.Uri.AbsoluteUri
    $last = $null

    foreach ($attempt in 1..2) {
        $httpStatus = 0
        $contentType = ''
        $responseText = ''
        try {
            $webResponse = Invoke-WebRequest -Uri $approvedUri -Method Get -UseBasicParsing `
                -TimeoutSec 30 -ErrorAction Stop
            $httpStatus = [int]$webResponse.StatusCode
            $contentType = [string]$webResponse.Headers['Content-Type']
            $responseText = [string]$webResponse.Content
        } catch {
            $errorResponse = $_.Exception.Response
            if ($null -ne $errorResponse) {
                try { $httpStatus = [int]$errorResponse.StatusCode } catch { $httpStatus = 0 }
                try { $contentType = [string]$errorResponse.Headers['Content-Type'] } catch { $contentType = '' }
                try {
                    if ($null -ne $errorResponse.Content) {
                        $responseText = [string]$errorResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                    } else {
                        $reader = [IO.StreamReader]::new($errorResponse.GetResponseStream())
                        try { $responseText = $reader.ReadToEnd() } finally { $reader.Dispose() }
                    }
                } catch { $responseText = '' }
            }
        }

        try {
            $last = ConvertFrom-WeatherApiHttpResponse -HttpStatus $httpStatus -ContentType $contentType -BodyText $responseText
        } finally {
            $responseText = $null
        }
        if (-not $last.diagnostic.failureCode) { return $last }
        if ([string]$last.diagnostic.failureCode -cne 'networkError' -or $attempt -eq 2) { return $last }
        Start-Sleep -Seconds 2
    }
    $last
}
