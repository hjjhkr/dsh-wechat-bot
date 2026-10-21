$ErrorActionPreference='Stop'
$botRoot=$PSScriptRoot
$saved=Get-Content -LiteralPath (Join-Path $botRoot '_work/dsh-process.json') -Raw|ConvertFrom-Json
$process=Get-Process -Id $saved.pid -ErrorAction SilentlyContinue
if(-not $process){throw '此记录的机器人DSH已停止；未操作其他进程'}
if([Math]::Abs($process.StartTime.ToUniversalTime().Ticks-[long]$saved.startedUtcTicks) -ge 10000000){throw 'PID已被重用，停止'}
$native=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$saved.pid)
if($native.ExecutablePath -ine $saved.executable -or $native.CommandLine -notlike ('*'+$saved.cli+'*')){throw '进程路径不符，停止'}
$listeners=@(Get-NetTCPConnection -LocalPort 5310 -State Listen -ErrorAction SilentlyContinue)
if($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $saved.pid -or $listeners[0].LocalAddress -ne '127.0.0.1'){throw '本机监听身份不符，停止'}
$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
$null=Invoke-WebRequest -Uri 'http://127.0.0.1:5310/wechat-bot/' -WebSession $session
$result=Invoke-RestMethod -Uri 'http://127.0.0.1:5310/wechat-bot/api/shutdown' -Method Post -Headers @{Origin='http://127.0.0.1:5310'} -ContentType 'application/json' -Body '{}' -WebSession $session -TimeoutSec 120
if($result.success -ne $true -or $result.workerClosed -ne $true -or $result.gateActive -ne $false){throw '插件未确认安全关闭；未强杀进程'}
$deadline=[DateTime]::UtcNow.AddSeconds(15)
while((Get-Process -Id $saved.pid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 250}
if(Get-Process -Id $saved.pid -ErrorAction SilentlyContinue){throw '官方退出尚未完成；未强杀进程'}
$runtimeConfig=Get-Content -LiteralPath (Join-Path $botRoot 'config/wechat-bot.json') -Raw|ConvertFrom-Json
$state=Get-Content -LiteralPath (Join-Path $runtimeConfig.stateRoot 'state.json') -Raw|ConvertFrom-Json
if($state.workerClosed -ne $true -or $state.gateActive -ne $false -or (Test-Path -LiteralPath (Join-Path $runtimeConfig.stateRoot 'state.lock'))){throw '关闭后的状态或锁不符'}
Write-Output '机器人DSH已正常停止，微信工作进程已关闭、控件门已恢复。原运行意图和游标保留，下一次启动可恢复。'
