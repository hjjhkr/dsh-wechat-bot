$ErrorActionPreference='Stop'
$botRoot=$PSScriptRoot
$nodeExe='C:\Program Files\nodejs\node.exe'
$cli=Join-Path $botRoot 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'
$port=5310
$processFile=Join-Path $botRoot '_work/dsh-process.json'
if(Test-Path -LiteralPath $processFile){
 $saved=Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
 $active=Get-Process -Id $saved.pid -ErrorAction SilentlyContinue
 if($active -and [Math]::Abs($active.StartTime.ToUniversalTime().Ticks-[long]$saved.startedUtcTicks) -lt 10000000){throw '此实例已在运行，请直接打开现有本机页面'}
}
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
try{$listener.Start()}finally{$listener.Stop()}
# 仅子进程继承这些专用根；不修改系统环境变量或工作DSH。
$env:DSH_HOME=Join-Path $botRoot 'home'
$env:DSH_AGENTS_HOME=Join-Path $botRoot 'agents-home'
Remove-Item Env:DSH_BUNDLED_SKILL_DIR -ErrorAction SilentlyContinue
Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:DEEPSEEK_BASE_URL -ErrorAction SilentlyContinue
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONDONTWRITEBYTECODE='1'
$process=Start-Process -FilePath $nodeExe -ArgumentList @($cli,'--profile','web','--host','127.0.0.1','--port',"$port",'--no-open') -WorkingDirectory 'C:/ExampleWorkspace' -WindowStyle Hidden -RedirectStandardOutput (Join-Path $botRoot 'logs/dsh.stdout.log') -RedirectStandardError (Join-Path $botRoot 'logs/dsh.stderr.log') -PassThru
[pscustomobject]@{pid=$process.Id;startedUtcTicks=$process.StartTime.ToUniversalTime().Ticks;startedUtc=$process.StartTime.ToUniversalTime().ToString('O');executable=$nodeExe;cli=$cli;port=$port;dshHome=$env:DSH_HOME;agentsHome=$env:DSH_AGENTS_HOME;workspace='C:/ExampleWorkspace'} | ConvertTo-Json | Set-Content -LiteralPath $processFile -Encoding utf8
Write-Output ('专用DSH已启动，PID='+$process.Id+'，本机端口='+$port+'；浏览器认证入口见本机logs/dsh.stdout.log。')