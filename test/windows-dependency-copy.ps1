$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\packaging\copy-dependencies.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('homemcp-dependencies-'+[Guid]::NewGuid().ToString('N'))
try{
 $source=Join-Path $root 'source\node_modules';$dest=Join-Path $root 'payload\node_modules'
 New-Item -ItemType Directory -Path (Join-Path $source '@vendor\package'),(Split-Path $dest) -Force|Out-Null
 Set-Content (Join-Path $source '@vendor\package\index.js') 'module.exports=1;'
 Copy-HomeMCPDependencies $source $dest
 Set-Content (Join-Path $dest 'stale.js') 'stale'
 Set-Content (Join-Path $source '@vendor\package\index.js') 'module.exports=2;'
 Copy-HomeMCPDependencies $source $dest
 if(Test-Path (Join-Path $dest 'node_modules')){throw 'Repeated build nested dependencies'}
 if(Test-Path (Join-Path $dest 'stale.js')){throw 'Stale dependency survived'}
 if((Get-Content (Join-Path $dest '@vendor\package\index.js') -Raw).Trim() -ne 'module.exports=2;'){throw 'New dependency not copied'}
 $rejected=$false;try{Copy-HomeMCPDependencies $source $source}catch{$rejected=$true};if(!$rejected){throw 'Self-copy was not rejected'}
 New-Item -ItemType Directory -Path (Join-Path $source 'node_modules')|Out-Null
 $rejected=$false;try{Copy-HomeMCPDependencies $source $dest}catch{$rejected=$true};if(!$rejected){throw 'Corrupt source was accepted'}
 if(!(Test-Path (Join-Path $dest '@vendor\package\index.js'))){throw 'Rejecting corrupt source changed existing payload'}
 'DEPENDENCY_COPY_REGRESSION_OK'
}finally{Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}
