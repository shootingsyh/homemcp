[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('protect','unprotect')][string]$Operation,
 [Parameter(Mandatory=$true)][string]$Binding
)
$ErrorActionPreference='Stop'
# The secret arrives over stdin, never in process command-line arguments.
Add-Type -AssemblyName System.Security
$entropy=[Security.Cryptography.SHA256]::Create().ComputeHash([Convert]::FromBase64String($Binding))
$payload=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
try {
 if($Operation -eq 'protect') {
  $output=[Security.Cryptography.ProtectedData]::Protect($payload,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 } else {
  $output=[Security.Cryptography.ProtectedData]::Unprotect($payload,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 }
 [Console]::Out.Write([Convert]::ToBase64String($output))
} finally {
 [Array]::Clear($payload,0,$payload.Length)
}
