[CmdletBinding()]
param([Parameter(Position=0)][ValidateSet('status','start','stop','restart','settings')][string]$Command='status')
$ErrorActionPreference='Stop'
$pipe=New-Object System.IO.Pipes.NamedPipeClientStream('.', 'HomeMCP-Manager', [System.IO.Pipes.PipeDirection]::InOut)
try {
 $pipe.Connect(2000)
 $writer=New-Object System.IO.StreamWriter($pipe,[Text.Encoding]::UTF8,1024,$true)
 $writer.AutoFlush=$true
 $reader=New-Object System.IO.StreamReader($pipe,[Text.Encoding]::UTF8,$false,1024,$true)
 try {
  $writer.WriteLine($Command)
  $answer=$reader.ReadLine()
  if($null -eq $answer -or $answer.StartsWith('ERROR')) {throw "HomeMCP: $answer"}
  Write-Output $answer
 }finally{$writer.Dispose();$reader.Dispose()}
}finally{$pipe.Dispose()}
