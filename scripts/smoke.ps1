param([string]$Destination="$env:LOCALAPPDATA\HomeMCP-dev")
$c=Get-Content (Join-Path $Destination 'config.json') -Raw|ConvertFrom-Json
$h=@{Authorization="Bearer $($c.token)";Accept='application/json, text/event-stream'}
$base="http://127.0.0.1:$($c.port)"
Invoke-RestMethod "$base/health" |ConvertTo-Json -Depth 6
$init=@{jsonrpc='2.0';id=1;method='initialize';params=@{protocolVersion='2025-03-26';capabilities=@{};clientInfo=@{name='smoke';version='1'}}}|ConvertTo-Json -Depth 8
Invoke-RestMethod "$base/mcp" -Headers $h -Method Post -ContentType 'application/json' -Body $init|ConvertTo-Json -Depth 6
$list=@{jsonrpc='2.0';id=2;method='tools/list';params=@{}}|ConvertTo-Json
Invoke-RestMethod "$base/mcp" -Headers $h -Method Post -ContentType 'application/json' -Body $list|ConvertTo-Json -Depth 8