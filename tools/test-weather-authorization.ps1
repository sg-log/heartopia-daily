param([string] $OutputPath = (Join-Path $env:TEMP 'heartopia-weather-authorization-test.html'))
$ErrorActionPreference = 'Stop'

$source = [IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot) 'apps-script/weather-api.gs'))
$match = [regex]::Match($source, '(?s)function checkWeatherAuthorizationStatus\(\) \{.*?\r?\n\}')
if (-not $match.Success) { throw 'checkWeatherAuthorizationStatus was not found' }

$functionSource = $match.Value
$html = @"
<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
<pre id="output">RUNNING</pre><script>
const output = document.getElementById('output');
const logs = [];
let status = 'REQUIRED';
let scopes = [];
let authInfoCalls = 0;
let driveCalls = 0;
let tokenCalls = 0;
window.Logger = { log: value => logs.push(String(value)) };
window.ScriptApp = {
  AuthMode: { FULL: 'FULL' },
  AuthorizationStatus: { REQUIRED: 'REQUIRED', NOT_REQUIRED: 'NOT_REQUIRED' },
  getAuthorizationInfo: mode => {
    if (mode !== 'FULL') throw new Error('FULL auth mode required');
    authInfoCalls++;
    return {
      getAuthorizationStatus: () => status,
      getAuthorizedScopes: () => scopes,
      getAuthorizationUrl: () => { throw new Error('authorization URL must not be read'); }
    };
  },
  getOAuthToken: () => { tokenCalls++; throw new Error('OAuth token must not be read'); }
};
Object.defineProperty(window, 'DriveApp', { get: () => { driveCalls++; throw new Error('Drive must not be accessed'); } });
$functionSource
function assert(condition, message) { if (!condition) throw new Error(message); }
try {
  checkWeatherAuthorizationStatus();
  assert(logs.join('|') === 'Authorization status: REQUIRED|Drive authorized: false', 'REQUIRED result');
  logs.length = 0;
  status = 'NOT_REQUIRED';
  scopes = ['https://www.googleapis.com/auth/drive'];
  checkWeatherAuthorizationStatus();
  assert(logs.join('|') === 'Authorization status: NOT_REQUIRED|Drive authorized: true', 'NOT_REQUIRED result');
  assert(authInfoCalls === 2 && driveCalls === 0 && tokenCalls === 0, 'safe APIs only');
  assert(logs.every(line => /^(Authorization status: (REQUIRED|NOT_REQUIRED)|Drive authorized: (true|false))$/.test(line)), 'safe logs only');
  output.textContent = 'PASS: authorization status and Drive scope are reported without Drive access, authorization URL, or OAuth token.';
} catch (error) {
  output.textContent = 'FAIL: ' + error.message;
}
</script>
"@
[IO.File]::WriteAllText($OutputPath, $html, [Text.UTF8Encoding]::new($false))
"Open in browser: $OutputPath"
